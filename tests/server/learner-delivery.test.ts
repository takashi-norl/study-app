import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, Profile, Question, Topic } from '../../src/lib/types';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import { prepareLearnerDelivery, type LearnerDeliveryInput } from '../../src/server/learner-delivery';
import { mayPracticeQuestion } from '../../src/server/practice-access';
import { learningProjects } from '../../src/lib/learning-projects';

const now = new Date('2026-10-23T03:00:00.000Z');
const createdAt = '2026-10-20T00:00:00.000Z';
const parent: Profile = { id: 'parent', name: '管理者', role: 'parent', familyId: getFamilyId() };
const learner: Profile = { ...parent, id: 'learner', name: '学習者', role: 'student' };
const sibling: Profile = { ...learner, id: 'sibling', name: '別の学習者' };
const profiles = [parent, learner, sibling];
const sourceId = '5d9f794d-06d5-4ca6-bdad-dfc63208137a';
const requestId = 'f44e4a7c-8f15-4b4e-84c1-fc4fef893ccc';
const input: LearnerDeliveryInput = { topicId: sourceId, learnerId: learner.id, requestId, projectName: '2学期中間テスト' };
const event = (id: string, type: StudyEvent['type'], payload: object): StudyEvent => ({ id, type, payload, actorId: parent.id, createdAt });

function fixture() {
  const plan: LearningPlan = { id: 'PRIVATE_ORIGINAL_PLAN', ownerId: parent.id, title: 'PRIVATE_PLAN_TITLE', subject: '古文',
    tags: ['PRIVATE_TAG'], goal: 'PRIVATE_GOAL', difficulty: 'PRIVATE_DIFFICULTY', dailyQuestionTarget: 10,
    sourceIds: ['PRIVATE_PHOTO'], version: 1, createdAt, updatedAt: createdAt };
  const topic: Topic = { id: sourceId, ownerId: parent.id, planId: plan.id, title: '2学期中間テスト・古文', subject: '古文',
    description: 'PRIVATE_DESCRIPTION', targetCount: 3, createdAt };
  const question: Question = { id: 'original-q1', topicId: topic.id, planId: plan.id, ownerId: parent.id, audienceUserId: parent.id,
    prompt: '「いと」の意味として適切なものは？', choices: ['とても', '少し'], correctIndex: 0,
    explanation: '「いと」は程度を表します。', learningPoint: '古語の意味', sourceIds: ['PRIVATE_PHOTO'], sourceNote: 'PRIVATE_SOURCE_NOTE',
    status: 'draft', needsReview: true, aiGenerated: true, version: 3, createdAt };
  const events = [event('plan', 'plan.created', plan), event('topic', 'topic.created', topic), event('q1', 'question.upserted', question),
    event('q2', 'question.upserted', { ...question, id: 'original-q2', prompt: '「あはれなり」の意味は？', status: 'approved', needsReview: false }),
    event('q3', 'question.upserted', { ...question, id: 'archived-q', status: 'archived' }),
    event('photo', 'source.created', { id: 'PRIVATE_PHOTO', ownerId: parent.id, name: 'PRIVATE_PHOTO_NAME', storagePath: 'PRIVATE_PATH', mimeType: 'image/jpeg', createdAt }),
    event('chat', 'planning.turn.upserted', { id: 'PRIVATE_CHAT', planId: plan.id, requestedBy: parent.id, version: 1,
      status: 'complete', message: 'PRIVATE_CHAT_MESSAGE', reply: 'PRIVATE_REPLY', createdAt })];
  return { events, data: foldEvents(events, profiles) };
}

test('delivery uses existing event types and creates only learner-owned private question copies', () => {
  const { data, events } = fixture();
  const before = structuredClone(data);
  const prepared = prepareLearnerDelivery(data, events, parent, input, now);
  assert.equal(prepared.deliveredCount, 2);
  assert.deepEqual(prepared.plan.tags, ['2学期中間テスト']);
  assert.equal(prepared.plan.ownerId, learner.id);
  assert.deepEqual(prepared.plan.sourceIds, []);
  assert.equal(prepared.topic.libraryPublished, undefined);
  assert.equal(prepared.topic.audienceUserId, learner.id);
  const all = [...prepared.questionEvents, ...prepared.completionEvents];
  assert.ok(all.every(item => ['questions.published', 'plan.created', 'topic.created'].includes(item.type)));
  assert.ok(all.every(item => item.actorId === parent.id));
  const delivered = foldEvents([...events, ...all], profiles);
  const copies = delivered.questions.filter(question => question.topicId === prepared.topic.id);
  assert.equal(copies.length, 2);
  assert.ok(copies.every(question => question.ownerId === learner.id && question.audienceUserId === learner.id
    && question.planId === prepared.plan.id && question.sourceIds.length === 0 && question.version === 1
    && question.status === 'published' && question.createdAt === now.toISOString() && !question.testOnly));
  assert.equal(copies[0].needsReview, true);
  assert.equal(copies[0].prompt, data.questions[0].prompt);
  assert.equal(copies[0].explanation, data.questions[0].explanation);
  assert.deepEqual(data, before);
  assert.deepEqual(delivered.questions.find(question => question.id === data.questions[0].id), data.questions[0]);
  assert.equal(delivered.attempts.length, 0); assert.equal(delivered.sessions.length, 0); assert.equal(delivered.exposures.length, 0);
});

