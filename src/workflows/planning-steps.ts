import { FatalError } from 'workflow';
import { appendEvent, downloadSourceFile, getDriveFileMetadata, getFullState } from '@/server/google-store';
import { ApiError, MAX_SOURCE_BYTES, requireGenerationEnabled } from '@/server/config';
import { analyzeDocument, safeGenerationError } from '@/server/generation';
import { buildPlanningContext, requestPlanningReply, requireOwnedPlan, validatePlanningSources } from '@/server/planning';

function planningInput(state:Awaited<ReturnType<typeof getFullState>>,turnId:string) {
  const turn=state.data.planningTurns.find(item=>item.id===turnId);
  const profile=state.data.profiles.find(item=>item.id===turn?.requestedBy);
  if(!turn || !profile) throw new ApiError(404,'AI相談の依頼が見つからないか、利用者の権限が変更されました。','PLAN_NOT_FOUND');
  const plan=requireOwnedPlan(state.data,profile,turn.planId);
  if(plan.version!==turn.version) throw new ApiError(409,'新しい相談が作成されているため、この処理を中止しました。','STALE_PLAN');
  validatePlanningSources(state.data,profile,plan.sourceIds);
  return {turn,profile,plan};
}

export async function beginPlanning(turnId:string) {
  'use step';
  try {
    requireGenerationEnabled();
    const state=await getFullState();
    const {turn,plan}=planningInput(state,turnId);
    if(turn.status==='complete' || turn.status==='failed') return {done:true,sourceIds:[] as string[]};
    await appendEvent({id:`planning:${turn.id}:running`,type:'planning.turn.upserted',actorId:turn.requestedBy,createdAt:new Date().toISOString(),payload:{...turn,status:'running'}});
    return {done:false,sourceIds:plan.sourceIds};
  } catch(error) {throw new FatalError(safeGenerationError(error));}
}
beginPlanning.maxRetries=1;

export async function analyzePlanningSource(turnId:string,sourceId:string) {
  'use step';
  try {
    const state=await getFullState();
    const {turn,plan}=planningInput(state,turnId);
    if(!plan.sourceIds.includes(sourceId)) throw new ApiError(404,'選択した資料が見つかりません。');
    if(state.events.some(event=>event.id===`source-analysis:${sourceId}` && event.type==='source.analysis')) return;
    requireGenerationEnabled();
    const source=state.data.sources.find(item=>item.id===sourceId);
    if(!source?.storagePath) throw new ApiError(404,'選択した資料が見つかりません。');
    const metadata=await getDriveFileMetadata(source.storagePath);
    if(metadata.mimeType!==source.mimeType || Number(metadata.size)<=0 || Number(metadata.size)>MAX_SOURCE_BYTES) throw new ApiError(422,'資料のアップロード完了を確認できません。写真・PDFを再度アップロードしてください。');
    const file=await downloadSourceFile(source.storagePath);
    const analysis=await analyzeDocument(file.bytes,file.mimeType,source.name);
    await appendEvent({id:`source-analysis:${sourceId}`,type:'source.analysis',actorId:turn.requestedBy,createdAt:new Date().toISOString(),payload:{sourceId,text:JSON.stringify(analysis)}});
  } catch(error) {throw new FatalError(safeGenerationError(error));}
}
// An uncertain paid request is not retried automatically. Later explicit turns reuse saved analyses.
analyzePlanningSource.maxRetries=0;

export async function completePlanning(turnId:string) {
  'use step';
  try {
    const state=await getFullState();
    const {turn,plan,profile}=planningInput(state,turnId);
    if(turn.status==='complete' || turn.status==='failed') return;
    const context=buildPlanningContext(state.data,state.events,plan,turn,profile);
    const reply=await requestPlanningReply(context,plan,turn.id);
    const now=new Date().toISOString();
    await appendEvent({id:`planning:${turn.id}:complete`,type:'planning.turn.upserted',actorId:turn.requestedBy,createdAt:now,payload:{...turn,...reply,status:'complete',completedAt:now}});
  } catch(error) {throw new FatalError(safeGenerationError(error));}
}
completePlanning.maxRetries=0;

export async function failPlanning(turnId:string,message:string) {
  'use step';
  const {data}=await getFullState();
  const turn=data.planningTurns.find(item=>item.id===turnId);
  if(!turn || turn.status==='complete' || turn.status==='failed') return;
  const now=new Date().toISOString();
  await appendEvent({id:`planning:${turn.id}:failed`,type:'planning.turn.upserted',actorId:turn.requestedBy,createdAt:now,payload:{...turn,status:'failed',completedAt:now,error:message.slice(0,500)}});
}
failPlanning.maxRetries=2;
