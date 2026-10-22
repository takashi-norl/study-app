import 'server-only';
import { getHookByToken, getRun } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import type { PlanningTurn, StudyData } from '@/lib/types';
import { appendEvent, getFullState, type StudyEvent } from './google-store';
import { ApiError } from './config';
import { planningProgress } from './planning-progress';

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface PlanningStatusDependencies {
  findRunId: (turn: PlanningTurn) => Promise<string | undefined>;
  status: (runId: string) => Promise<RunStatus>;
  load: () => Promise<{ data: StudyData; events: StudyEvent[] }>;
  append: (event: StudyEvent) => Promise<void>;
  now: () => Date;
}
const defaults: PlanningStatusDependencies = {
  async findRunId(turn) {
    if (turn.workflowRunId) return turn.workflowRunId;
    try { return (await getHookByToken(`study-planning:${turn.id}`)).runId; }
    catch (error) { if (HookNotFoundError.is(error)) return undefined; throw error; }
  },
  status: async runId => getRun(runId).status,
  load: getFullState, append: appendEvent, now: () => new Date(),
};

/** Called only after the route verifies ownership. Inspection never repeats a provider call. */
export async function inspectPlanningRun(turn: PlanningTurn, deps: PlanningStatusDependencies = defaults): Promise<{
  turn: PlanningTurn; shouldDispatch: boolean; notice: string;
}> {
  if (turn.status === 'complete' || turn.status === 'failed') return {
    turn, shouldDispatch: false, notice: turn.status === 'complete' ? '提案は保存されています。' : 'この相談は終了しています。内容を確認して、新しい相談を送れます。',
  };
  let runId: string | undefined;
  let status: RunStatus;
  try {
    runId = await deps.findRunId(turn);
    if (!runId) return turn.status === 'queued'
      ? { turn, shouldDispatch: true, notice: '保存済みの相談の開始を確認します。' }
      : { turn, shouldDispatch: false, notice: 'この相談の実行状態を確認できませんでした。重複したAI依頼は送っていません。時間を置いて状況を確認してください。' };
    status = await deps.status(runId);
  } catch {
    throw new ApiError(503, '実行状況の確認に接続できませんでした。処理を止めたり、AI依頼を送り直したりしていません。', 'PLANNING_STATUS_UNAVAILABLE');
  }
  // The original workflow may have saved its result while the status lookup was in flight.
  const state = await deps.load();
  const current = state.data.planningTurns.find(item => item.id === turn.id);
  if (!current) throw new ApiError(404, '相談の記録が見つかりません。', 'PLAN_NOT_FOUND');
  if (current.status === 'complete' || current.status === 'failed') return {
    turn: current, shouldDispatch: false, notice: current.status === 'complete' ? '提案は保存されています。' : 'この相談は終了しています。内容を確認して、新しい相談を送れます。',
  };
  if (status === 'pending' || status === 'running') {
    if (!current.workflowRunId) {
      const linked = { ...current, workflowRunId: runId };
      // Linking an old run is not progress: do not update its progress timestamp.
      await deps.append({ id: `planning:${current.id}:run-link`, type: 'planning.turn.upserted', actorId: current.requestedBy, createdAt: deps.now().toISOString(), payload: linked });
    }
    return { turn: { ...current, workflowRunId: runId }, shouldDispatch: false,
      notice: status === 'pending' ? '相談は実行待ちです。同じ依頼を重ねて送っていません。' : '処理は続いています。同じ依頼を重ねて送っていません。' };
  }
  // Only an authoritative terminal run status can release this reservation. Age alone cannot.
  const now = deps.now();
  const sourceIds = state.data.plans.find(plan => plan.id === current.planId)?.sourceIds ?? [];
  const failed = { ...planningProgress(current, sourceIds, state.events, 'failed', now), status: 'failed' as const,
    workflowRunId: runId, completedAt: now.toISOString(),
    error: '相談の処理が終了しましたが、提案の保存を確認できませんでした。読み取り済みの教材は残っています。内容を確認して新しい相談を送れます。' };
  await deps.append({ id: `planning:${current.id}:failed`, type: 'planning.turn.upserted', actorId: current.requestedBy, createdAt: now.toISOString(), payload: failed });
  const canonical = (await deps.load()).data.planningTurns.find(item => item.id === current.id) ?? failed;
  return { turn: canonical, shouldDispatch: false, notice: canonical.status === 'complete'
    ? '提案は保存されています。' : '処理の終了を確認しました。保存済みの教材から、新しい相談を送れます。' };
}
