import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, Profile, Question, StudyData, Topic } from '../../src/lib/types';
import { normalizePlanTags } from '../../src/lib/plan-organization';
import { createPlanSchema } from '../../src/server/planning';
import { preparePlanArrangement } from '../../src/server/plan-arrangement';
import { prepareLibraryAdoption } from '../../src/server/library';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { getWorkspaceId } from '../../src/server/env';

const now = new Date('2026-10-23T12:00:00.000Z');
const time = now.toISOString();
const operator: Profile = { id: 'operator', name: '運営者', workspaceId: getWorkspaceId(),  accessLevel: 'superuser' };
const student: Profile = { ...operator, id: 'student', name: '学習者',  accessLevel: 'learner' };
const other: Profile = { ...student, id: 'other', name: '別の学習者' };
const plan: LearningPlan = { id: 'kobun-plan', ownerId: student.id, title: '古文の文脈', subject: '古文', tags: ['2学期中間テスト'],
  goal: '本文から意味を考える', difficulty: '標準', dailyQuestionTarget: 10, sourceIds: [], version: 3, createdAt: time, updatedAt: time };
const topic: Topic = { id: 'kobun-set', title: '本文の意味を確認', subject: '古文', description: '会話から作成', planId: plan.id,
  ownerId: student.id, audienceUserId: student.id, targetCount: 1, createdAt: time };
const question: Question = { id: 'kobun-question', topicId: topic.id, prompt: '本文の語句の意味を選びなさい。', choices: ['意味A', '意味B', '意味C', '意味D'],
  correctIndex: 0, explanation: '本文の前後関係から意味Aと判断します。', learningPoint: '文脈', sourceIds: [], sourceNote: '自作例文',
  status: 'draft', needsReview: false, version: 1, ownerId: student.id, audienceUserId: student.id, planId: plan.id, createdAt: time };
function fixture(): StudyData {
  return structuredClone({ profiles: [operator, student, other], plans: [plan], topics: [topic], questions: [question],
    sources: [], jobs: [], planningTurns: [], attempts: [], exposures: [], sessions: [] });
}
function publicFixture(): StudyData {
  const data = fixture();
  data.plans[0].tags = ['PRIVATE_ORIGIN_PROJECT'];
  data.topics.push({ id: 'public-set', title: '公開された古文の問題', subject: '古文', description: '公開版', targetCount: 1,
    createdAt: time, libraryPublished: true, librarySourceTopicId: topic.id });
  data.questions.push({ ...question, id: 'public-question', topicId: 'public-set', planId: undefined, ownerId: undefined,
    audienceUserId: undefined, sourceIds: [], sourceNote: '公開版', status: 'published', publishedAt: time });
  return data;
}

test('plan creation accepts normalized project tags without consuming the goal or message budget', () => {
  const input = { subject: '古文', goal: '目'.repeat(4000), tags: [' 2学期中間テスト ', '2学期中間テスト'] };
  const parsed = createPlanSchema.parse(input);
  assert.deepEqual(parsed.tags, ['2学期中間テスト']);
  assert.equal(parsed.goal.length, 4000);
  assert.equal(createPlanSchema.parse({ subject: '古文', goal: '本文を読む' }).tags, undefined);
  assert.deepEqual(createPlanSchema.parse({ ...input, tags: [] }).tags, []);
  const created: LearningPlan = { ...parsed, id: 'created', ownerId: student.id, title: '古文', version: 1, createdAt: time, updatedAt: time };
  const event: StudyEvent = { id: 'create-project-plan', type: 'plan.created', actorId: student.id, createdAt: time, payload: created };
  assert.deepEqual(foldEvents([event], [student]).plans[0].tags, ['2学期中間テスト']);
  for (const tags of [[''], ['  '], ['字'.repeat(41)], Array.from({ length: 9 }, (_, i) => `タグ${i}`), Array(65).fill('試験'), '試験', null, [4]]) {
    assert.equal(createPlanSchema.safeParse({ ...input, tags }).success, false);
    assert.throws(() => normalizePlanTags(tags));
  }
  for (const tags of [[], ['試験'], [' 試験 ', '試験'], Array(64).fill('試験'), ['字'.repeat(40)]]) {
    assert.deepEqual(createPlanSchema.parse({ ...input, tags }).tags, normalizePlanTags(tags));
  }
});

