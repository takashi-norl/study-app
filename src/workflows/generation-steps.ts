import { randomUUID } from 'node:crypto';
import { FatalError } from 'workflow';
import type { GenerationJob,Question } from '@/lib/types';
import { appendEvent,getFullState,getDriveFileMetadata,downloadSourceFile } from '@/server/google-store';
import { analyzeDocument,generateQuestions,safeGenerationError } from '@/server/generation';
import { ApiError,MAX_SOURCE_BYTES,requireGenerationEnabled } from '@/server/config';
import { countForBatch,groupSources,plannedBatchCount,promptBudget } from '@/server/generation-plan';

type JobInput=GenerationJob & {sourceIds:string[];requestedBy:string};
function inputFromEvents(jobId:string,events:Awaited<ReturnType<typeof getFullState>>['events']):JobInput {
  const event=events.find(e=>e.type==='job.upserted' && (e.payload as JobInput).id===jobId && Array.isArray((e.payload as JobInput).sourceIds));
  if(!event) throw new FatalError('作問依頼が見つかりません。');
  return event.payload as JobInput;
}

function sourcesFromState(input:JobInput,data:Awaited<ReturnType<typeof getFullState>>['data'],events:Awaited<ReturnType<typeof getFullState>>['events']) {
  return input.sourceIds.map(id=>{
    const source=data.sources.find(s=>s.id===id);
    const analysis=events.find(e=>e.id===`source-analysis:${id}`)?.payload as {text:string}|undefined;
    if(!source || !analysis) throw new ApiError(422,'資料の読み取りがまだ完了していません。');
    return {id,name:source.name,text:analysis.text};
  });
}

export async function planBatches(jobId:string) {
  'use step';
  const {data,events}=await getFullState();
  const input=inputFromEvents(jobId,events);
  const groups=groupSources(sourcesFromState(input,data,events));
  return {batchCount:plannedBatchCount(input.targetCount,groups.length)};
}
planBatches.maxRetries=1;

export async function beginGeneration(jobId:string) {
  'use step';
  try { requireGenerationEnabled(); } catch(error) { throw new FatalError(safeGenerationError(error)); }
  const {data,events}=await getFullState();
  const job=inputFromEvents(jobId,events);
  const current=data.jobs.find(j=>j.id===jobId);
  if(!current || current.status==='failed') throw new FatalError('作問依頼が終了しています。');
  if(current.status!=='review') await appendEvent({id:`job:${jobId}:running`,type:'job.upserted',actorId:job.requestedBy,createdAt:new Date().toISOString(),payload:{...current,status:'running'}});
  return {sourceIds:job.sourceIds,targetCount:job.targetCount,done:current.status==='review'};
}
beginGeneration.maxRetries=1;

export async function analyzeSource(jobId:string,sourceId:string) {
  'use step';
  const {data,events}=await getFullState();
  if(events.some(e=>e.id===`source-analysis:${sourceId}`)) return;
  const input=inputFromEvents(jobId,events);
  const source=data.sources.find(s=>s.id===sourceId && s.topicId===input.topicId);
  if(!source?.storagePath || !input.sourceIds.includes(sourceId)) throw new FatalError('資料が見つかりません。');
  try {
    requireGenerationEnabled();
    const metadata=await getDriveFileMetadata(source.storagePath);
    if(metadata.mimeType!==source.mimeType || Number(metadata.size)<=0 || Number(metadata.size)>MAX_SOURCE_BYTES) throw new ApiError(422,'資料のアップロードが完了していないか、形式・容量が対応していません。');
    const file=await downloadSourceFile(source.storagePath);
    const analysis=await analyzeDocument(file.bytes,file.mimeType,source.name);
    const text=JSON.stringify(analysis);
    await appendEvent({id:`source-analysis:${sourceId}`,type:'source.analysis',actorId:input.requestedBy,createdAt:new Date().toISOString(),payload:{sourceId,text}});
  } catch(error) { throw new FatalError(safeGenerationError(error)); }
}
// Retrying a paid provider call can spend twice after an uncertain network failure.
// A failed paid step is visible to the parent; explicit later jobs reuse cached analyses.
analyzeSource.maxRetries=0;

