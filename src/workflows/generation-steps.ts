import { FatalError } from 'workflow';
import type { GenerationJob,Question } from '@/lib/types';
import { appendEvent,getFullState,getDriveFileMetadata,downloadSourceFile } from '@/server/google-store';
import { analyzeDocument,generateQuestions,safeGenerationError,assertGenerationCallNotSent } from '@/server/generation';
import { ApiError,MAX_SOURCE_BYTES,requireGenerationEnabled } from '@/server/config';
import { canAccessSource } from '@/server/access';
import { materializeQuestions } from '@/server/generated-batch';
import { assertGenerationAccess } from '@/server/proposal-selection';
import { countForBatch,groupSources,plannedBatchCount,promptBudget } from '@/server/generation-plan';
import { latestSourceAnalysis, assertSourceAnalysesCurrent } from '@/server/source-analysis';

type JobInput=GenerationJob & {sourceIds:string[];requestedBy:string};
function inputFromEvents(jobId:string,events:Awaited<ReturnType<typeof getFullState>>['events']):JobInput {
  const event=events.find(e=>(e.type==='job.upserted' && e.payload.id===jobId && Array.isArray(e.payload.sourceIds)) || (e.type==='generation.requested' && e.payload.job.id===jobId));
  if(!event) throw new FatalError('作問依頼が見つかりません。');
  return (event.type==='generation.requested' ? event.payload.job : event.payload) as JobInput;
}

function sourcesFromState(input:JobInput,data:Awaited<ReturnType<typeof getFullState>>['data'],events:Awaited<ReturnType<typeof getFullState>>['events']) {
  const turn=data.planningTurns.find(turn=>turn.id===input.turnId && turn.planId===input.planId);
  assertSourceAnalysesCurrent(events,input.sourceIds,turn?.createdAt ?? input.createdAt);
  return input.sourceIds.map(id=>{
    const source=data.sources.find(s=>s.id===id);
    const analysis=latestSourceAnalysis(events,id)?.payload as {text:string}|undefined;
    if(!source || !analysis) throw new ApiError(422,'資料の読み取りがまだ完了していません。');
    return {id,name:source.name,text:analysis.text};
  });
}

export async function planBatches(jobId:string) {
  'use step';
  const {data,events}=await getFullState();
  const input=inputFromEvents(jobId,events);
  assertGenerationAccess(data,input);
  const groups=groupSources(sourcesFromState(input,data,events));
  const remaining=Math.max(0,input.targetCount-(data.jobs.find(job=>job.id===jobId)?.generatedCount ?? 0));
  return {batchCount:plannedBatchCount(remaining,groups.length)};
}
planBatches.maxRetries=1;

export async function beginGeneration(jobId:string) {
  'use step';
  try { requireGenerationEnabled(); } catch(error) { throw new FatalError(safeGenerationError(error)); }
  const {data,events}=await getFullState();
  const job=inputFromEvents(jobId,events);
  const current=data.jobs.find(j=>j.id===jobId);
  if(!current || current.status==='failed') throw new FatalError('作問依頼が終了しています。');
  if(current.status==='review') return {sourceIds:job.sourceIds,targetCount:job.targetCount,done:true};
  assertGenerationAccess(data,job);
  await appendEvent({id:`job:${jobId}:running`,type:'job.upserted',actorId:job.requestedBy,createdAt:new Date().toISOString(),payload:{...current,status:'running'}});
  return {sourceIds:job.sourceIds,targetCount:job.targetCount,done:false};
}
beginGeneration.maxRetries=1;

