import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { learningProjects, parsePlanTags, planTagsError } from '../src/lib/learning-projects';
import type { Attempt, LearningPlan } from '../src/lib/types';

const now = new Date('2026-10-23T12:00:00+09:00');
const timestamp = '2026-10-01T12:00:00+09:00';
function plan(id: string, patch: Partial<LearningPlan> = {}): LearningPlan {
  return { id, ownerId: 'student-demo', title: id, subject: '英語', goal: '復習する', difficulty: '標準', dailyQuestionTarget: 10,
    sourceIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp, ...patch };
}
function attempt(questionId: string, id: string, correct: boolean, patch: Partial<Attempt> = {}): Attempt {
  return { id, questionId, userId: 'student-demo', questionVersion: 1, sessionId: 'session', selectedIndex: 0,
    correct, answeredAt: timestamp, ...patch };
}

test('tag input trims and deduplicates labels, supports Japanese separators and validates without truncating', () => {
  assert.deepEqual(parsePlanTags(' 中間テスト, 英語、 中間テスト， 数学\n'), ['中間テスト', '英語', '数学']);
  assert.deepEqual(parsePlanTags(' ,  、'), []);
  assert.equal(planTagsError(['あ'.repeat(40)]), null);
  assert.ok(planTagsError(['あ'.repeat(41)]));
  assert.ok(planTagsError(Array.from({ length: 9 }, (_, i) => `tag${i}`)));
});

test('groups include only own non-test plans and retain ungenerated plans with no invented progress', () => {
  const data = createDemoData(now);
  data.plans = [plan('own', { tags: ['中間テスト', '英語'] }), plan('empty'), plan('other', { ownerId: 'someone-else', tags: ['秘密'] }), plan('test', { testOnly: true, tags: ['テスト'] })];
  const result = learningProjects(data, 'student-demo', now);
  assert.deepEqual(result.plans.map(item => item.plan.id).sort(), ['empty', 'own']);
  assert.deepEqual(result.groups.map(group => group.label).sort(), ['すべて', '中間テスト', '未分類', '英語'].sort());
  assert.deepEqual(result.groups.find(group => group.id === 'untagged')?.plans.map(item => item.plan.id), ['empty']);
  assert.deepEqual(result.groups[0].progress, { total: 0, answered: 0, percent: null, firstAccuracy: null, due: 0 });
});

test('plan progress excludes other owners, audiences, tests, archived questions and unadopted public sets', () => {
  const data = createDemoData(now);
  const original = data.questions[0];
  const topic = data.topics[0];
  data.plans = [plan('own', { tags: ['中間テスト'] }), plan('other-plan', { ownerId: 'another' }), plan('test-plan', { testOnly: true })];
  data.topics = [
    { ...topic, id: 'own-topic', planId: 'own' },
    { ...topic, id: 'other-topic', ownerId: 'another', planId: 'other-plan' },
    { ...topic, id: 'public-topic', ownerId: undefined, planId: undefined, libraryPublished: true },
    { ...topic, id: 'test-topic', testOnly: true, planId: 'own' },
    { ...topic, id: 'legacy-test', planId: 'test-plan' },
  ];
  data.questions = [
    { ...original, id: 'ready', topicId: 'own-topic', status: 'draft' },
    { ...original, id: 'archive', topicId: 'own-topic', status: 'archived' },
    { ...original, id: 'private-other', topicId: 'other-topic', planId: 'own' },
    { ...original, id: 'owner-other', topicId: 'own-topic', ownerId: 'another' },
    { ...original, id: 'audience-other', topicId: 'own-topic', audienceUserId: 'another' },
    { ...original, id: 'public', topicId: 'public-topic', planId: 'own' },
    { ...original, id: 'test-question', topicId: 'own-topic', testOnly: true },
    { ...original, id: 'test-topic-question', topicId: 'test-topic' },
    { ...original, id: 'legacy-test-question', topicId: 'legacy-test', planId: 'own' },
    { ...original, id: 'test-plan-question', topicId: 'own-topic', planId: 'test-plan' },
  ];
  const result = learningProjects(data, 'student-demo', now);
  assert.deepEqual(result.plans[0].questions.map(question => question.id), ['ready']);
  assert.equal(result.groups[0].progress.total, 1);
});

test('shared topic linked by multiple plans is counted once per group and repeat answers do not inflate completion', () => {
  const data = createDemoData(now);
  const original = data.questions[0];
  data.plans = [plan('one', { libraryTopicId: 'public', tags: ['中間テスト'] }), plan('two', { libraryTopicId: 'public', tags: ['中間テスト', '英語'] })];
  data.topics = [{ ...data.topics[0], id: 'public', libraryPublished: true, ownerId: undefined }];
  data.questions = [
    { ...original, id: 'q1', topicId: 'public' }, { ...original, id: 'q2', topicId: 'public' },
    { ...original, id: 'q2', topicId: 'public' },
  ];
  data.attempts = [
    attempt('q1', 'first', false), attempt('q1', 'retry', true, { answeredAt: '2026-10-02T12:00:00+09:00' }),
    attempt('q2', 'other-user', true, { userId: 'someone-else' }),
    attempt('q2', 'future', true, { answeredAt: '2026-10-24T12:00:00+09:00' }),
  ];
  const result = learningProjects(data, 'student-demo', now);
  const project = result.groups.find(group => group.label === '中間テスト')!;
  assert.equal(project.plans.length, 2);
  assert.deepEqual(project.progress, { total: 2, answered: 1, percent: 50, firstAccuracy: 0, due: 1 });
  assert.equal(result.groups[0].progress.total, 2);
  assert.equal(result.plans[0].progress.total, 2);
  assert.deepEqual(result.plans[0].topicIds, ['public']);
});

test('group progress combines disjoint plans without including unassociated legacy questions', () => {
  const data = createDemoData(now);
  const original = data.questions[0];
  const topic = data.topics[0];
  data.plans = [plan('one', { tags: ['中間テスト'] }), plan('two', { tags: ['中間テスト'] })];
  data.topics = [{ ...topic, id: 't1', planId: 'one' }, { ...topic, id: 't2', planId: 'two' }, { ...topic, id: 'legacy' }];
  data.questions = [{ ...original, id: 'q1', topicId: 't1' }, { ...original, id: 'q2', topicId: 't2' }, { ...original, id: 'legacy-q', topicId: 'legacy' }];
  data.attempts = [attempt('q1', 'a', true), attempt('q2', 'b', false)];
  const project = learningProjects(data, 'student-demo', now).groups.find(group => group.label === '中間テスト')!;
  assert.equal(project.progress.total, 2);
  assert.equal(project.progress.answered, 2);
  assert.equal(project.progress.percent, 100);
  assert.equal(project.progress.firstAccuracy, .5);
});
