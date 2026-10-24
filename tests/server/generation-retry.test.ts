import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJob, Profile, Question, StudyData } from '../../src/lib/types';
import { prepareGenerationRetry, retryGeneration, type GenerationRetryDependencies } from '../../src/server/generation-retry';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';

const now = new Date('2026-10-23T00:00:00.000Z');
const owner: Profile = { id: 'owner', workspaceId: 'workspace-primary', name: 'Owner', };
const member: Profile = { ...owner, id: 'member', };
const original: GenerationJob = { id: 'old', topicId: 'topic', planId: 'plan', requestedBy: owner.id,
  audienceUserId: owner.id, status: 'failed', targetCount: 100, generatedCount: 10,
  instructions: 'Keep this exact saved scope', sourceIds: [], createdAt: now.toISOString(), error: 'Previous timeout' };
function data(): StudyData {
  return { jobs: [original], topics: [{ id: 'topic', planId: 'plan', audienceUserId: owner.id, title: 'Topic', subject: '古文', description: '', targetCount: 100, createdAt: now.toISOString() }],
    plans: [{ id: 'plan', ownerId: owner.id, title: 'Plan', subject: '古文', goal: 'Goal', difficulty: '高校1年', dailyQuestionTarget: 10, sourceIds: [], version: 4, createdAt: now.toISOString(), updatedAt: now.toISOString() }],
    profiles: [owner, member], sources: [], questions: Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, topicId: 'topic' } as Question)),
    planningTurns: [], attempts: [], exposures: [], sessions: [] };
}

test('explicit recovery keeps the saved topic, scope and audience and counts durable questions only', () => {
  const state = data();
  state.questions.push(state.questions[0], { id: 'another', topicId: 'another-topic' } as Question);
  const result = prepareGenerationRetry(state, owner, original.id, 'request', now, 'new');
  assert.equal(result.existing, false);
  assert.equal(result.job.generatedCount, 10);
  assert.equal(result.job.targetCount, 100);
  assert.equal(result.job.instructions, original.instructions);
  assert.equal(result.job.topicId, original.topicId);
  assert.equal(result.job.audienceUserId, owner.id);
  assert.equal(result.job.retryOfJobId, original.id);
  assert.equal(result.job.error, undefined);
  assert.equal(result.job.status, 'queued');
  const saved: StudyEvent = { id: 'retry', type: 'job.upserted', actorId: owner.id, createdAt: now.toISOString(), payload: result.job };
  assert.equal(foldEvents([saved]).jobs[0].retryOfJobId, original.id);
});

test('retry cannot change owners, use removed material, or append into published library content', () => {
  assert.throws(() => prepareGenerationRetry(data(), member, original.id, 'request', now, 'new'), { code: 'JOB_NOT_FOUND' });
  const state = data(); state.jobs = [{ ...original, sourceIds: ['gone'] }];
  assert.throws(() => prepareGenerationRetry(state, owner, original.id, 'request', now, 'new'), { code: 'GENERATION_ACCESS_DENIED' });
  const published = data(); published.topics[0].libraryPublished = true;
  assert.throws(() => prepareGenerationRetry(published, owner, original.id, 'request', now, 'new'), { code: 'GENERATION_ACCESS_DENIED' });
});

test('active, completed and fully saved work cannot be restarted and retry keeps the normal budget', () => {
  for (const status of ['running', 'queued', 'review'] as const) {
    const state = data(); state.jobs = [{ ...original, status }];
    assert.throws(() => prepareGenerationRetry(state, owner, original.id, 'request', now, 'new'), { code: 'JOB_NOT_FAILED' });
  }
  const saved = data(); saved.jobs = [{ ...original, targetCount: 10 }];
  assert.throws(() => prepareGenerationRetry(saved, owner, original.id, 'request', now, 'new'), { code: 'JOB_ALREADY_SAVED' });
  const occupied = data(); occupied.jobs.push({ ...original, id: 'active', status: 'running' });
  assert.throws(() => prepareGenerationRetry(occupied, owner, original.id, 'request', now, 'new'), { code: 'GENERATION_ACTIVE' });
  const limited = data(); limited.jobs.push({ ...original, id: 'other-1' }, { ...original, id: 'other-2' });
  assert.throws(() => prepareGenerationRetry(limited, owner, original.id, 'request', now, 'new'), { code: 'DAILY_BUDGET_LIMIT' });
});

test('repeated clicks including a fresh device return one canonical child instead of spending again', () => {
  const state = data();
  const child = prepareGenerationRetry(state, owner, original.id, 'first', now, 'child').job;
  state.jobs.push(child);
  for (const request of ['first', 'different-device-request']) {
    const next = prepareGenerationRetry(state, owner, original.id, request, now, 'must-not-create');
    assert.equal(next.existing, true); assert.equal(next.job.id, child.id);
  }
});

test('uncertain dispatch retains the same accepted job and a losing paid slot never dispatches', async () => {
  let state = data(); const events: StudyEvent[] = [];
  let dispatches: string[] = []; let reject = true;
  const deps: GenerationRetryDependencies = {
    load: async () => ({ data: state, events }),
    append: async event => { if (!events.some(e => e.id === event.id)) { events.push(event); state = { ...state, jobs: [...state.jobs, event.payload as GenerationJob] }; } },
    dispatch: async id => { dispatches.push(id); if (reject) throw new Error('lost dispatch response'); }, enabled: () => {}, now: () => now, newId: () => 'child',
  };
  await assert.rejects(retryGeneration(owner, original.id, 'first', deps), { code: 'WORKFLOW_UNAVAILABLE' });
  assert.equal(state.jobs.filter(job => job.retryOfJobId === original.id).length, 1);
  reject = false;
  const recovered = await retryGeneration(owner, original.id, 'second-device', deps);
  assert.equal(recovered.job.id, 'child'); assert.deepEqual(dispatches, ['child', 'child']);
  state.jobs = state.jobs.map(job => job.id === 'child' ? { ...job, status: 'running' } : job);
  await retryGeneration(owner, original.id, 'third', deps);
  assert.equal(dispatches.length, 2, 'running child is not dispatched again');

  state = data(); events.length = 0; dispatches = [];
  deps.append = async event => { events.push({ ...event, payload: { ...original, id: 'winner', retryOfJobId: 'someone-else' } }); };
  await assert.rejects(retryGeneration(owner, original.id, 'fresh', deps), { code: 'GENERATION_ACTIVE' });
  assert.equal(dispatches.length, 0);
});
