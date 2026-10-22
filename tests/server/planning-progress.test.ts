import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, PlanningTurn, StudyData } from '../../src/lib/types';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { assertPlanningCallNotSent, planningProgress, planningReadingSample, withObservedPlanningProgress } from '../../src/server/planning-progress';
import { inspectPlanningRun, type PlanningStatusDependencies } from '../../src/server/planning-status';

const time = '2026-10-23T00:00:00.000Z';
const plan: LearningPlan = { id: 'plan', ownerId: 'owner', title: '英語', subject: '英語', goal: '語彙を確認', difficulty: '基礎',
  dailyQuestionTarget: 10, sourceIds: ['source-a', 'source-b'], version: 1, createdAt: time, updatedAt: time };
const turn: PlanningTurn = { id: 'turn', planId: plan.id, requestedBy: plan.ownerId, version: 2, status: 'queued', message: '相談', createdAt: time };
const event = (id: string, type: StudyEvent['type'], payload: unknown, at = time): StudyEvent => ({ id, type, payload, actorId: plan.ownerId, createdAt: at });
const analysis = (id: string) => event(`source-analysis:${id}`, 'source.analysis', { sourceId: id, text: '{}' });
const initial = () => [event('plan', 'plan.created', plan), event('turn', 'planning.turn.upserted', turn)];

test('progress counts only saved selected analyses and fixes initial uncached count', () => {
  const cached = [analysis('source-a'), analysis('unselected'), event('wrong-id', 'source.analysis', { sourceId: 'source-b', text: '{}' })];
  const queued = planningProgress(turn, plan.sourceIds, cached, 'queued', new Date(time));
  assert.deepEqual(queued.progress, { phase: 'queued', sourcesTotal: 2, sourcesCompleted: 1, sourcesRequiringAnalysis: 1 });
  assert.equal(queued.startedAt, undefined);
  const started = planningProgress(queued, plan.sourceIds, cached, 'reading_sources', new Date('2026-10-23T00:00:05Z'));
  const ready = planningProgress(started, plan.sourceIds, [...cached, analysis('source-b')], 'thinking', new Date('2026-10-23T00:01:00Z'));
  assert.equal(ready.progress?.sourcesCompleted, 2);
  assert.equal(ready.progress?.sourcesRequiringAnalysis, 1);
  assert.equal(ready.startedAt, '2026-10-23T00:00:05.000Z');
  assert.equal(ready.updatedAt, '2026-10-23T00:01:00.000Z');
  assert.equal(planningProgress(turn, [], [], 'failed').startedAt, undefined, 'a dispatch failure never pretends processing started');
});

test('a paid request receipt blocks repeating the same logical source or proposal call, even without a usage result', () => {
  for (const sourceId of [undefined, 'source-a']) {
    const feature = sourceId ? 'source-analysis' : 'planning';
    const requestId = sourceId ? `planning:${turn.id}:source:${sourceId}` : turn.id;
    const receipt = event('receipt', 'ai.requested', { feature, requestId });
    assert.throws(() => assertPlanningCallNotSent([receipt], turn, sourceId), { code: 'PLANNING_RESULT_UNCERTAIN' });
    assert.doesNotThrow(() => assertPlanningCallNotSent([{ ...receipt, actorId: 'another-owner' }], turn, sourceId));
    assert.doesNotThrow(() => assertPlanningCallNotSent([receipt], { ...turn, id: 'new-turn' }, sourceId));
  }
});

