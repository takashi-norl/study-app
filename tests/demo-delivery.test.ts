import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverDemoTopic, demoPracticeQuestions, demoStudyDataForProfile } from '../src/lib/demo-access';
import type { LearningPlan, Profile, Question, StudyData, Topic } from '../src/lib/types';

const now = '2026-10-23T00:00:00.000Z';
const parent: Profile = { id: 'parent', familyId: 'family', name: '管理者', role: 'parent' };
const learner: Profile = { id: 'learner', familyId: 'family', name: '本人', role: 'student' };
const sibling: Profile = { id: 'sibling', familyId: 'family', name: '別の学習者', role: 'student' };
const input = { topicId: 'private-topic', learnerId: learner.id, requestId: '5f0a3c6f-a404-4a9c-bb79-0c89cdb2a628', projectName: ' 2学期中間テスト ' };
function fixture(): StudyData {
  const plan: LearningPlan = { id: 'private-plan', ownerId: parent.id, title: '私的な相談', subject: '古文', tags: ['秘密の分類'],
    goal: '秘密の計画', difficulty: '標準', dailyQuestionTarget: 10, sourceIds: ['secret-source'], version: 1, createdAt: now, updatedAt: now };
  const topic: Topic = { id: input.topicId, planId: plan.id, ownerId: parent.id, title: '古文単語26〜50', subject: '古文',
    description: '秘密の教材の説明', targetCount: 2, createdAt: now };
  const question: Question = { id: 'private-q1', topicId: topic.id, planId: plan.id, ownerId: parent.id,
    prompt: '「あまた」の意味は？', choices: ['たくさん', 'ひとつ'], correctIndex: 0, explanation: '数や量が多いことを表します。',
    learningPoint: '数量の古語', sourceIds: ['secret-source'], sourceNote: '秘密の写真の名前', status: 'draft', needsReview: true,
    version: 3, createdAt: now };
  return { plans: [plan], topics: [topic], questions: [question, { ...question, id: 'private-q2', status: 'archived', testOnly: true }],
    sources: [{ id: 'secret-source', ownerId: parent.id, name: '秘密の写真.jpg', mimeType: 'image/jpeg', storagePath: 'private-drive-id', createdAt: now }],
    planningTurns: [{ id: 'secret-turn', planId: plan.id, requestedBy: parent.id, version: 1, status: 'complete', message: '秘密の会話', createdAt: now }],
    profiles: [parent, learner, sibling], jobs: [], attempts: [], exposures: [], sessions: [] };
}

test('demo delivery creates a separate learner-owned set and includes neither source files nor private conversations', async () => {
  const data = fixture();
  const before = structuredClone(data);
  const result = await deliverDemoTopic(data, parent, input, now);
  assert.deepEqual(data, before);
  assert.deepEqual(result.plan.tags, ['2学期中間テスト']);
  assert.equal(result.plan.ownerId, learner.id);
  assert.equal(result.topic.audienceUserId, learner.id);
  assert.equal(result.topic.planId, result.plan.id);
  assert.equal(result.deliveredCount, 1, 'archived questions are not copied');
  const copied = result.data.questions.filter(question => question.topicId === result.topic.id);
  assert.equal(copied[0].ownerId, learner.id);
  assert.equal(copied[0].audienceUserId, learner.id);
  assert.equal(copied[0].planId, result.plan.id);
  assert.equal(copied[0].status, 'published');
  assert.equal(copied[0].needsReview, true);
  assert.deepEqual(copied[0].sourceIds, []);
  assert.equal(copied[0].correctIndex, data.questions[0].correctIndex);
  assert.equal(copied[0].version, 1);
  assert.doesNotMatch(JSON.stringify([result.plan, result.topic, copied]), /秘密|secret-|private-|private-drive-id/);
  assert.deepEqual(result.data.sources, data.sources);
  assert.deepEqual(result.data.planningTurns, data.planningTurns);
  copied[0].choices[0] = '別の選択肢';
  assert.equal(data.questions[0].choices[0], 'たくさん');
  assert.equal(demoPracticeQuestions(result.data, learner, result.topic.id).length, 1);
  const visible = demoStudyDataForProfile(result.data, learner);
  assert.ok(visible.plans.some(plan => plan.id === result.plan.id));
  assert.equal(visible.questions.find(question => question.topicId === result.topic.id)?.correctIndex, -1);
  assert.equal(visible.sources.length, 0);
  assert.equal(visible.planningTurns.length, 0);
  assert.ok(!demoStudyDataForProfile(result.data, sibling).topics.some(topic => topic.id === result.topic.id));
  assert.throws(() => demoPracticeQuestions(result.data, sibling, result.topic.id));
});