test('staged copies stay invisible; completed delivery is visible and practiceable only to its target learner', () => {
  const { data, events } = fixture();
  const prepared = prepareLearnerDelivery(data, events, parent, input, now);
  const staged = foldEvents([...events, ...prepared.questionEvents], profiles);
  assert.equal(studyDataForProfile(staged, learner).questions.length, 0);
  assert.equal(studyDataForProfile(staged, learner).plans.length, 0);
  const delivered = foldEvents([...events, ...prepared.questionEvents, ...prepared.completionEvents], profiles);
  const view = studyDataForProfile(delivered, learner);
  assert.equal(view.topics.length, 1); assert.equal(view.questions.length, 2); assert.equal(view.plans.length, 1);
  assert.equal(studyDataForProfile(delivered, sibling).questions.length, 0);
  assert.equal(studyDataForProfile(delivered, sibling).topics.length, 0);
  assert.equal(view.sources.length, 0); assert.equal(view.planningTurns.length, 0);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|delivery|sourceTopicId/);
  const copies = delivered.questions.filter(question => question.topicId === prepared.topic.id);
  assert.ok(copies.every(question => mayPracticeQuestion(delivered, learner, question)));
  assert.ok(copies.every(question => !mayPracticeQuestion(delivered, sibling, question)));
  const project = learningProjects(view, learner.id, now).groups.find(group => group.label === input.projectName);
  assert.equal(project?.progress.total, 2); assert.equal(project?.progress.answered, 0);
});

test('retry is idempotent after staging and after completion, even if the original changes later', () => {
  const { data, events } = fixture();
  const first = prepareLearnerDelivery(data, events, parent, input, now);
  const stagedEvents = [...events, ...first.questionEvents];
  const staged = foldEvents(stagedEvents, profiles);
  const resumed = prepareLearnerDelivery(staged, stagedEvents, parent, input, new Date('2026-10-24T00:00:00Z'));
  assert.deepEqual(resumed.questionEvents, first.questionEvents);
  assert.deepEqual(resumed.completionEvents, first.completionEvents);
  const completedEvents = [...stagedEvents, ...resumed.questionEvents, ...resumed.completionEvents, ...resumed.completionEvents];
  const completed = foldEvents(completedEvents, profiles);
  assert.equal(completed.plans.length, 2); assert.equal(completed.topics.length, 2); assert.equal(completed.questions.length, 5);
  completed.questions[0] = { ...completed.questions[0], prompt: '変更後の元問題', version: 4 };
  const retry = prepareLearnerDelivery(completed, completedEvents, parent, input, now);
  assert.equal(retry.alreadyDelivered, true); assert.equal(retry.questionEvents.length, 0); assert.equal(retry.completionEvents.length, 0);
  assert.equal(retry.topic.id, first.topic.id);
  for (const changed of [{ ...input, learnerId: sibling.id }, { ...input, projectName: '別のテスト' },
    { ...input, topicId: '9d998e90-6336-4bd5-babc-dc05726f36e9' }]) {
    assert.throws(() => prepareLearnerDelivery(completed, completedEvents, parent, changed, now), { code: 'DELIVERY_REQUEST_CONFLICT' });
  }
});

test('delivery refuses stale staged sources and missing or foreign current members', () => {
  const { data, events } = fixture();
  const first = prepareLearnerDelivery(data, events, parent, input, now);
  const stagedEvents = [...events, ...first.questionEvents];
  const staged = foldEvents(stagedEvents, profiles);
  staged.questions[0] = { ...staged.questions[0], version: 4, explanation: '変更後' };
  assert.throws(() => prepareLearnerDelivery(staged, stagedEvents, parent, input, now), { code: 'DELIVERY_SOURCE_CHANGED' });
  for (const actor of [learner, { ...parent, familyId: 'foreign' }, { ...parent, id: 'removed' }]) {
    assert.throws(() => prepareLearnerDelivery(data, events, actor, input, now), { code: 'DELIVERY_FORBIDDEN' });
  }
  for (const id of [parent.id, 'missing']) {
    assert.throws(() => prepareLearnerDelivery(data, events, parent, { ...input, learnerId: id }, now), { code: 'LEARNER_NOT_FOUND' });
  }
  assert.throws(() => prepareLearnerDelivery({ ...data, profiles: [parent, { ...learner, familyId: 'foreign' }] }, events, parent, input, now), { code: 'LEARNER_NOT_FOUND' });
  assert.throws(() => prepareLearnerDelivery({ ...data, profiles: [parent, sibling] }, events, parent, input, now), { code: 'LEARNER_NOT_FOUND' });
});

