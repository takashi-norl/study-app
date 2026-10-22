import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { start } from 'workflow/api';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState,getDriveFileMetadata } from '@/server/google-store';
import { ApiError,MAX_SOURCE_BYTES,requireGenerationEnabled } from '@/server/config';
import { generationWorkflow } from '@/workflows/generate';
import type { GenerationJob } from '@/lib/types';
export const maxDuration=300;
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile('parent');
  const input=await readJson(request,z.object({topicId:z.string().uuid(),sourceIds:z.array(z.string().uuid()).min(1).max(20),targetCount:z.number().int().min(1).max(300)}));
  requireGenerationEnabled();
  const {data}=await getFullState();
  if(!data.topics.some(t=>t.id===input.topicId)) throw new ApiError(404,'問題集が見つかりません。');
  if(data.jobs.some(j=>j.status==='queued' || j.status==='running')) throw new ApiError(409,'現在の作問が終わるまでお待ちください。','GENERATION_ACTIVE');
  const now=new Date();
  const japanDate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
  const jobDay=(date:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(date));
  const limit=(name:string,fallback:number)=>Math.max(1,Math.min(100,Number.parseInt(process.env[name] || String(fallback),10) || fallback));
  if(data.jobs.filter(j=>jobDay(j.createdAt)===japanDate).length>=limit('GENERATION_DAILY_JOB_LIMIT',3)) throw new ApiError(429,'本日の作問回数の上限に達しました。','DAILY_BUDGET_LIMIT');
  if(data.jobs.filter(j=>jobDay(j.createdAt).slice(0,7)===japanDate.slice(0,7)).length>=limit('GENERATION_MONTHLY_JOB_LIMIT',10)) throw new ApiError(429,'今月の作問回数の上限に達しました。','MONTHLY_BUDGET_LIMIT');
  const sourceIds=[...new Set(input.sourceIds)];
  for(const id of sourceIds) {
    const source=data.sources.find(s=>s.id===id && s.topicId===input.topicId);
    if(!source?.storagePath) throw new ApiError(404,'選択した資料が見つかりません。');
    const metadata=await getDriveFileMetadata(source.storagePath);
    if(metadata.mimeType!==source.mimeType || Number(metadata.size)<=0 || Number(metadata.size)>MAX_SOURCE_BYTES) throw new ApiError(422,'資料のアップロード完了を確認できません。写真・PDFを再度アップロードしてください。');
  }
  const job:GenerationJob={id:randomUUID(),topicId:input.topicId,status:'queued',targetCount:input.targetCount,generatedCount:0,createdAt:now.toISOString()};
  // Two concurrent requests observing the same history compete for the same event ID.
  // The event store uses first-row-wins, preventing two paid jobs from taking this slot.
  const prior=data.jobs.map(j=>j.id).sort().join(':');
  const slotId=`generation-slot:${data.jobs.length}:${createHash('sha256').update(prior).digest('hex')}`;
  await appendEvent({id:slotId,type:'job.upserted',actorId:profile.id,createdAt:job.createdAt,payload:{...job,sourceIds,requestedBy:profile.id}});
  const canonical=(await getFullState()).events.find(e=>e.id===slotId)?.payload as GenerationJob|undefined;
  if(canonical?.id!==job.id) throw new ApiError(409,'別の作問依頼を先に受け付けました。画面を更新してください。','GENERATION_ACTIVE');
  try { await start(generationWorkflow,[job.id]); }
  catch {
    await appendEvent({id:`job:${job.id}:dispatch-failed`,type:'job.upserted',actorId:profile.id,createdAt:new Date().toISOString(),payload:{...job,status:'failed',error:'バックグラウンド処理を開始できませんでした。VercelのWorkflow設定をご確認ください。'}});
    throw new ApiError(503,'作問処理を開始できませんでした。設定を確認してください。','WORKFLOW_UNAVAILABLE');
  }
  return {job};
},202); }
