import assert from 'node:assert/strict';
import test from 'node:test';
import { audioCacheKey, audioRecord, audioRequestSchema, audioSlotId, authorizedAudioText, checkAudioQuota, createProviderAudio } from '../../src/server/audio';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import type { Profile, Question } from '../../src/lib/types';

const now='2026-10-23T00:00:00Z';
const student:Profile={id:'student',familyId:getFamilyId(),name:'Student',role:'student'};
const parent:Profile={...student,id:'parent',role:'parent'};
const questionId='f2af7295-1ea7-4c49-9ff4-1869f9db9c77';
const sessionId='1510983f-34c0-4e86-8de1-2e751749c152';
const requestToken='8af85cfc-fcd9-4e38-9c15-7026035f8bd7';
const question:Question={id:questionId,ownerId:student.id,topicId:'topic',prompt:'適切な答えを選びなさい。\nI have a book.',choices:['book','pen','a','I'],correctIndex:0,explanation:'SECRET_EXPLANATION',learningPoint:'SECRET_POINT',sourceIds:[],sourceNote:'PRIVATE_SOURCE',status:'published',version:1,createdAt:now,publishedAt:now};
const event=(id:string,type:StudyEvent['type'],payload:unknown,createdAt=now):StudyEvent=>({id,type,actorId:student.id,createdAt,payload});
function practice() {
  const events=[event('topic','topic.created',{id:'topic',title:'English',subject:'英語',description:'',targetCount:10,createdAt:now}),
    event('question','question.upserted',question),event('session','session.created',{id:sessionId,userId:student.id,mode:'daily',questionIds:[questionId],questionSnapshots:[question],createdAt:now})];
  return {events,data:foldEvents(events,[student,parent])};
}
const audioEvent=(id:string,characters=100,createdAt=now)=>event(id,'audio.requested',{cacheKey:audioCacheKey(id,'voice'),requestToken,characters},createdAt);