test('demo delivery retries reuse the copy after source changes and reject reusing a request for different input', async () => {
  const first = await deliverDemoTopic(fixture(), parent, input, now);
  const changed = { ...first.data, questions: first.data.questions.map(question => question.topicId === input.topicId ? { ...question, prompt: '変更済み' } : question) };
  const repeated = await deliverDemoTopic(changed, parent, { ...input, projectName: input.projectName.trim() }, now);
  assert.equal(repeated.plan.id, first.plan.id);
  assert.equal(repeated.data.plans.length, first.data.plans.length);
  assert.equal(repeated.data.questions.length, first.data.questions.length);
  assert.equal(repeated.data.questions.find(question => question.topicId === first.topic.id)?.prompt, '「あまた」の意味は？');
  for (const changes of [{ projectName: '期末テスト' }, { learnerId: sibling.id }, { topicId: 'another-source' }]) {
    await assert.rejects(deliverDemoTopic(first.data, parent, { ...input, ...changes }, now), /別の追加/);
  }
});

test('demo delivery requires an active family administrator and a registered learner', async () => {
  const data = fixture();
  for (const actor of [learner, { ...parent, id: 'missing' }, { ...parent, familyId: 'foreign' }]) {
    await assert.rejects(deliverDemoTopic(data, actor, input, now), /管理者/);
  }
  for (const learnerId of ['missing', parent.id]) await assert.rejects(deliverDemoTopic(data, parent, { ...input, learnerId }, now), /管理者/);
  await assert.rejects(deliverDemoTopic({ ...data, profiles: [parent, { ...learner, familyId: 'foreign' }] }, parent, input, now));
  await assert.rejects(deliverDemoTopic({ ...data, plans: [{ ...data.plans[0], ownerId: 'outsider' }] }, parent, input, now), /ご家族/);
});

test('demo delivery rejects test-only, unfinished, invalid and oversized source sets', async () => {
  const data = fixture();
  const cases: StudyData[] = [
    { ...data, topics: [{ ...data.topics[0], testOnly: true }] },
    { ...data, plans: [{ ...data.plans[0], testOnly: true }] },
    { ...data, questions: [{ ...data.questions[0], testOnly: true }] },
    { ...data, questions: [{ ...data.questions[0], correctIndex: 2 }] },
    { ...data, questions: [{ ...data.questions[0], ownerId: 'outsider' }] },
    { ...data, questions: [{ ...data.questions[0], choices: ['たくさん', ' たくさん '] }] },
    { ...data, questions: [] },
    { ...data, questions: Array.from({ length: 301 }, (_, index) => ({ ...data.questions[0], id: `q-${index}` })) },
    { ...data, plans: [...data.plans, ...Array.from({ length: 100 }, (_, index) => ({ ...data.plans[0], id: `p-${index}`, ownerId: learner.id }))] },
  ];
  for (const status of ['queued', 'running'] as const) cases.push({ ...data, jobs: [{ id: 'job', topicId: input.topicId, status, targetCount: 10, generatedCount: 1, createdAt: now }] });
  for (const value of cases) await assert.rejects(deliverDemoTopic(value, parent, input, now));
  await assert.rejects(deliverDemoTopic(data, parent, { ...input, projectName: ' ' }, now));
  await assert.rejects(deliverDemoTopic(data, parent, { ...input, projectName: '名'.repeat(41) }, now));
  await assert.rejects(deliverDemoTopic(data, parent, { ...input, requestId: 'invalid' }, now));
});

test('a public demo set is copied without following its private source origin', async () => {
  const data = fixture();
  const publicTopic = { ...data.topics[0], planId: undefined, ownerId: undefined, libraryPublished: true, librarySourceTopicId: 'private-origin' };
  const result = await deliverDemoTopic({ ...data, topics: [publicTopic], plans: [{ ...data.plans[0], testOnly: true }],
    questions: data.questions.map(question => ({ ...question, planId: undefined, ownerId: undefined })) }, parent, { ...input, projectName: undefined }, now);
  assert.deepEqual(result.plan.tags, []);
  assert.deepEqual(result.plan.sourceIds, []);
  assert.equal(result.plan.arrangedFromTopicId, undefined);
  assert.equal(result.plan.libraryTopicId, undefined);
  assert.equal(result.topic.librarySourceTopicId, undefined);
  assert.doesNotMatch(JSON.stringify([result.plan, result.topic]), /秘密|private-origin|secret-/);
});