export async function generateBatch(jobId:string,batch:number,totalBatches:number) {
  'use step';
  const {data,events}=await getFullState();
  const existingEvent=events.find(e=>e.id===`generation:${jobId}:batch:${batch}`);
  if(existingEvent) return {generatedCount:(existingEvent.payload as {job:GenerationJob}).job.generatedCount,added:(existingEvent.payload as {questions:Question[]}).questions.length};
  const input=inputFromEvents(jobId,events);
  const job=data.jobs.find(j=>j.id===jobId);
  const topic=data.topics.find(t=>t.id===input.topicId);
  if(!job || !topic) throw new FatalError('作問対象の問題集が見つかりません。');
  const remaining=input.targetCount-job.generatedCount;
  if(remaining<=0) return {generatedCount:job.generatedCount,added:0};
  try {
    requireGenerationEnabled();
    const groups=groupSources(sourcesFromState(input,data,events));
    const sources=groups[batch%groups.length];
    if(!sources?.length) throw new ApiError(422,'読み取れた資料がありません。');
    const prior=data.questions.filter(q=>q.topicId===topic.id);
    const sourceIds=new Set(sources.map(s=>s.id));
    const desiredCount=countForBatch(remaining,batch,totalBatches);
    const result=await generateQuestions({title:topic.title,subject:topic.subject,count:desiredCount,sources,existing:promptBudget(prior.filter(q=>q.sourceIds.some(id=>sourceIds.has(id))).map(q=>q.prompt))});
    const normalize=(text:string)=>text.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    const seen=new Set(prior.map(q=>normalize(q.prompt)));
    const questions:Question[]=[];
    const now=new Date().toISOString();
    for(const q of result.questions) {
      if(questions.length>=desiredCount || seen.has(normalize(q.prompt)) || q.sourceIds.some(id=>!sourceIds.has(id))) continue;
      seen.add(normalize(q.prompt));
      // Human confirmation is mandatory for every AI question, even when the model claims certainty.
      questions.push({...q,id:randomUUID(),topicId:topic.id,status:'draft',needsReview:true,version:1,createdAt:now});
    }
    const updated:GenerationJob={...job,status:'running',generatedCount:job.generatedCount+questions.length};
    await appendEvent({id:`generation:${jobId}:batch:${batch}`,type:'generation.batch',actorId:input.requestedBy,createdAt:now,payload:{jobId,batch,questions,job:updated}});
    return {generatedCount:updated.generatedCount,added:questions.length};
  } catch(error) { throw new FatalError(safeGenerationError(error)); }
}
generateBatch.maxRetries=0;

export async function finishGeneration(jobId:string) {
  'use step';
  const {data,events}=await getFullState();
  const input=inputFromEvents(jobId,events);
  const job=data.jobs.find(j=>j.id===jobId);
  if(!job) throw new FatalError('作問依頼が見つかりません。');
  const error=job.generatedCount<input.targetCount ? `資料の範囲と重複を考慮して${job.generatedCount}問を作成しました（目標${input.targetCount}問）。必要に応じて資料を追加してください。` : undefined;
  await appendEvent({id:`job:${jobId}:finished`,type:'job.upserted',actorId:input.requestedBy,createdAt:new Date().toISOString(),payload:{...job,status:job.generatedCount ? 'review' : 'failed',error}});
}
finishGeneration.maxRetries=2;

export async function failGeneration(jobId:string,message:string) {
  'use step';
  const {data,events}=await getFullState();
  const job=data.jobs.find(j=>j.id===jobId);
  if(!job) return;
  const input=inputFromEvents(jobId,events);
  await appendEvent({id:`job:${jobId}:failed`,type:'job.upserted',actorId:input.requestedBy,createdAt:new Date().toISOString(),payload:{...job,status:'failed',error:message.slice(0,500)}});
}
failGeneration.maxRetries=2;