test('progress roundtrips without regressing a newer phase and legacy turns still load', () => {
  const queued = planningProgress(turn, plan.sourceIds, [], 'queued', new Date(time));
  const running = { ...planningProgress(queued, plan.sourceIds, [], 'reading_sources', new Date('2026-10-23T00:00:05Z')), status: 'running' as const, workflowRunId: 'run-1' };
  const thinking = planningProgress(running, plan.sourceIds, [analysis('source-a'), analysis('source-b')], 'thinking', new Date('2026-10-23T00:01:00Z'));
  const savedEvents = [initial()[0], event('queued', 'planning.turn.upserted', queued), event('running', 'planning.turn.upserted', running),
    event('thinking', 'planning.turn.upserted', thinking), event('late-old-progress', 'planning.turn.upserted', running)];
  const actual = foldEvents(savedEvents).planningTurns[0];
  assert.equal(actual.progress?.phase, 'thinking');
  assert.equal(actual.progress?.sourcesCompleted, 2);
  assert.equal(actual.progress?.sourcesRequiringAnalysis, 2);
  assert.equal(actual.startedAt, running.startedAt);
  assert.equal(actual.workflowRunId, 'run-1');
  assert.equal(foldEvents(initial()).planningTurns[0].progress, undefined);
  assert.throws(() => foldEvents([initial()[0], event('invalid', 'planning.turn.upserted', { ...queued,
    progress: { ...queued.progress, sourcesCompleted: 3 } })]));
});

test('an already-running legacy turn exposes saved source counts and same-turn measurements without fabricating a heartbeat', () => {
  const extraPlan = { ...plan, sourceIds: [...plan.sourceIds, 'source-c'] };
  const running = { ...turn, status: 'running' as const };
  const baseEvents = [event('plan', 'plan.created', extraPlan), analysis('source-a'), event('turn', 'planning.turn.upserted', turn),
    event('running', 'planning.turn.upserted', running, '2026-10-23T00:00:01Z')];
  const request = { feature: 'source-analysis', requestId: `planning:${turn.id}:source:source-b`, invocationId: 'same-turn' };
  const observedEvents = [...baseEvents,
    event('requested', 'ai.requested', request, '2026-10-23T00:00:05Z'),
    event('usage', 'ai.usage', { ...request, status: 'complete', estimatedUsd: 100 }, '2026-10-23T00:00:45Z'),
    event('source-analysis:source-b', 'source.analysis', { sourceId: 'source-b', text: 'PRIVATE_SOURCE_TEXT' }, '2026-10-23T00:00:46Z'),
  ];
  const data = foldEvents(baseEvents);
  const result = withObservedPlanningProgress(data, observedEvents).planningTurns[0];
  assert.deepEqual(result.progress, { phase: 'reading_sources', sourcesTotal: 3, sourcesCompleted: 2, sourcesRequiringAnalysis: 2,
    readingSample: { count: 1, minSeconds: 40, maxSeconds: 40 } });
  assert.equal(result.startedAt, '2026-10-23T00:00:01Z');
  assert.equal(result.updatedAt, '2026-10-23T00:00:46Z');
  assert.deepEqual(withObservedPlanningProgress(data, observedEvents).planningTurns[0], result, 'polling alone must not invent new progress');
  assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_TEXT'), false);
  assert.equal(JSON.stringify(result).includes('estimatedUsd'), false);
  const planning = { feature: 'planning', requestId: turn.id, invocationId: 'planning-reply' };
  observedEvents.push(event('proposal-request', 'ai.requested', planning, '2026-10-23T00:00:47Z'));
  assert.equal(withObservedPlanningProgress(data, observedEvents).planningTurns[0].progress?.phase, 'thinking');
  observedEvents.push(event('proposal-result', 'ai.usage', { ...planning, status: 'complete' }, '2026-10-23T00:01:00Z'));
  assert.equal(withObservedPlanningProgress(data, observedEvents).planningTurns[0].progress?.phase, 'saving');
});

