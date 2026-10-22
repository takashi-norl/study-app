import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { addDemoLibraryPlan, addDemoPlanningTurn, demoPracticeQuestions, demoSessionAllowed, demoSessionQuestions, demoStudyDataForProfile, generateDemoProposal, publishDemoLibrary, requestDemoLibraryPublication } from '../src/lib/demo-access';
import type { LearningPlan, StudyData } from '../src/lib/types';

const now = '2024-01-20T12:00:00.000Z';
function fixture() {
  let counter = 0;
  const id = () => `test-id-${++counter}`;
  let data = createDemoData(new Date(now));
  const parent = data.profiles.find(profile => profile.role === 'parent')!;
  const student = data.profiles.find(profile => profile.role === 'student')!;
  const plan: LearningPlan = { id: 'private-plan', ownerId: parent.id, title: '英語のテスト', subject: '英語', goal: '親だけで動作確認', difficulty: '標準',
    dailyQuestionTarget: 10, sourceIds: ['private-source'], version: 1, createdAt: now, updatedAt: now, testOnly: true };
  data = { ...data, plans: [...data.plans, plan], sources: [{ id: 'private-source', ownerId: parent.id, name: 'private-note.jpg', mimeType: 'image/jpeg', storagePath: 'private-drive-file', testOnly: true, createdAt: now }] };
  data = addDemoPlanningTurn(data, parent, plan.id, '親だけが見るコメント', now, id);
  const turn = data.planningTurns.at(-1)!;
  const result = generateDemoProposal(data, parent, plan.id, turn.id, turn.proposals![0].id, 100, now, id);
  return { data: result.data, parent, student, plan, topic: result.topic, id };
}

test('parent test plans, questions, sources, jobs and conversations stay absent from the student demo view', () => {
  const { data, parent, student, topic } = fixture();
  const questions = data.questions.filter(question => question.topicId === topic.id);
  const mixed: StudyData = { ...data, sessions: [{ id: 'mixed', userId: student.id, mode: 'daily', questionIds: [data.questions[0].id, questions[0].id], createdAt: now }],
    attempts: [{ id: 'parent-test-answer', userId: parent.id, sessionId: 'test', questionId: questions[0].id, questionVersion: 1, selectedIndex: 0, correct: true, answeredAt: now }] };
  const visible = demoStudyDataForProfile(mixed, student);
  assert.ok(!visible.topics.some(item => item.id === topic.id));
  assert.ok(visible.questions.every(item => !item.testOnly && item.correctIndex === -1));
  assert.ok(visible.plans.every(item => !item.testOnly));
  assert.ok(!visible.planningTurns.some(item => item.message === '親だけが見るコメント'));
  assert.equal(visible.sources.length, 0);
  assert.ok(visible.jobs.every(item => !item.testOnly));
  assert.equal(visible.sessions.length, 0);
  assert.equal(visible.attempts.length, 0);
  assert.equal(demoStudyDataForProfile(data, parent).questions.length, data.questions.length);
});

test('parent practice requires an explicit test topic and mixed or other-user sessions cannot resume', () => {
  const { data, parent, student, topic } = fixture();
  assert.ok(demoPracticeQuestions(data,parent).every(question=>question.testOnly));
  assert.throws(() => demoPracticeQuestions(data, parent, 'topic-english'), /ご自身/);
  const available = demoPracticeQuestions(data, parent, topic.id);
  assert.equal(available.length, 10);
  assert.ok(available.every(question => question.testOnly && question.topicId === topic.id));
  const session = { id: 'test-session', userId: parent.id, mode: 'daily' as const, questionIds: available.map(question => question.id), questionSnapshots: available, createdAt: now };
  assert.equal(demoSessionAllowed(session, available, parent), true);
  assert.equal(demoSessionAllowed({ ...session, userId: student.id }, available, parent), false);
  assert.equal(demoSessionAllowed({ ...session, questionIds: [...session.questionIds, 'topic-english-q01'] }, available, parent), false);
  assert.ok(!demoPracticeQuestions(data, student).some(question => question.testOnly));
  const edited = available.map((question, index) => index ? question : { ...question, version: question.version + 1, prompt: '更新した設問' });
  assert.equal(demoSessionAllowed(session, edited, parent), false);
  assert.equal(demoSessionQuestions(session, edited)[0].prompt, available[0].prompt);
  const legacySession = { ...session, questionSnapshots: undefined };
  assert.equal(demoSessionAllowed(legacySession, available, parent), false);
});