test('audio accepts only selectors and reads the authorized immutable snapshot, never answers or current edits',async()=>{
  const {data,events}=practice();
  data.questions[0]={...data.questions[0],prompt:'Edited since this session.'};
  assert.equal(await authorizedAudioText(data,events,student,{questionId,sessionId,part:'prompt'}),'I have a book.');
  assert.equal(await authorizedAudioText(data,events,student,{questionId,sessionId,part:'choice',choiceIndex:2}),'a');
  await assert.rejects(()=>authorizedAudioText(data,events,parent,{questionId,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
  for(const payload of [{questionId,sessionId,part:'prompt',text:'arbitrary'}, {questionId,sessionId,part:'explanation'}, {questionId,part:'choice',choiceIndex:-1}]) {
    assert.equal(audioRequestSchema.safeParse(payload).success,false);
  }
  assert.equal(await authorizedAudioText(data,events,student,{questionId,part:'prompt'}),'Edited since this session.');
  await assert.rejects(()=>authorizedAudioText(data,events,{...student,id:'another-student'},{questionId,sessionId,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
  await assert.rejects(()=>authorizedAudioText(data,events,{...student,familyId:'other-family'},{questionId,sessionId,part:'prompt'}),{code:'AUDIO_FORBIDDEN'});
});

test('audio bounds text and rejects non-English questions, private audiences and invalid choices',async()=>{
  const {data,events}=practice();
  await assert.rejects(()=>authorizedAudioText(data,events,student,{questionId,sessionId,part:'choice',choiceIndex:8}),{code:'AUDIO_EMPTY'});
  data.topics[0].subject='古文';
  await assert.rejects(()=>authorizedAudioText(data,events,student,{questionId,sessionId,part:'prompt'}),{code:'AUDIO_NOT_ENGLISH'});
  data.topics[0].subject='英語';
  events[2].payload.questionSnapshots[0]={...question,prompt:'long '.repeat(400)};
  await assert.rejects(()=>authorizedAudioText(data,events,student,{questionId,sessionId,part:'prompt'}),{code:'AUDIO_TEXT_TOO_LONG'});
  events[2].payload.questionSnapshots[0]={...question,ownerId:'another-student',audienceUserId:'another-student'};
  await assert.rejects(()=>authorizedAudioText(data,events,student,{questionId,sessionId,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
});

test('persistent quota counts reserved and failed clips on Japan dates, and ignores duplicate request rows',()=>{
  const japanMidnight=new Date('2026-10-22T15:01:00Z');
  const events=Array.from({length:30},(_,i)=>audioEvent(`r${i}`,100,'2026-10-22T15:00:00Z'));
  assert.throws(()=>checkAudioQuota(events,100,japanMidnight),{code:'AUDIO_LIMIT'});
  assert.doesNotThrow(()=>checkAudioQuota([events[0],events[0]],100,japanMidnight));
  assert.doesNotThrow(()=>checkAudioQuota(events.map(e=>({...e,createdAt:'2026-10-22T14:59:00Z'})),100,japanMidnight));
  assert.throws(()=>checkAudioQuota(Array.from({length:20},(_,i)=>audioEvent(`big${i}`,1500)),1,new Date(now)),{code:'AUDIO_LIMIT'});
  assert.throws(()=>checkAudioQuota(Array.from({length:300},(_,i)=>audioEvent(`month${i}`,10,'2026-10-01T00:00:00Z')),1,new Date(now)),{code:'AUDIO_LIMIT'});
});

test('cache identity follows spoken text and voice; claim slots are canonical and private cache events do not enter client state',()=>{
  const key=audioCacheKey('Read this.','voice');
  assert.notEqual(key,audioCacheKey('Read that.','voice'));
  assert.notEqual(key,audioCacheKey('Read this.','other-voice'));
  const request=event('slot','audio.requested',{cacheKey:key,requestToken,characters:10});
  const ready=event('ready','audio.ready',{cacheKey:key,requestToken,fileId:'private-audio-file'});
  assert.equal(audioSlotId([request]),audioSlotId([request,request]));
  assert.notEqual(audioSlotId([]),audioSlotId([request]));
  assert.equal(audioRecord([request,ready],key)?.fileId,'private-audio-file');
  assert.equal(audioRecord([request,{...ready,payload:{...ready.payload,requestToken:'other'}}],key)?.fileId,undefined);
  const failed=event('failed','audio.failed',{cacheKey:key,requestToken});
  assert.equal(audioRecord([request,failed],key)?.failed,true);
  assert.doesNotMatch(JSON.stringify(foldEvents([request,ready,failed])),/private-audio-file|cacheKey|requestToken/);
});

test('provider call is fixed to ElevenLabs and sends only English text; errors do not expose provider content or retry',async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async(input,init)=>{
      calls++;
      assert.equal(String(input),'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
      const body=JSON.parse(String(init?.body));
      assert.equal(body.text,'Hello.');assert.equal(body.language_code,'en');assert.equal(body.model_id,'eleven_flash_v2_5');
      assert.equal(init?.redirect,'error');
      return new Response(new Uint8Array([73,68,51]),{headers:{'Content-Type':'audio/mpeg'}});
    };
    assert.deepEqual(await createProviderAudio('Hello.','JBFqnCBsd6RMkjVDRZzb','TEST_KEY'),new Uint8Array([73,68,51]));
    globalThis.fetch=async()=>{calls++;return new Response('PRIVATE_PROVIDER_CONTENT TEST_KEY',{status:401});};
    await assert.rejects(()=>createProviderAudio('Hello.','JBFqnCBsd6RMkjVDRZzb','TEST_KEY'),error=>{
      assert.doesNotMatch(String(error),/PRIVATE_PROVIDER_CONTENT|TEST_KEY/);return true;
    });
    assert.equal(calls,2);
  } finally {globalThis.fetch=original;}
});
