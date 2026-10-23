import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJob, LearningPlan, PlanningProposal, PlanningSample, PlanningTurn, Profile, Question, StudyData, Topic } from '../../src/lib/types';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import { validateSamples } from '../../src/server/planning-samples';
import { buildPlanningContext, checkPlanningRequest, validatePlanningReply } from '../../src/server/planning';
import { assertGenerationAccess, currentApprovedProposal, generationReplay, validateBulkCadence } from '../../src/server/proposal-selection';
import { assertGenerationBudget } from '../../src/server/generation-request';
import { prepareGenerationRetry } from '../../src/server/generation-retry';
import { preparePlanArrangement } from '../../src/server/plan-arrangement';

const now = new Date('2026-10-23T00:00:00.000Z');
const time = now.toISOString();
const owner: Profile = { id: 'sample-owner', name: 'Owner', familyId: getFamilyId(), role: 'student' };
const other: Profile = { ...owner, id: 'sample-other' };
const manager: Profile = { ...owner, id: 'sample-manager', role: 'parent', accessLevel: 'superuser' };
const sourceId = 'b7e948ee-30f4-4bbf-b0c9-51ba86f6a5cb';
const foreignSourceId = 'b7e948ee-30f4-4bbf-b0c9-51ba86f6a5cc';
const samples: PlanningSample[] = ['apple', 'pear', 'lemon'].map(word => ({ prompt: `What does ${word} mean?`, choices: [word, 'Dog', 'Blue', 'Run'], correctIndex: 0,
  explanation: `${word} is a fruit.`, learningPoint: 'Vocabulary', sourceIds: [], sourceNote: 'AI-created sample without sources', needsReview: false }));
const plan: LearningPlan = { id: 'sample-plan', ownerId: owner.id, title: 'Vocabulary', subject: '英語', goal: 'Build vocabulary', difficulty: '高校',
  dailyQuestionTarget: 10, sourceIds: [], sampleFirst: true, version: 2, createdAt: time, updatedAt: time };
const proposal: PlanningProposal = { id: 'sample-turn:0', title: 'Vocabulary practice', subject: '英語', description: 'Try three actual questions',
  instructions: 'Keep explanations concise', difficulty: '高校', targetCount: 10, format: 'multiple-choice', sourceIds: [], samples };
const turn: PlanningTurn = { id: 'sample-turn', planId: plan.id, requestedBy: owner.id, version: 2, status: 'complete', samplePreview: true,
  message: 'Show three vocabulary questions', reply: 'Check the three samples.', proposals: [proposal], createdAt: time };
const selection = { expectedVersion: 2, turnId: turn.id, proposalId: proposal.id, approveSamples: true };
function data(): StudyData { return structuredClone({ topics: [], sources: [], questions: [], attempts: [], exposures: [], sessions: [], jobs: [],
  profiles: [owner, other, manager], plans: [plan], planningTurns: [turn] }); }
function event(id: string, type: StudyEvent['type'], payload: unknown): StudyEvent { return { id, type, actorId: owner.id, createdAt: time, payload }; }
function sampleEvents(): StudyEvent[] { return [event('plan', 'plan.created', { ...plan, version: 1 }),
  event('queued', 'planning.turn.upserted', { ...turn, status: 'queued', reply: undefined, proposals: undefined }),
  event('complete', 'planning.turn.upserted', turn)]; }
function topic(id = 'sample-topic'): Topic { return { id, title: 'Saved vocabulary', subject: '英語', description: 'Saved questions', targetCount: 100,
  ownerId: owner.id, audienceUserId: owner.id, planId: plan.id, createdAt: time }; }
function question(id: string, topicId: string, sample = samples[0]): Question { return { ...structuredClone(sample), id, topicId,
  status: 'draft', version: 1, ownerId: owner.id, audienceUserId: owner.id, planId: plan.id, createdAt: time }; }
function savedJob(approved = true): GenerationJob { return { id: 'saved-job', topicId: 'sample-topic', planId: plan.id, requestedBy: owner.id,
  audienceUserId: owner.id, status: 'failed', targetCount: 100, generatedCount: 0, instructions: 'Canonical instructions', sourceIds: [],
  requestId: 'saved-request', turnId: turn.id, proposalId: proposal.id, createdAt: time,
  ...(approved ? { approvedSamples: structuredClone(samples), approvedSampleVersion: 2, dailyQuestionTarget: 10, plannedDays: 10 } : {}) }; }

