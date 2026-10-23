import 'server-only';
import type { PlanningTurn, StudyData } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { ApiError } from './config';
import { latestSourceAnalysis } from './source-analysis';

export type PlanningPhase = NonNullable<PlanningTurn['progress']>['phase'];

function savedSourceAnalyses(sourceIds: string[], events: StudyEvent[]): Map<string, StudyEvent> {
  const saved = new Map<string, StudyEvent>();
  for (const sourceId of new Set(sourceIds)) {
    const event = latestSourceAnalysis(events, sourceId);
    if (event) saved.set(sourceId, event);
  }
  return saved;
}

function planningReceipts(turn: PlanningTurn, sourceIds: string[], events: StudyEvent[]) {
  const sourceRequests = new Map(sourceIds.map(id => [`planning:${turn.id}:source:${id}`, id]));
  const requests = new Map<string, StudyEvent>();
  const usage = new Map<string, StudyEvent>();
  for (const event of events) {
    if (event.actorId !== turn.requestedBy) continue;
    if (event.type === 'ai.requested' && ((event.payload.feature === 'planning' && event.payload.requestId === turn.id)
      || (event.payload.feature === 'source-analysis' && sourceRequests.has(event.payload.requestId)))) {
      if (!requests.has(event.payload.invocationId)) requests.set(event.payload.invocationId, event);
    }
  }
  for (const event of events) {
    if (event.type !== 'ai.usage' || event.actorId !== turn.requestedBy) continue;
    const request = requests.get(event.payload.invocationId);
    if (request && event.payload.requestId === request.payload.requestId && event.payload.feature === request.payload.feature
      && !usage.has(event.payload.invocationId)) usage.set(event.payload.invocationId, event);
  }
  return { requests, usage, sourceRequests };
}

/** Same-turn successful provider timing only: does not expose prompts, cost, or other users' usage. */
export function planningReadingSample(turn: PlanningTurn, sourceIds: string[], events: StudyEvent[]): NonNullable<PlanningTurn['progress']>['readingSample'] {
  const saved = savedSourceAnalyses(sourceIds, events);
  const { requests, usage, sourceRequests } = planningReceipts(turn, sourceIds, events);
  const durations = new Map<string, number>();
  for (const request of requests.values()) {
    const sourceId = sourceRequests.get(request.payload.requestId);
    const response = usage.get(request.payload.invocationId);
    if (!sourceId || response?.payload.status !== 'complete' || durations.has(sourceId)) continue;
    const analysis = saved.get(sourceId);
    const seconds = (Date.parse(response.createdAt) - Date.parse(request.createdAt)) / 1000;
    if (analysis && Date.parse(analysis.createdAt) >= Date.parse(request.createdAt) && Number.isFinite(seconds) && seconds > 0) durations.set(sourceId, seconds);
  }
  const values = [...durations.values()];
  return values.length ? { count: values.length, minSeconds: Math.min(...values), maxSeconds: Math.max(...values) } : undefined;
}

/** Counts only analyses already saved in the event log, never elapsed-time estimates. */
export function planningProgress(turn: PlanningTurn, sourceIds: string[], events: StudyEvent[], phase: PlanningPhase, now = new Date()): PlanningTurn {
  const selected = [...new Set(sourceIds)];
  const sourcesCompleted = savedSourceAnalyses(selected, events).size;
  const readingSample = planningReadingSample(turn, selected, events);
  return { ...turn, updatedAt: now.toISOString(),
    ...(['preparing', 'reading_sources', 'thinking', 'saving'].includes(phase) && !turn.startedAt ? { startedAt: now.toISOString() } : {}),
    progress: { phase, sourcesTotal: selected.length, sourcesCompleted,
      sourcesRequiringAnalysis: turn.progress?.sourcesRequiringAnalysis ?? selected.length - sourcesCompleted,
      ...(readingSample ? { readingSample } : {}) },
  };
}

/** Old workflows can still be running after deploy. Project their actual receipts without rewriting history. */
export function withObservedPlanningProgress(data: StudyData, events: StudyEvent[]): StudyData {
  return { ...data, planningTurns: data.planningTurns.map(turn => {
    if (turn.status !== 'queued' && turn.status !== 'running') return turn;
    const plan = data.plans.find(item => item.id === turn.planId);
    if (!plan) return turn;
    const sourceIds = [...new Set(plan.sourceIds)];
    const analyses = savedSourceAnalyses(sourceIds, events);
    const { requests, usage, sourceRequests } = planningReceipts(turn, sourceIds, events);
    const acceptedIndex = events.findIndex(event => event.type === 'planning.turn.upserted' && event.payload.id === turn.id && event.payload.status === 'queued');
    const initialAnalyses = savedSourceAnalyses(sourceIds, acceptedIndex >= 0 ? events.slice(0, acceptedIndex) : events.filter(event => Date.parse(event.createdAt) < Date.parse(turn.createdAt)));
    const started = events.find(event => event.type === 'planning.turn.upserted' && event.payload.id === turn.id && event.payload.status === 'running');
    const planningRequest = [...requests.values()].find(event => event.payload.feature === 'planning');
    const sourceStarted = [...requests.values()].some(event => sourceRequests.has(event.payload.requestId));
    let phase: PlanningPhase = turn.progress?.phase ?? (turn.status === 'queued' ? 'queued' : sourceStarted ? 'reading_sources' : 'preparing');
    if (planningRequest) phase = usage.get(planningRequest.payload.invocationId)?.payload.status === 'complete' ? 'saving' : 'thinking';
    const evidence = [turn.updatedAt, started?.createdAt, ...[...requests.values(), ...usage.values()].map(event => event.createdAt),
      ...[...analyses].filter(([sourceId]) => [...requests.values()].some(event => sourceRequests.get(event.payload.requestId) === sourceId)).map(([, event]) => event.createdAt)]
      .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
    const updatedAt = evidence.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    const readingSample = planningReadingSample(turn, sourceIds, events);
    return { ...turn, ...(turn.startedAt || started ? { startedAt: turn.startedAt ?? started?.createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}), progress: { phase, sourcesTotal: sourceIds.length, sourcesCompleted: analyses.size,
        sourcesRequiringAnalysis: turn.progress?.sourcesRequiringAnalysis ?? sourceIds.length - initialAnalyses.size,
        ...(readingSample ? { readingSample } : {}),
      },
    };
  }) };
}

/** A lost paid response must not become another provider request when a workflow is restarted. */
export function assertPlanningCallNotSent(events: StudyEvent[], turn: PlanningTurn, sourceId?: string): void {
  const feature = sourceId ? 'source-analysis' : 'planning';
  const requestId = sourceId ? `planning:${turn.id}:source:${sourceId}` : turn.id;
  if (events.some(event => event.type === 'ai.requested' && event.actorId === turn.requestedBy
    && event.payload.feature === feature && event.payload.requestId === requestId)) {
    throw new ApiError(409, 'このAI依頼は送信済みですが、保存された結果を確認できません。重複して送らず、この相談を終了しました。保存済みの教材は次の相談で使えます。', 'PLANNING_RESULT_UNCERTAIN');
  }
}
