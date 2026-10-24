import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Profile, Question, StudyData } from '@/lib/types';
import { englishChoiceSpeechText, englishSpeechText } from '@/lib/speech';
import { canAccessQuestion } from './access';
import { ApiError } from './config';
import { appendEvent, downloadAudioCache, getFullState, getSessionSnapshot, loadEvents, MAX_AUDIO_BYTES, saveAudioCache, type StudyEvent } from './google-store';
import { getWorkspaceId } from './env';
import { mayPracticeQuestion } from './practice-access';
import type { AudioSegment } from './audio-segments';

export const audioRequestSchema=z.discriminatedUnion('part',[
  z.object({questionId:z.string().uuid(),sessionId:z.string().uuid().optional(),part:z.literal('prompt')}).strict(),
  z.object({questionId:z.string().uuid(),sessionId:z.string().uuid().optional(),part:z.literal('choice'),choiceIndex:z.number().int().min(0).max(9)}).strict(),
]);
export type AudioRequest=z.infer<typeof audioRequestSchema>;
export const AUDIO_LIMITS={charactersPerClip:1500,clipsPerDay:30,clipsPerMonth:300,charactersPerDay:30000,charactersPerMonth:150000} as const;
const defaultVoice='JBFqnCBsd6RMkjVDRZzb';
const model='eleven_flash_v2_5';
const dateInJapan=(date:string|Date)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(date));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function audioConfigured():boolean {return !!process.env.ELEVENLABS_API_KEY?.trim();}

/** Never accepts text, answers, source material or arbitrary provider options from a browser. */
export async function authorizedAudioText(data:StudyData,events:StudyEvent[],profile:Profile,input:AudioRequest):Promise<string> {
  if(profile.workspaceId!==getWorkspaceId()) throw new ApiError(403,'この音声にはアクセスできません。','AUDIO_FORBIDDEN');
  let question:Question|undefined;
  if(input.sessionId) {
    const session=data.sessions.find(item=>item.id===input.sessionId && item.userId===profile.id);
    if(session?.questionIds.includes(input.questionId)) question=(await getSessionSnapshot(session.id,events)).find(item=>item.id===input.questionId);
  } else question=data.questions.find(item=>item.id===input.questionId);
  const topic=data.topics.find(topic=>topic.id===question?.topicId);
  if(!question || !topic || !canAccessQuestion(topic,profile) || !canAccessQuestion(question,profile)) throw new ApiError(404,'読み上げる問題が見つかりません。','AUDIO_QUESTION_NOT_FOUND');
  if(input.sessionId && !mayPracticeQuestion(data,profile,question)) throw new ApiError(404,'読み上げる問題が見つかりません。','AUDIO_QUESTION_NOT_FOUND');
  const subject=data.topics.find(topic=>topic.id===question.topicId)?.subject;
  if(subject!=='英語') throw new ApiError(400,'英語の問題で利用できます。','AUDIO_NOT_ENGLISH');
  const text=input.part==='prompt' ? englishSpeechText(question.prompt) : englishChoiceSpeechText(question.choices[input.choiceIndex] ?? '');
  if(!text) throw new ApiError(422,'読み上げる英文がありません。','AUDIO_EMPTY');
  if(text.length>AUDIO_LIMITS.charactersPerClip) throw new ApiError(413,'この英文は端末の音声で読み上げます。','AUDIO_TEXT_TOO_LONG');
  return text;
}

function requests(events:StudyEvent[]) {
  const seen=new Set<string>();
  return events.filter(event=>{if(seen.has(event.id)) return false;seen.add(event.id);return event.type==='audio.requested';});
}
export function audioSlotId(events:StudyEvent[]):string {return `audio-slot:${hash(requests(events).map(event=>event.id).sort())}`;}
export function checkAudioQuota(events:StudyEvent[],characters:number,now=new Date()):void {
  const today=dateInJapan(now);
  const current=requests(events);
  const daily=current.filter(event=>dateInJapan(event.createdAt)===today);
  const monthly=current.filter(event=>dateInJapan(event.createdAt).slice(0,7)===today.slice(0,7));
  const sum=(items:StudyEvent[])=>items.reduce((total,event)=>total+event.payload.characters,0);
  if(daily.length>=AUDIO_LIMITS.clipsPerDay || sum(daily)+characters>AUDIO_LIMITS.charactersPerDay
    || monthly.length>=AUDIO_LIMITS.clipsPerMonth || sum(monthly)+characters>AUDIO_LIMITS.charactersPerMonth) {
    throw new ApiError(429,'AI音声の利用上限に達しました。端末の音声で再生できます。','AUDIO_LIMIT');
  }
}