test('sample-first output permits clarification but rejects incomplete, duplicate or unsourced samples', () => {
  assert.deepEqual(validatePlanningReply({ reply: 'Please upload the missing page.', proposals: [] }, plan, turn.id).proposals, []);
  assert.equal(validatePlanningReply({ reply: 'Check these.', proposals: [proposal] }, plan, turn.id).proposals[0].samples?.length, 3);
  for (const invalid of [undefined, samples.slice(0, 2), [...samples, samples[0]], [samples[0], samples[0], samples[2]],
    [{ ...samples[0], choices: ['Same', 'Same', 'Other', 'Last'] }, ...samples.slice(1)],
    [{ ...samples[0], correctIndex: 4 }, ...samples.slice(1)]]) {
    assert.throws(() => validatePlanningReply({ reply: 'Check these.', proposals: [{ ...proposal, samples: invalid }] }, plan, turn.id));
  }
  assert.throws(() => validateSamples(samples, [sourceId]), { code: 'INVALID_SAMPLE_SOURCE' });
  assert.throws(() => validateSamples(samples.map(sample => ({ ...sample, sourceIds: [foreignSourceId] })), [sourceId]), { code: 'INVALID_SAMPLE_SOURCE' });
});

test('new bulk approval is owner-only, explicit, current, and sourced from saved samples', () => {
  const state = data();
  assert.deepEqual(currentApprovedProposal(state, owner, plan.id, selection).samples, samples);
  for (const unauthorized of [manager, other]) assert.throws(() => currentApprovedProposal(state, unauthorized, plan.id, selection), { code: 'PLAN_NOT_FOUND' });
  for (const input of [{ ...selection, approveSamples: false }, { ...selection, turnId: undefined }, { ...selection, expectedVersion: undefined }])
    assert.throws(() => currentApprovedProposal(state, owner, plan.id, input), { code: 'SAMPLE_APPROVAL_REQUIRED' });
  assert.throws(() => currentApprovedProposal(state, owner, undefined, selection), { code: 'SAMPLE_APPROVAL_REQUIRED' });
  assert.throws(() => currentApprovedProposal({ ...state, plans: [{ ...plan, version: 3 }] }, owner, plan.id, selection), { code: 'VERSION_CONFLICT' });
  assert.throws(() => currentApprovedProposal({ ...state, plans: [{ ...plan, version: 3 }] }, owner, plan.id, { ...selection, expectedVersion: 3 }), { code: 'STALE_PROPOSAL' });
  assert.throws(() => currentApprovedProposal({ ...state, planningTurns: [{ ...turn, proposals: [{ ...proposal, samples: undefined }] }] }, owner, plan.id, selection), { code: 'SAMPLES_REQUIRED' });
});

test('persisted previews stay out of practice/public question data and other learners cannot see them', () => {
  const state = foldEvents(sampleEvents(), [owner, other, manager]);
  for (const visible of [state, studyDataForProfile(state, owner, now)]) {
    assert.equal(visible.topics.length, 0); assert.equal(visible.questions.length, 0); assert.equal(visible.jobs.length, 0);
    assert.equal(visible.planningTurns[0].proposals?.[0].samples?.length, 3);
  }
  assert.equal(studyDataForProfile(state, manager, now).planningTurns.length, 0);
  const unrelated = studyDataForProfile(state, other, now);
  assert.equal(unrelated.plans.length, 0); assert.equal(unrelated.planningTurns.length, 0);
  assert.doesNotMatch(JSON.stringify(unrelated), /What does apple mean/);
});