test('delivery rejects tests, active generation, empty/oversized/invalid questions and plan limit', () => {
  const { data, events } = fixture();
  assert.throws(() => prepareLearnerDelivery({ ...data, topics: [{ ...data.topics[0], testOnly: true }] }, events, parent, input, now), { code: 'DELIVERY_TEST_ONLY' });
  assert.throws(() => prepareLearnerDelivery({ ...data, plans: [{ ...data.plans[0], testOnly: true }] }, events, parent, input, now), { code: 'DELIVERY_TEST_ONLY' });
  assert.throws(() => prepareLearnerDelivery({ ...data, questions: [{ ...data.questions[0], testOnly: true }] }, events, parent, input, now), { code: 'DELIVERY_TEST_ONLY' });
  for (const status of ['queued', 'running'] as const) assert.throws(() => prepareLearnerDelivery({ ...data, jobs: [{ id: 'job', topicId: sourceId, status, targetCount: 10, generatedCount: 2, createdAt }] }, events, parent, input, now), { code: 'GENERATION_ACTIVE' });
  assert.throws(() => prepareLearnerDelivery({ ...data, questions: [] }, events, parent, input, now), { code: 'DELIVERY_EMPTY_OR_TOO_LARGE' });
  assert.throws(() => prepareLearnerDelivery({ ...data, questions: Array.from({ length: 301 }, (_, index) => ({ ...data.questions[0], id: `q${index}` })) }, events, parent, input, now), { code: 'DELIVERY_EMPTY_OR_TOO_LARGE' });
  assert.throws(() => prepareLearnerDelivery({ ...data, questions: [{ ...data.questions[0], correctIndex: 2 }] }, events, parent, input, now), { code: 'DELIVERY_INVALID_QUESTION' });
  assert.throws(() => prepareLearnerDelivery({ ...data, plans: [...data.plans, ...Array.from({ length: 100 }, (_, index) => ({ ...data.plans[0], id: `p${index}`, ownerId: learner.id }))] }, events, parent, input, now), { code: 'PLAN_LIMIT' });
});

test('delivery accepts allowed public content and validates supplied project tags without inheriting private tags', () => {
  const { data, events } = fixture();
  const publicData = { ...data, topics: [{ ...data.topics[0], ownerId: undefined, planId: undefined, libraryPublished: true }],
    questions: data.questions.map(question => ({ ...question, ownerId: undefined, audienceUserId: undefined, planId: undefined })) };
  const prepared = prepareLearnerDelivery(publicData, events, parent, { ...input, tags: [' 2学期中間テスト ', '古文の復習'] }, now);
  assert.deepEqual(prepared.plan.tags, ['2学期中間テスト', '古文の復習']);
  assert.equal(prepared.topic.libraryPublished, undefined);
  assert.equal(prepared.plan.arrangedFromTopicId, undefined);
  assert.throws(() => prepareLearnerDelivery(data, events, parent, { ...input, tags: Array.from({ length: 8 }, (_, index) => `tag${index}`) }, now));
  assert.throws(() => prepareLearnerDelivery({ ...data, profiles: profiles.filter(profile => profile.id !== parent.id) }, events, parent, input, now), { code: 'DELIVERY_FORBIDDEN' });
});

test('large deliveries split into bounded existing events without exposing an incomplete set', () => {
  const { data, events } = fixture();
  const large = { ...data, questions: Array.from({ length: 300 }, (_, index) => ({ ...data.questions[0], id: `large-${index}`, prompt: `${index}問 ${'文'.repeat(3000)}` })) };
  const prepared = prepareLearnerDelivery(large, events, parent, input, now);
  assert.equal(prepared.deliveredCount, 300);
  assert.ok(prepared.questionEvents.length > 1);
  assert.ok(prepared.questionEvents.every(item => JSON.stringify(item.payload).length < 320_000));
  // The store retains the first event with each stable id. Overlapping requests reload it before later batches.
  const competing = prepareLearnerDelivery(large, events, parent, input, new Date('2026-10-24T00:00:00.000Z'));
  const firstBatchEvents = [...events, prepared.questionEvents[0], competing.questionEvents[0]];
  const loadedEvents = firstBatchEvents.filter((item, index, items) => items.findIndex(candidate => candidate.id === item.id) === index);
  const reserved = { ...large, questions: [...large.questions, ...foldEvents(loadedEvents, profiles).questions.filter(question => question.topicId === prepared.topic.id)] };
  const resumed = prepareLearnerDelivery(reserved, loadedEvents, parent, input, new Date('2026-10-25T00:00:00.000Z'));
  assert.deepEqual(resumed.questionEvents, prepared.questionEvents);
  const staged = foldEvents(prepared.questionEvents, profiles);
  assert.equal(studyDataForProfile(staged, learner).questions.length, 0);
  const completed = foldEvents([...prepared.questionEvents, ...prepared.completionEvents], profiles);
  assert.equal(studyDataForProfile(completed, learner).questions.length, 300);
});