export function audioCacheKey(text:string,voiceId:string):string {return hash(['english-v1',model,voiceId,text]);}
export function audioRecord(events:StudyEvent[],cacheKey:string) {
  const request=requests(events).find(event=>event.payload.cacheKey===cacheKey);
  if(!request) return undefined;
  const ready=events.find(event=>event.type==='audio.ready' && event.payload.cacheKey===cacheKey && event.payload.requestToken===request.payload.requestToken);
  const failed=events.find(event=>event.type==='audio.failed' && event.payload.cacheKey===cacheKey && event.payload.requestToken===request.payload.requestToken);
  return {request,fileId:ready?.payload.fileId as string|undefined,segments:ready?.payload.segments as AudioSegment[]|undefined,failed:!!failed};
}

/** Official API: https://elevenlabs.io/docs/api-reference/text-to-speech/convert . No automatic paid retries. */
export async function createProviderAudio(text:string,voiceId:string,key:string):Promise<Uint8Array> {
  if(!/^[a-zA-Z0-9_-]{10,100}$/.test(voiceId) || !text || text.length>AUDIO_LIMITS.charactersPerClip) throw new ApiError(503,'音声の設定を確認してください。','AUDIO_UNAVAILABLE');
  let response:Response;
  try {
    response=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,{
      method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json',Accept:'audio/mpeg'},
      body:JSON.stringify({text,model_id:model,language_code:'en',voice_settings:{stability:0.6,similarity_boost:0.75,speed:1}}),
      signal:AbortSignal.timeout(45000),redirect:'error',cache:'no-store',
    });
  } catch {throw new ApiError(503,'AI音声に接続できません。端末の音声で再生できます。','AUDIO_UNAVAILABLE');}
  if(!response.ok || !(response.headers.get('content-type') || '').includes('audio/') || !response.body) {
    await response.body?.cancel();
    throw new ApiError(503,'AI音声を作れませんでした。端末の音声で再生できます。','AUDIO_UNAVAILABLE');
  }
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) {
      const next=await reader.read();if(next.done) break;
      size+=next.value.byteLength;
      if(size>MAX_AUDIO_BYTES) {await reader.cancel();throw new ApiError(413,'音声が長すぎます。','AUDIO_TOO_LARGE');}
      chunks.push(next.value);
    }
  } catch(error) {if(error instanceof ApiError) throw error;throw new ApiError(503,'音声の受信が中断されました。','AUDIO_UNAVAILABLE');}
  if(!size) throw new ApiError(503,'音声を受信できませんでした。','AUDIO_UNAVAILABLE');
  return new Uint8Array(Buffer.concat(chunks));
}

export async function questionAudio(profile:Profile,input:AudioRequest):Promise<Uint8Array> {
  if(!audioConfigured()) throw new ApiError(503,'端末の音声で再生できます。','AUDIO_NOT_CONFIGURED');
  const {data,events}=await getFullState();
  const text=await authorizedAudioText(data,events,profile,input);
  const voiceId=process.env.ELEVENLABS_VOICE_ID?.trim() || defaultVoice;
  const cacheKey=audioCacheKey(text,voiceId);
  const previous=audioRecord(events,cacheKey);
  if(previous?.fileId) return downloadAudioCache(previous.fileId,cacheKey);
  if(previous) throw new ApiError(previous.failed ? 503 : 409,'この部分は端末の音声で再生できます。',previous.failed ? 'AUDIO_UNAVAILABLE' : 'AUDIO_PENDING');
  checkAudioQuota(events,text.length);
  const slotId=audioSlotId(events);const requestToken=randomUUID();const now=new Date().toISOString();
  await appendEvent({id:slotId,type:'audio.requested',actorId:profile.id,createdAt:now,payload:{cacheKey,requestToken,characters:text.length}});
  const canonical=await loadEvents();
  if(canonical.find(event=>event.id===slotId)?.payload.requestToken!==requestToken) {
    throw new ApiError(409,'別の音声を準備しています。端末の音声で再生できます。','AUDIO_PENDING');
  }
  try {
    const bytes=await createProviderAudio(text,voiceId,process.env.ELEVENLABS_API_KEY!.trim());
    const fileId=await saveAudioCache(cacheKey,bytes);
    await appendEvent({id:`audio-ready:${cacheKey}`,type:'audio.ready',actorId:profile.id,createdAt:new Date().toISOString(),payload:{cacheKey,requestToken,fileId}});
    return bytes;
  } catch(error) {
    try {await appendEvent({id:`audio-failed:${cacheKey}`,type:'audio.failed',actorId:profile.id,createdAt:new Date().toISOString(),payload:{cacheKey,requestToken}});} catch { /* Keep the reservation: an uncertain paid request must not be retried. */ }
    if(error instanceof ApiError) throw error;
    throw new ApiError(503,'AI音声を作れませんでした。端末の音声で再生できます。','AUDIO_UNAVAILABLE');
  }
}