test('a bulk reservation persists sample approval and cadence and invalidates a second new approval', () => {
  const job = { ...savedJob(), status: 'queued' as const };
  const updatedPlan = { ...plan, requestedQuestionCount: 100, plannedDays: 10, version: 3 };
  const state = foldEvents([...sampleEvents(), event('bulk-slot', 'generation.requested', { topic: topic(), job, updatedPlan })], [owner]);
  assert.deepEqual(state.jobs[0].approvedSamples, samples);
  assert.equal(state.jobs[0].approvedSampleVersion, 2); assert.equal(state.plans[0].plannedDays, 10);
  assert.throws(() => currentApprovedProposal(state, owner, plan.id, selection), { code: 'VERSION_CONFLICT' });
  assert.equal(assertGenerationAccess(state, state.jobs[0]).id, owner.id, 'accepted work retains the original approved revision');
  assert.equal(generationReplay(state, owner, { requestId: job.requestId, planId: plan.id, turnId: turn.id, proposalId: proposal.id })?.job.id, job.id);
});

test('legacy recovery still works while new recovery keeps the original immutable samples', () => {
  for (const approved of [false, true]) {
    const job = savedJob(approved);
    const state = { ...data(), plans: [{ ...plan, version: 7 }], topics: [topic()], jobs: [job] };
    const retry = prepareGenerationRetry(state, owner, job.id, 'retry-request', now, 'retry-job');
    assert.equal(retry.job.topicId, job.topicId); assert.deepEqual(retry.job.approvedSamples, job.approvedSamples);
    assert.equal(retry.job.approvedSampleVersion, job.approvedSampleVersion);
    assert.equal(retry.job.plannedDays, job.plannedDays);
    const replay = prepareGenerationRetry({ ...state, jobs: [job, retry.job] }, owner, job.id, 'another-device', now, 'must-not-create');
    assert.equal(replay.existing, true); assert.equal(replay.job.id, retry.job.id);
  }
  const state = { ...data(), topics: [topic()], jobs: [savedJob()] };
  const changed = { ...state.jobs[0], approvedSamples: samples.map(sample => ({ ...sample, explanation: 'Unapproved change' })) };
  assert.throws(() => assertGenerationAccess(state, changed), { code: 'GENERATION_ACCESS_DENIED' });
});

test('sample conversations use the conversation budget, block concurrent bulk, and replay the same request', () => {
  const state = data();
  state.planningTurns = Array.from({ length: 5 }, (_, index) => ({ ...turn, id: `sample-${index}`, version: index + 2 }));
  assert.doesNotThrow(() => assertGenerationBudget(state, now));
  state.planningTurns[0].status = 'running';
  assert.throws(() => assertGenerationBudget(state, now), { code: 'GENERATION_ACTIVE' });
  const accepted = data(); accepted.plans[0].version = 7;
  const request = { requestId: turn.id, expectedVersion: 1, message: turn.message };
  assert.equal(checkPlanningRequest(accepted, owner, plan.id, request, now).previous?.id, turn.id);
  assert.throws(() => checkPlanningRequest(accepted, owner, plan.id, { ...request, message: 'Different sample instructions' }, now), { code: 'REQUEST_CONFLICT' });
});

test('follow-up conversation has actual recent samples but never another plan or learner sample', () => {
  const state = data();
  state.planningTurns.push({ ...turn, id: 'private-turn', planId: 'private-plan', requestedBy: other.id,
    proposals: [{ ...proposal, samples: samples.map(sample => ({ ...sample, prompt: 'OTHER_PRIVATE_SAMPLE' })) }] });
  const context = buildPlanningContext(state, [], plan, { ...turn, id: 'next-turn', version: 3, message: 'Make the second question harder' }, owner, now);
  assert.deepEqual(context.untrustedConversationHistory[0].proposals?.[0].samples, samples);
  assert.doesNotMatch(JSON.stringify(context), /OTHER_PRIVATE_SAMPLE/);
});

test('schedule totals cannot bypass limits or disagree with daily pace', () => {
  assert.doesNotThrow(() => validateBulkCadence(100, 10, 10));
  assert.doesNotThrow(() => validateBulkCadence(300));
  for (const total of [0, 301, 10.5]) assert.throws(() => validateBulkCadence(total), { code: 'INVALID_BULK_COUNT' });
  for (const [daily, days] of [[10, 9], [0, 10], [101, 1], [undefined, 10]])
    assert.throws(() => validateBulkCadence(100, daily, days), { code: 'INVALID_STUDY_PACE' });
});