test('publishing makes an independent library clone without private source or conversation links and preserves the original', () => {
  const { data, parent, student, topic, id } = fixture();
  const before = JSON.stringify(data);
  const result = publishDemoLibrary(data, parent, topic.id, now, id);
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.topic.libraryPublished, true);
  assert.notEqual(result.topic.id, topic.id);
  const clones = result.data.questions.filter(question => question.topicId === result.topic.id);
  assert.equal(clones.length, 10);
  for (const question of clones) {
    assert.equal(question.testOnly, undefined);
    assert.equal(question.planId, undefined);
    assert.equal(question.audienceUserId, undefined);
    assert.deepEqual(question.sourceIds, []);
    assert.ok(!data.questions.some(original => original.id === question.id));
  }
  const visible = demoStudyDataForProfile(result.data, student);
  assert.equal(visible.topics.find(item => item.id === result.topic.id)?.librarySourceTopicId, undefined);
  assert.ok(!visible.questions.some(question => question.topicId === result.topic.id));
  assert.equal(publishDemoLibrary(result.data, parent, topic.id, now, id).topic.id, result.topic.id);
  const modified = { ...result.data, questions: result.data.questions.map(question => question.topicId === topic.id ? { ...question, prompt: `${question.prompt}（更新）`, version: question.version + 1 } : question) };
  const revision = publishDemoLibrary(modified, parent, topic.id, now, id);
  assert.notEqual(revision.topic.id, result.topic.id);
  assert.ok(revision.data.questions.filter(question => question.topicId === result.topic.id).every(question => !question.prompt.includes('（更新）')));
  assert.throws(() => publishDemoLibrary(data, student, topic.id), /管理者/);
  const otherParent = { ...parent, id: 'other-parent' };
  const familyData = { ...data, profiles: [...data.profiles, otherParent] };
  assert.equal(publishDemoLibrary(familyData, otherParent, topic.id, now, id).topic.libraryPublished, true);
  assert.throws(() => publishDemoLibrary(familyData, { ...otherParent, familyId: 'other-family' }, topic.id), /ご家族/);
});

test('library questions enter practice only after the learner adopts them; repeated adoption is idempotent', () => {
  const { data, parent, student, topic, id } = fixture();
  const published = publishDemoLibrary(data, parent, topic.id, now, id);
  assert.throws(()=>demoPracticeQuestions(published.data, student, published.topic.id),/追加済み/);
  const added = addDemoLibraryPlan(published.data, student, published.topic.id, now, id);
  assert.equal(added.plan.libraryTopicId, published.topic.id);
  assert.equal(added.plan.ownerId, student.id);
  assert.deepEqual(added.plan.sourceIds, []);
  assert.equal(demoPracticeQuestions(added.data, student, published.topic.id).length, 10);
  assert.equal(addDemoLibraryPlan(added.data, student, published.topic.id, now, id).plan.id, added.plan.id);
  assert.equal(addDemoLibraryPlan(published.data,parent,published.topic.id).plan.ownerId,parent.id);
  assert.throws(() => addDemoLibraryPlan(published.data, student, topic.id), /見つかりません/);
});

test('demo consultation and generation are labelled samples, bounded, and reject stale proposals', () => {
  const { data, parent, plan, topic, id } = fixture();
  const turn = data.planningTurns.at(-1)!;
  assert.match(turn.reply!, /AIには送信しておらず/);
  assert.match(turn.reply!, /内容には反映されません/);
  assert.equal(topic.targetCount, 10);
  assert.ok(data.questions.filter(question => question.topicId === topic.id).every(question => /サンプル/.test(question.sourceNote)));
  const updated = addDemoPlanningTurn(data, parent, plan.id, '追加のコメント', now, id);
  assert.throws(() => generateDemoProposal(updated, parent, plan.id, turn.id, turn.proposals![0].id, 10, now, id), /最新/);
});
