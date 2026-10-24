import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData, normalizeDemoProfiles } from '../src/lib/demo-data';
import { demoStudyDataForProfile } from '../src/lib/demo-access';

test('demo contains one learner account and browser-saved profiles cannot grant an operational capability', () => {
  const data = createDemoData();
  assert.equal(data.profiles.length, 1);
  assert.equal(data.profiles[0].accessLevel, 'learner');
  const saved = { ...data, profiles: [
    { ...data.profiles[0], id: 'another-account', name: '保存された別の人', accessLevel: 'superuser' as const },
    { ...data.profiles[0], role: 'obsolete-value', accessLevel: 'superuser' as const },
  ] };
  const before = structuredClone(saved);
  const restored = normalizeDemoProfiles(saved);
  assert.deepEqual(restored.profiles, data.profiles);
  assert.deepEqual(saved, before);
  assert.equal(restored.questions, saved.questions);
  assert.equal(restored.attempts, saved.attempts);
  assert.equal(restored.plans, saved.plans);
  assert.equal(restored.profiles[0].id, 'student-demo', 'existing ownership is retained');
  restored.profiles[0].name = '表示名を変更';
  assert.equal(createDemoData().profiles[0].name, '学習者', 'the canonical profile is not a mutable singleton');
});

test('restoring a demo retains owned work but never borrows another saved account’s private materials', () => {
  const data = createDemoData();
  const foreignTopic = { ...data.topics[0], id: 'foreign-topic', ownerId: 'other', planId: undefined };
  const foreignQuestion = { ...data.questions[0], id: 'foreign-question', topicId: foreignTopic.id, ownerId: 'other' };
  const saved = { ...data, profiles: [], topics: [...data.topics, foreignTopic], questions: [...data.questions, foreignQuestion] };
  const restored = normalizeDemoProfiles(saved);
  const visible = demoStudyDataForProfile(restored, restored.profiles[0]);
  assert.ok(visible.questions.some(question => question.id === data.questions[0].id));
  assert.ok(!visible.topics.some(topic => topic.id === foreignTopic.id));
  assert.ok(!visible.questions.some(question => question.id === foreignQuestion.id));
  assert.ok(restored.questions.some(question => question.id === foreignQuestion.id), 'restoring does not delete stored work');
});
