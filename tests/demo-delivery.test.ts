import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { deliverDemoTopic, demoStudyDataForProfile } from '../src/lib/demo-access';

const input = { topicId: 'topic-kobun', learnerId: 'student-demo', requestId: '5f0a3c6f-a404-4a9c-bb79-0c89cdb2a628', projectName: '2学期中間テスト' };

test('delivery is disabled for every account, including previously valid delivery requests', async () => {
  const data = createDemoData();
  const before = structuredClone(data);
  for (const actor of [...data.profiles, { ...data.profiles[0], accessLevel: 'superuser' as const }]) {
    await assert.rejects(deliverDemoTopic(data, actor, input), /公開・共有・配布は利用できません/);
    await assert.rejects(deliverDemoTopic(data, actor, { ...input, requestId: 'invalid' }), /公開・共有・配布は利用できません/);
  }
  assert.deepEqual(data, before);
});

test('closing delivery preserves existing learner-owned copies while hiding them from another account', () => {
  const data = createDemoData();
  const student = data.profiles[0];
  const operator = { ...student, id: 'operator', name: '運営者', accessLevel: 'superuser' as const };
  const topic = { ...data.topics[0], id: 'previously-delivered', planId: undefined, ownerId: student.id, audienceUserId: student.id };
  const question = { ...data.questions[0], id: 'delivered-question', topicId: topic.id, ownerId: student.id, audienceUserId: student.id, planId: undefined };
  const saved = { ...data, profiles: [...data.profiles, operator], topics: [...data.topics, topic], questions: [...data.questions, question] };
  assert.ok(demoStudyDataForProfile(saved, student).questions.some(item => item.id === question.id));
  assert.ok(!demoStudyDataForProfile(saved, operator).questions.some(item => item.id === question.id));
  assert.ok(saved.questions.some(item => item.id === question.id));
});