test('arrangement copies allowed excerpts into a new private plan without altering originals or granting approval', () => {
  const state = data(); state.topics = [topic()];
  state.sources = [{ id: sourceId, ownerId: owner.id, storagePath: 'owned-file', name: 'Notes', mimeType: 'image/jpeg', createdAt: time },
    { id: foreignSourceId, ownerId: other.id, storagePath: 'foreign-file', name: 'Other notes', mimeType: 'image/jpeg', createdAt: time }];
  state.questions = samples.map((sample, index) => question(`original-${index}`, state.topics[0].id, { ...sample, sourceIds: [sourceId, foreignSourceId] }));
  const before = structuredClone(state);
  const prepared = preparePlanArrangement(state, owner, state.topics[0].id, 'new-arrangement', now);
  assert.deepEqual(state, before);
  assert.equal(prepared.plan.ownerId, owner.id); assert.equal(prepared.plan.version, 1); assert.equal(prepared.plan.libraryTopicId, undefined);
  assert.deepEqual(prepared.plan.sourceIds, [sourceId]); assert.equal(prepared.plan.arrangementExamples?.length, 3);
  assert.ok(prepared.plan.arrangementExamples?.every(sample => !sample.sourceIds.includes(foreignSourceId)));
  assert.throws(() => currentApprovedProposal({ ...state, plans: [...state.plans, prepared.plan] }, owner, prepared.plan.id, { ...selection, expectedVersion: 1 }), { code: 'STALE_PROPOSAL' });
  assert.throws(() => preparePlanArrangement(state, other, state.topics[0].id, 'forbidden', now), { code: 'TOPIC_NOT_FOUND' });
  const saved = { ...state, plans: [...state.plans, prepared.plan] };
  assert.equal(preparePlanArrangement(saved, owner, state.topics[0].id, prepared.plan.id, now).event, undefined);
  assert.throws(() => preparePlanArrangement(saved, other, state.topics[0].id, prepared.plan.id, now), { code: 'REQUEST_CONFLICT' });
});

test('public arrangements are no longer available, including old source-free clones', () => {
  const state = data(); state.topics = [topic('private-origin'), { ...topic('public-clone'), ownerId: undefined, audienceUserId: undefined, planId: undefined,
    libraryPublished: true, librarySourceTopicId: 'private-origin' }];
  state.plans[0].goal = 'PRIVATE_ORIGIN_GOAL';
  state.jobs = [{ ...savedJob(false), topicId: 'private-origin', instructions: 'PRIVATE_ORIGIN_INSTRUCTIONS' }];
  state.questions = [question('private-question', 'private-origin', { ...samples[0], prompt: 'PRIVATE_ORIGIN_QUESTION' }),
    { ...question('public-question', 'public-clone'), ownerId: undefined, audienceUserId: undefined, planId: undefined, sourceIds: [], sourceNote: '' }];
  assert.throws(()=>preparePlanArrangement(state,other,'public-clone','forbidden',new Date()),{code:'TOPIC_NOT_FOUND'});
});

test('arrangement retains admin-test isolation and rejects other families and active original jobs', () => {
  const state = data(); state.topics = [{ ...topic(), testOnly: true }];
  state.questions = [{ ...question('test-question', state.topics[0].id), testOnly: true }];
  assert.throws(() => preparePlanArrangement(state, owner, state.topics[0].id, 'no-student-test', now), { code: 'TOPIC_NOT_FOUND' });
  assert.throws(() => preparePlanArrangement(state, manager, state.topics[0].id, 'other-owner', now), { code: 'TOPIC_NOT_FOUND' });
  state.plans[0].ownerId = manager.id;
  state.topics[0].ownerId = manager.id; state.topics[0].audienceUserId = manager.id;
  state.questions[0].ownerId = manager.id; state.questions[0].audienceUserId = manager.id;
  const prepared = preparePlanArrangement(state, manager, state.topics[0].id, 'manager-arrangement', now);
  assert.equal(prepared.plan.ownerId, manager.id); assert.equal(prepared.plan.testOnly, true);
  assert.throws(() => preparePlanArrangement(state, { ...manager, familyId: 'another-family' }, state.topics[0].id, 'wrong-family', now), { code: 'FAMILY_MISMATCH' });
  state.jobs = [{ ...savedJob(false), status: 'running' }];
  assert.throws(() => preparePlanArrangement(state, manager, state.topics[0].id, 'running', now), { code: 'GENERATION_ACTIVE' });
});