test('timing samples exclude other owners, other turns, unsaved analyses, and failed responses', () => {
  const sourceIds = ['source-a', 'source-b'];
  const makePair = (requestId: string, actorId = turn.requestedBy, status = 'complete'): StudyEvent[] => {
    const payload = { feature: 'source-analysis', requestId, invocationId: requestId + actorId };
    return [{ ...event('requested-' + requestId, 'ai.requested', payload, '2026-10-23T00:00:05Z'), actorId },
      { ...event('usage-' + requestId, 'ai.usage', { ...payload, status }, '2026-10-23T00:00:45Z'), actorId }];
  };
  const events = [event('source-analysis:source-a', 'source.analysis', { sourceId: 'source-a', text: '{}' }, '2026-10-23T00:00:46Z'),
    ...makePair('planning:other-turn:source:source-a'),
    ...makePair(`planning:${turn.id}:source:source-a`, 'another-owner'),
    ...makePair(`planning:${turn.id}:source:source-a`, turn.requestedBy, 'failed'),
    ...makePair(`planning:${turn.id}:source:source-b`),
  ];
  assert.equal(planningReadingSample(turn, sourceIds, events), undefined);
});

function fixture(current: PlanningTurn = { ...turn, status: 'running', workflowRunId: 'run-1' }, runStatus: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'running') {
  const events = [...initial(), event('current', 'planning.turn.upserted', current)];
  const writes: StudyEvent[] = [];
  const deps: PlanningStatusDependencies = {
    findRunId: async item => item.workflowRunId, status: async () => runStatus,
    load: async () => ({ data: foldEvents(events), events }),
    append: async item => { writes.push(item); events.push(item); }, now: () => new Date('2026-10-24T00:00:00Z'),
  };
  return { deps, writes, events };
}

test('long-running, unknown legacy, and unavailable status do not fail a turn or dispatch another request', async () => {
  const running = { ...turn, status: 'running' as const, workflowRunId: 'run-1' };
  const active = fixture(running);
  const result = await inspectPlanningRun(running, active.deps);
  assert.equal(result.shouldDispatch, false);
  assert.equal(result.turn.status, 'running');
  assert.equal(active.writes.length, 0);
  const legacy = { ...turn, status: 'running' as const };
  const unknown = fixture(legacy);
  assert.equal((await inspectPlanningRun(legacy, unknown.deps)).shouldDispatch, false);
  assert.equal(unknown.writes.length, 0);
  active.deps.status = async () => { throw new Error('PRIVATE_PROVIDER_DETAILS'); };
  await assert.rejects(inspectPlanningRun(running, active.deps), error => {
    assert.equal((error as { code: string }).code, 'PLANNING_STATUS_UNAVAILABLE');
    assert.equal(String(error).includes('PRIVATE_PROVIDER_DETAILS'), false); return true;
  });
  assert.equal(active.writes.length, 0);
});

test('only a queued turn without a known active run requests explicit dispatch', async () => {
  const pending = fixture(turn);
  assert.equal((await inspectPlanningRun(turn, pending.deps)).shouldDispatch, true);
  pending.deps.findRunId = async () => 'known-run';
  const running = await inspectPlanningRun(turn, pending.deps);
  assert.equal(running.shouldDispatch, false);
  assert.equal(running.turn.workflowRunId, 'known-run');
  assert.equal(running.turn.updatedAt, undefined, 'status inspection is not progress');
});

test('confirmed terminal workflow status releases a stuck reservation without scheduling any paid work', async () => {
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const running = { ...turn, status: 'running' as const, workflowRunId: 'run-1' };
    const stopped = fixture(running, status);
    const result = await inspectPlanningRun(running, stopped.deps);
    assert.equal(result.shouldDispatch, false);
    assert.equal(result.turn.status, 'failed');
    assert.equal(result.turn.progress?.phase, 'failed');
    assert.equal(stopped.writes.length, 1);
  }
});

test('a completed result saved during status lookup wins over failure reconciliation', async () => {
  const running = { ...turn, status: 'running' as const, workflowRunId: 'run-1' };
  const concurrent = fixture(running, 'failed');
  concurrent.deps.status = async () => {
    concurrent.events.push(event('completed', 'planning.turn.upserted', { ...running, status: 'complete', reply: '保存済み', completedAt: time }));
    return 'failed';
  };
  const result = await inspectPlanningRun(running, concurrent.deps);
  assert.equal(result.turn.status, 'complete');
  assert.equal(result.turn.reply, '保存済み');
  assert.equal(concurrent.writes.length, 0);
});