test('a private arrangement inherits only its caller-owned plan tags and keeps originals independent', () => {
  const data = fixture();
  const before = structuredClone(data);
  const own = preparePlanArrangement(data, student, topic.id, 'own-arrangement', now);
  assert.deepEqual(own.plan.tags, ['2学期中間テスト']);
  assert.equal(own.plan.subject, '古文');
  assert.equal(own.plan.version, 1);
  own.plan.tags!.push('新しい範囲');
  assert.deepEqual(data, before);
  assert.throws(() => preparePlanArrangement(data, operator, topic.id, 'admin-arrangement', now), { code: 'TOPIC_NOT_FOUND' });
  assert.throws(() => preparePlanArrangement(data, other, topic.id, 'forbidden', now), { code: 'TOPIC_NOT_FOUND' });
  const saved = { ...data, plans: [...data.plans, own.plan] };
  const replay = preparePlanArrangement(saved, student, topic.id, own.plan.id, now);
  assert.deepEqual(replay.plan.tags, own.plan.tags);
  assert.equal(replay.event, undefined);
});

test('closed public libraries cannot be adopted or arranged by any account', () => {
  const data = publicFixture();
  for (const caller of [student, operator, other]) {
    assert.throws(() => prepareLibraryAdoption(data, caller, 'public-set', now), { code: 'SHARING_DISABLED' });
    assert.throws(() => preparePlanArrangement(data, caller, 'public-set', `denied-${caller.id}`, now), { code: 'TOPIC_NOT_FOUND' });
  }
});

test('test plans keep project inheritance inside the administrator’s own test scope', () => {
  const data = fixture();
  data.plans[0] = { ...data.plans[0], ownerId: operator.id, testOnly: true, tags: ['管理者の確認用'] };
  data.topics[0] = { ...data.topics[0], ownerId: operator.id, audienceUserId: operator.id, testOnly: true };
  data.questions[0] = { ...data.questions[0], ownerId: operator.id, audienceUserId: operator.id, testOnly: true };
  const arranged = preparePlanArrangement(data, operator, topic.id, 'test-arrangement', now).plan;
  assert.deepEqual(arranged.tags, ['管理者の確認用']);
  assert.equal(arranged.testOnly, true);
  assert.throws(() => preparePlanArrangement(data, student, topic.id, 'student-test', now), { code: 'TOPIC_NOT_FOUND' });
});

test('an operator with a learning account retains only their own test-plan tags', () => {
  const data = fixture();
  data.profiles[0] = operator;
  data.plans[0] = { ...data.plans[0], ownerId: operator.id, testOnly: true, tags: ['自分の試作'] };
  data.topics[0] = { ...data.topics[0], ownerId: operator.id, audienceUserId: operator.id, testOnly: true };
  data.questions[0] = { ...data.questions[0], ownerId: operator.id, audienceUserId: operator.id, testOnly: true };
  const arranged = preparePlanArrangement(data, operator, topic.id, 'learner-operator-arrangement', now).plan;
  assert.deepEqual(arranged.tags, ['自分の試作']);
  assert.equal(arranged.ownerId, operator.id);
  assert.equal(arranged.testOnly, true);
  assert.throws(() => preparePlanArrangement(data, student, topic.id, 'different-learner', now), { code: 'TOPIC_NOT_FOUND' });
});

test('a bounded scope goal preserves existing private approved instructions verbatim', () => {
  const data = fixture();
  data.topics[0].title = '題'.repeat(10000);
  data.topics[0].description = '説'.repeat(10000);
  data.questions.push(...Array.from({ length: 300 }, (_, index) => ({ ...question, id: `scope-${index}`, learningPoint: `項目${index}${'点'.repeat(400)}` })));
  const approvedInstructions = '既存の承認済み条件'.repeat(400).slice(0, 4000);
  data.jobs.push({ id: 'private-job', requestedBy: student.id, topicId: topic.id, status: 'review', targetCount: 1, generatedCount: 1,
    createdAt: time, approvedInstructions, instructions: '以前の条件' });
  const result = preparePlanArrangement(data, student, topic.id, 'private-wide-scope', now).plan;
  assert.equal(result.arrangementInstructions, approvedInstructions);
  assert.ok(result.arrangementInstructions.length <= 4000);
  assert.ok(result.goal.length <= 4000);
  assert.doesNotThrow(() => createPlanSchema.parse(result));
});