export async function analyzeSource(jobId:string,sourceId:string) {
  'use step';
  const {data,events}=await getFullState();
  const input=inputFromEvents(jobId,events);
  const requester=assertGenerationAccess(data,input);
  const source=data.sources.find(s=>s.id===sourceId && requester && canAccessSource(s,requester));
  if(!source?.storagePath || !input.sourceIds.includes(sourceId)) throw new FatalError('資料が見つかりません。');
  if(data.jobs.find(job=>job.id===jobId)?.status==='failed') throw new FatalError('作問依頼が終了しています。');
  if(latestSourceAnalysis(events,sourceId)) return;
  try {
    requireGenerationEnabled();
    assertGenerationCallNotSent(events,{actorId:input.requestedBy,feature:'source-analysis',requestId:`generation:${jobId}:source:${sourceId}`});
    const metadata=await getDriveFileMetadata(source.storagePath);
    if(metadata.appProperties?.sourceId!==source.id || metadata.mimeType!==source.mimeType || Number(metadata.size)<=0 || Number(metadata.size)>MAX_SOURCE_BYTES) throw new ApiError(422,'資料のアップロードが完了していないか、形式・容量が対応していません。');
    const file=await downloadSourceFile(source.storagePath);
    const analysis=await analyzeDocument(file.bytes,file.mimeType,source.name,{actorId:input.requestedBy,feature:'source-analysis',requestId:`generation:${jobId}:source:${sourceId}`});
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
  if(job.status==='failed' || job.status==='review') throw new FatalError('作問依頼が終了しています。');
  assertGenerationAccess(data,input);
  const remaining=input.targetCount-job.generatedCount;
  if(remaining<=0) return {generatedCount:job.generatedCount,added:0};
  try {
    requireGenerationEnabled();
    assertGenerationCallNotSent(events,{actorId:input.requestedBy,feature:'question-generation',requestId:`generation:${jobId}:batch:${batch}`});
    const groups=groupSources(sourcesFromState(input,data,events));
    const sources=groups.length ? groups[batch%groups.length] : [];
    if(input.sourceIds.length && !sources.length) throw new ApiError(422,'読み取れた資料がありません。');
    if(!sources.length && (!input.planId || !input.instructions)) throw new ApiError(422,'作問する内容を学習相談で決めてください。');
    const prior=data.questions.filter(q=>q.topicId===topic.id);
    const sourceIds=new Set(sources.map(s=>s.id));
    const desiredCount=countForBatch(remaining,batch,totalBatches);
    const result=await generateQuestions({title:topic.title,subject:topic.subject,count:desiredCount,sources,instructions:input.instructions,approvedSamples:input.approvedSamples,approvedInstructions:input.approvedInstructions,existing:promptBudget([...(input.approvedSamples?.map(sample=>sample.prompt) ?? []),...prior.filter(q=>!sources.length || q.sourceIds.some(id=>sourceIds.has(id))).map(q=>q.prompt)])},{actorId:input.requestedBy,feature:'question-generation',requestId:`generation:${jobId}:batch:${batch}`});
    const now=new Date().toISOString();
    const questions=materializeQuestions(result.questions,{job:input,sourceIds:[...sourceIds],prior,excludedPrompts:input.approvedSamples?.map(sample=>sample.prompt),count:desiredCount,createdAt:now});
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
  if(job.status==='review' || job.status==='failed') return;
  const error=job.generatedCount<input.targetCount ? input.sourceIds.length
    ? `資料の範囲と重複を考慮して${job.generatedCount}問を作成しました（目標${input.targetCount}問）。必要に応じて資料を追加してください。`
    : `内容の正確さと重複を考慮して${job.generatedCount}問を作成しました（目標${input.targetCount}問）。範囲や難易度を相談して追加できます。` : undefined;
  await appendEvent({id:`job:${jobId}:finished`,type:'job.upserted',actorId:input.requestedBy,createdAt:new Date().toISOString(),payload:{...job,status:job.generatedCount ? 'review' : 'failed',error}});
}
finishGeneration.maxRetries=2;

export async function failGeneration(jobId:string,message:string) {
  'use step';
  const {data,events}=await getFullState();
  const job=data.jobs.find(j=>j.id===jobId);
  if(!job || job.status==='review' || job.status==='failed') return;
  const input=inputFromEvents(jobId,events);
  await appendEvent({id:`job:${jobId}:failed`,type:'job.upserted',actorId:input.requestedBy,createdAt:new Date().toISOString(),payload:{...job,status:'failed',error:message.slice(0,500)}});
}
failGeneration.maxRetries=2;
