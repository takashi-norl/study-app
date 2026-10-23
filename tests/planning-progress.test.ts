import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanningTurn } from '../src/lib/types';
import { durationLabel, elapsedSeconds, planningTimeEstimate, planningWaitState, readingTimeEstimate } from '../src/lib/planning-progress';

const now = Date.parse('2026-10-23T03:00:00Z');
function turn(id: string, offset = 0, seconds = 50): PlanningTurn {
  const createdAt = new Date(now - offset * 3600000).toISOString();
  return { id, planId: 'p', requestedBy: 'u', version: 2, status: 'complete', message: '', createdAt,
    completedAt: new Date(Date.parse(createdAt) + seconds * 1000).toISOString(),
    progress: { phase: 'complete', sourcesCompleted: 0, sourcesTotal: 0, sourcesRequiringAnalysis: 0 } };
}
test('wait time estimates require three comparable real completions and never count failures or the active turn', () => {
  const current = { ...turn('current'), status: 'running' as const, completedAt: undefined };
  const samples = [turn('a', 1, 31), turn('b', 2, 59), turn('c', 3, 45)];
  assert.equal(planningTimeEstimate(current, samples.slice(0, 2)), null);
  assert.deepEqual(planningTimeEstimate(current, samples), { lower: 30, upper: 60, count: 3 });
  assert.equal(planningTimeEstimate(current, [samples[0], samples[1], { ...samples[2], status: 'failed' }, current]), null);
});
test('cached materials, unknown legacy metadata and different source counts do not produce misleading estimates', () => {
  const current = turn('current');
  const samples = [turn('a', 1), turn('b', 2), turn('c', 3)];
  assert.equal(planningTimeEstimate({ ...current, progress: undefined }, samples), null);
  assert.equal(planningTimeEstimate(current, samples.map(item => ({ ...item, progress: { ...item.progress!, sourcesTotal: 20 } }))), null);
  assert.equal(planningTimeEstimate(current, samples.map(item => ({ ...item, progress: { ...item.progress!, sourcesRequiringAnalysis: 1 } }))), null);
});
test('sample previews use their own measured completions, not older proposal-only timings', () => {
  const current = { ...turn('current'), samplePreview: true as const };
  const previous = [turn('a', 1), turn('b', 2), turn('c', 3)];
  assert.equal(planningTimeEstimate(current, previous), null);
  assert.deepEqual(planningTimeEstimate(current, previous.map(item => ({ ...item, samplePreview: true }))), { lower: 50, upper: 50, count: 3 });
  assert.equal(planningTimeEstimate(turn('legacy'), previous.map(item => ({ ...item, samplePreview: true }))), null);
});
test('a long active reading job is not marked stuck when saved progress is recent', () => {
  const current = { ...turn('current'), status: 'running' as const, createdAt: new Date(now - 12 * 60000).toISOString(), updatedAt: new Date(now - 30000).toISOString() };
  const state = planningWaitState(current, [], now);
  assert.equal(state.elapsed, 720);
  assert.equal(state.needsCheck, false);
  assert.equal(state.estimate, null);
  assert.equal(planningWaitState({ ...current, updatedAt: new Date(now - 181000).toISOString() }, [], now).needsCheck, true);
});
test('elapsed labels are coarse and safe for an invalid or future timestamp', () => {
  assert.equal(durationLabel(9), '10秒未満');
  assert.equal(durationLabel(34), '30秒');
  assert.equal(durationLabel(65), '1分');
  assert.equal(durationLabel(78), '1分10秒');
  assert.equal(durationLabel(3600), '1時間');
  assert.equal(elapsedSeconds('invalid', now), 0);
  assert.equal(elapsedSeconds(new Date(now + 10000).toISOString(), now), 0);
});

test('remaining reading estimate uses completed same-request measurements and is not a full completion countdown', () => {
  const current = { ...turn('current'), status: 'running' as const,
    progress: { phase: 'reading_sources' as const, sourcesTotal: 20, sourcesCompleted: 12,
      readingSample: { count: 12, minSeconds: 28, maxSeconds: 42 } } };
  assert.deepEqual(readingTimeEstimate(current), { remaining: 8, count: 12, lower: 220, upper: 340 });
  assert.equal(readingTimeEstimate({ ...current, progress: { ...current.progress, readingSample: { count: 2, minSeconds: 28, maxSeconds: 42 } } }), null);
  assert.equal(readingTimeEstimate({ ...current, progress: { ...current.progress, phase: 'thinking' } }), null);
  assert.equal(readingTimeEstimate({ ...current, progress: { ...current.progress, sourcesCompleted: 20 } }), null);
});
