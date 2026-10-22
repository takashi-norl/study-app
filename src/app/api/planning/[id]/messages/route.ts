import { z } from 'zod';
import { start } from 'workflow/api';
import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { appendEvent, getFullState } from '@/server/google-store';
import { ApiError, requireGenerationEnabled } from '@/server/config';
import { checkPlanningRequest, paidWorkSlotId, planningMessageSchema } from '@/server/planning';
import { planningWorkflow } from '@/workflows/planning';
import { planningProgress } from '@/server/planning-progress';
import { inspectPlanningRun } from '@/server/planning-status';
import type { PlanningTurn } from '@/lib/types';

export const maxDuration=300;
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {return api(async()=>{
  const {profile}=await requireProfile();
  const id=z.string().uuid().parse((await context.params).id);
  const input=await readJson(request,planningMessageSchema);
  const {data,events}=await getFullState();
  const {plan,previous}=checkPlanningRequest(data,profile,id,input);
  if(previous) {
    const inspected=await inspectPlanningRun(previous);
    // Only an explicit queued request without an active run can be dispatched again.
    // A running/unknown result is never repeated; the hook also handles dispatch races.
    if(inspected.shouldDispatch) {
      requireGenerationEnabled();
      try {await start(planningWorkflow,[previous.id]);}
      catch {throw new ApiError(503,'AI相談の開始を確認できませんでした。同じ内容で再度送信してください。','WORKFLOW_UNAVAILABLE');}
    }
    return {planId:plan.id,turn:inspected.turn,notice:inspected.shouldDispatch?'保存済みの相談を受け付けました。進み具合は画面に表示されます。':inspected.notice};
  }
  requireGenerationEnabled();
  const now=new Date();
  const turn:PlanningTurn=planningProgress({id:input.requestId,planId:plan.id,requestedBy:profile.id,version:plan.version+1,status:'queued',message:input.message,createdAt:now.toISOString()},plan.sourceIds,events,'queued',now);
  const slotId=paidWorkSlotId(data);
  await appendEvent({id:slotId,type:'planning.turn.upserted',actorId:profile.id,createdAt:turn.createdAt,payload:turn});
  const canonical=await getFullState();
  const winner=canonical.events.find(event=>event.id===slotId);
  if(winner?.type!=='planning.turn.upserted' || winner.payload.id!==turn.id || !canonical.data.planningTurns.some(item=>item.id===turn.id)) {
    throw new ApiError(409,'別のAI依頼を先に受け付けました。画面を更新してください。','AI_WORK_ACTIVE');
  }
  const stored=canonical.data.planningTurns.find(item=>item.id===turn.id)!;
  if(stored.planId!==turn.planId || stored.requestedBy!==turn.requestedBy || stored.version!==turn.version || stored.message!==turn.message) {
    throw new ApiError(409,'同じ送信番号で別の相談を受け付けました。画面を更新してください。','REQUEST_CONFLICT');
  }
  try {await start(planningWorkflow,[turn.id]);}
  catch {
    // Dispatch may have succeeded despite a lost response. Keep its reservation so
    // an explicit retry resumes the same hook instead of permitting parallel paid work.
    throw new ApiError(503,'AI相談の開始を確認できませんでした。同じ内容で再試行するか「再開」を押してください。','WORKFLOW_UNAVAILABLE');
  }
  return {planId:plan.id,turn};
},202);}
