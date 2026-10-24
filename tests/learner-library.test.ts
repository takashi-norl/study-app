import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { learnerQuestions } from '../src/lib/learner-library';

test('learning collection excludes tests, other learners, and unadopted library content', () => {
  const data = createDemoData();
  const original = data.questions[0];
  const topic = data.topics[0];
  data.topics.push({ ...topic, id: 'test', testOnly: true }, { ...topic, id: 'library', libraryPublished: true }, { ...topic, id: 'private', ownerId:'another', audienceUserId: 'another' });
  data.questions.push({ ...original, id: 'test-q', topicId: 'test', testOnly: true }, { ...original, id: 'library-q', topicId: 'library' }, { ...original, id: 'private-q', topicId: 'private', audienceUserId: 'another' });
  const before = learnerQuestions(data, 'student-demo').map(question => question.id);
  assert.ok(before.includes(original.id));
  assert.ok(!before.includes('test-q'));
  assert.ok(!before.includes('private-q'));
  assert.ok(!before.includes('library-q'));
  data.plans.push({ id: 'plan', ownerId: 'student-demo', title: 'Added', subject: '英語', goal: 'Practice', difficulty: '標準', dailyQuestionTarget: 10, sourceIds: [], version: 1, createdAt: topic.createdAt, updatedAt: topic.createdAt, libraryTopicId: 'library' });
  const after = learnerQuestions(data, 'student-demo').map(question => question.id);
  assert.ok(after.includes('library-q'));
  assert.ok(!learnerQuestions(data, 'another').some(question => question.id === 'library-q'));
});
