import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { addDemoLibraryPlan, addDemoPlanningTurn, arrangeDemoTopic, demoPracticeQuestionView, demoPracticeQuestions, demoSessionAllowed, demoSessionQuestions, demoStudyDataForProfile, generateDemoProposal, publishDemoLibrary, requestDemoLibraryPublication, updateDemoQuestion } from '../src/lib/demo-access';
import type { LearningPlan, StudyData } from '../src/lib/types';

const now = '2024-01-20T12:00:00.000Z';
function fixture() {
  let counter = 0;
  const id = () => `test-id-${++counter}`;
  let data = createDemoData(new Date(now));
  const student = data.profiles[0];
  const operator = { ...student, id: 'operator', name: '運営者', accessLevel: 'superuser' as const };
  data = { ...data, profiles: [...data.profiles, operator] };
  const plan: LearningPlan = { id: 'private-plan', ownerId: operator.id, title: '自分の試作', subject: '英語', goal: '自分で動作確認', difficulty: '標準',
    dailyQuestionTarget: 10, sourceIds: ['private-source'], version: 1, createdAt: now, updatedAt: now, testOnly: true };
  data = { ...data, plans: [...data.plans, plan], sources: [{ id: 'private-source', ownerId: operator.id, name: 'private-note.jpg', mimeType: 'image/jpeg', storagePath: 'private-drive-file', testOnly: true, createdAt: now }] };
  data = addDemoPlanningTurn(data, operator, plan.id, '本人だけのコメント', now, id);
  const turn = data.planningTurns.at(-1)!;
  const result = generateDemoProposal(data, operator, plan.id, turn.id, turn.proposals![0].id, 100, now, id, { approveSamples: true });
  return { data: result.data, operator, student, plan, topic: result.topic, id };
}

test('every account sees only its own profiles, content, sources and records, while editing keeps full answers', () => {
  const { data, operator, student, topic } = fixture();
  const ownQuestion = data.questions.find(question => question.topicId === topic.id)!;
  const mixed: StudyData = { ...data,
    sessions: [{ id: 'mixed', userId: student.id, mode: 'daily', questionIds: [data.questions[0].id, ownQuestion.id], createdAt: now }],
    attempts: [{ id: 'operator-answer', userId: operator.id, sessionId: 'test', questionId: ownQuestion.id, questionVersion: 1, selectedIndex: 0, correct: true, answeredAt: now }] };
  for (const actor of [student, operator, { ...operator, accessLevel: 'superuser' as const }]) {
    const view = demoStudyDataForProfile(mixed, actor);
    assert.deepEqual(view.profiles.map(member => member.id), [actor.id]);
    assert.ok(view.topics.every(item => item.ownerId === actor.id && !item.libraryPublished));
    assert.ok(view.questions.every(item => item.ownerId === actor.id && item.correctIndex >= 0 && item.explanation));
    assert.ok(view.plans.every(item => item.ownerId === actor.id));
    assert.ok(view.planningTurns.every(item => item.requestedBy === actor.id));
    assert.ok(view.sources.every(item => item.ownerId === actor.id));
    assert.ok(view.jobs.every(item => item.requestedBy === actor.id));
    assert.ok(view.attempts.every(item => item.userId === actor.id));
    assert.equal(view.sessions.length, 0, 'a mixed-user session is not projected');
  }
  assert.equal(demoStudyDataForProfile(mixed, student).sources.length, 0);
  assert.equal(demoStudyDataForProfile(mixed, operator).sources[0].name, 'private-note.jpg');
  assert.equal(demoStudyDataForProfile(mixed, operator).questions.length, 100);
  assert.ok(demoStudyDataForProfile(mixed, student).questions.some(item => item.status === 'draft'), 'review state is not converted to published');
});

test('legacy public copies, adopted public topics and unknown ownership fail closed for every account', () => {
  const { data, operator, student, topic } = fixture();
  const publicTopic = { ...topic, id: 'legacy-public', planId: undefined, ownerId: undefined, testOnly: undefined, libraryPublished: true, librarySourceTopicId: topic.id };
  const orphan = { ...topic, id: 'orphan', planId: undefined, ownerId: undefined, audienceUserId: undefined };
  const extended = { ...data, topics: [...data.topics, publicTopic, orphan], questions: [...data.questions,
    { ...data.questions[0], id: 'public-q', topicId: publicTopic.id, ownerId: undefined },
    { ...data.questions[0], id: 'orphan-q', topicId: orphan.id, ownerId: undefined }],
    plans: [...data.plans, { ...data.plans[0], id: 'adopted', ownerId: student.id, libraryTopicId: publicTopic.id }] };
  for (const profile of [operator, student]) {
    const visible = demoStudyDataForProfile(extended, profile);
    assert.ok(!visible.topics.some(item => [publicTopic.id, orphan.id].includes(item.id)));
    assert.ok(!visible.questions.some(item => ['public-q', 'orphan-q'].includes(item.id)));
    assert.throws(() => demoPracticeQuestions(extended, profile, publicTopic.id), /ご自身/);
    assert.throws(() => arrangeDemoTopic(extended, profile, publicTopic.id), /利用できる/);
  }
});

test('test-only operations require superuser capability even for the owner', () => {
  const { data, operator, plan, topic, id } = fixture();
  const ordinary = { ...operator, accessLevel: undefined };
  const view = demoStudyDataForProfile(data, ordinary);
  for (const items of [view.plans, view.topics, view.questions, view.sources, view.jobs]) assert.equal(items.length, 0);
  assert.throws(() => demoPracticeQuestions(data, ordinary, topic.id), /ご自身/);
  assert.throws(() => addDemoPlanningTurn(data, ordinary, plan.id, '試作', now, id), /ご自身/);
  assert.throws(() => arrangeDemoTopic(data, ordinary, topic.id, now, id), /利用できる/);
  assert.equal(demoStudyDataForProfile(data, operator).questions.length, 100);
});

test('learners and operators both practice their own questions, while other owners and stale snapshots cannot resume', () => {
  const { data, operator, student, topic } = fixture();
  assert.throws(() => demoPracticeQuestions(data, operator, 'topic-english'), /ご自身/);
  const available = demoPracticeQuestions(data, operator, topic.id);
  const session = { id: 'test-session', userId: operator.id, mode: 'daily' as const, questionIds: available.map(question => question.id), questionSnapshots: available, createdAt: now };
  assert.equal(demoSessionAllowed(session, available, operator), true);
  assert.equal(demoSessionAllowed({ ...session, userId: student.id }, available, operator), false);
  assert.equal(demoSessionAllowed({ ...session, questionIds: [...session.questionIds, 'topic-english-q01'] }, available, operator), false);
  const edited = available.map((question, index) => index ? question : { ...question, version: question.version + 1, prompt: '更新した設問' });
  assert.equal(demoSessionAllowed(session, edited, operator), false);
  assert.equal(demoSessionQuestions(session, edited)[0].prompt, available[0].prompt);
  const legacy = { ...session, questionSnapshots: undefined };
  assert.equal(demoSessionAllowed(legacy, available, operator), false);
  const repeated = { ...session, questionSnapshots: available.map(() => available[0]) };
  assert.equal(demoSessionAllowed(repeated, available, operator), false);
  const ordinary = { ...data, topics: data.topics.map(item => item.id === topic.id ? { ...item, testOnly: false } : item),
    plans: data.plans.map(item => item.id === topic.planId ? { ...item, testOnly: false } : item),
    questions: data.questions.map(item => item.topicId === topic.id ? { ...item, testOnly: false } : item) };
  assert.equal(demoPracticeQuestions(ordinary, operator, topic.id).length, 100);
  assert.ok(demoPracticeQuestions(data, student).length > 0, 'initial student samples remain available');
});

test('practice hides the answer and evidence until accepted feedback without changing the editable original', () => {
  const question = createDemoData(new Date(now)).questions[0];
  const before = structuredClone(question);
  const hidden = demoPracticeQuestionView(question, false);
  assert.equal(hidden.correctIndex, -1); assert.equal(hidden.explanation, ''); assert.equal(hidden.learningPoint, '');
  assert.deepEqual(hidden.sourceIds, []); assert.equal(hidden.sourceNote, '');
  const answered = demoPracticeQuestionView(question, true);
  assert.equal(answered.correctIndex, question.correctIndex); assert.equal(answered.explanation, question.explanation);
  assert.deepEqual(question, before);
});

test('owners may edit, archive and restore their questions, with immutable ownership and validated choices', () => {
  const { data, operator, student } = fixture();
  const question = data.questions[0];
  const before = structuredClone(data);
  assert.throws(() => updateDemoQuestion(data, operator, question.id, { prompt: '他人の問題' }), /自分/);
  const changed = updateDemoQuestion(data, student, question.id, { prompt: '自分で直した問題', ownerId: operator.id, sourceIds: ['private-source'],
    topicId: 'other', audienceUserId: operator.id, status: 'archived' }, now);
  const saved = changed.questions.find(item => item.id === question.id)!;
  assert.equal(saved.topicId, question.topicId); assert.equal(saved.audienceUserId, question.audienceUserId);
  assert.equal(saved.ownerId, question.ownerId); assert.deepEqual(saved.sourceIds, question.sourceIds);
  assert.equal(saved.status, 'archived'); assert.equal(saved.version, question.version + 1);
  assert.ok(demoStudyDataForProfile(changed, student).questions.some(item => item.id === question.id));
  assert.ok(!demoPracticeQuestions(changed, student).some(item => item.id === question.id));
  const restored = updateDemoQuestion(changed, student, question.id, { status: 'approved', needsReview: false }, now);
  assert.ok(demoPracticeQuestions(restored, student).some(item => item.id === question.id));
  assert.throws(() => updateDemoQuestion(data, student, question.id, { choices: ['a', ' a '] }), /正解/);
  assert.throws(() => updateDemoQuestion(data, student, question.id, { correctIndex: 99 }), /正解/);
  assert.throws(() => updateDemoQuestion(data, student, question.id, { status: 'approved', needsReview: true }), /確認/);
  assert.deepEqual(data, before);
});

test('publishing, publication requests and public adoption are disabled without mutating local data', () => {
  const { data, operator, student, topic } = fixture();
  const before = structuredClone(data);
  for (const actor of [student, operator, { ...operator, accessLevel: 'superuser' as const }]) {
    assert.throws(() => publishDemoLibrary(data, actor, topic.id), /公開・共有・配布は利用できません/);
    assert.throws(() => requestDemoLibraryPublication(data, actor, topic.id), /公開・共有・配布は利用できません/);
    assert.throws(() => addDemoLibraryPlan(data, actor, topic.id), /公開・共有・配布は利用できません/);
  }
  assert.deepEqual(data, before);
});

test('demo samples never borrow another owner’s content and generation rejects stale proposals', () => {
  const { data, operator, plan, topic, id } = fixture();
  const turn = data.planningTurns.at(-1)!;
  assert.match(turn.reply!, /AIには送信しておらず/);
  assert.match(turn.reply!, /内容には反映されません/);
  assert.ok(turn.proposals![0].samples!.every(sample => !data.questions.some(question => question.topicId.startsWith('topic-') && question.prompt === sample.prompt)));
  assert.equal(topic.targetCount, 100);
  const updated = addDemoPlanningTurn(data, operator, plan.id, '追加のコメント', now, id);
  assert.throws(() => generateDemoProposal(updated, operator, plan.id, turn.id, turn.proposals![0].id, 10, now, id), /最新/);
});

test('arrangements use only the owner’s collection, preserve project tags and leave originals untouched', () => {
  const { data, student, operator, id } = fixture();
  const topic = data.topics.find(item => item.subject === '古文')!;
  const before = structuredClone(data);
  const own = arrangeDemoTopic(data, student, topic.id, now, id);
  assert.deepEqual(own.plan.tags, data.plans.find(plan => plan.id === topic.planId)?.tags);
  assert.equal(own.plan.arrangementExamples?.length, 3);
  assert.match(own.plan.goal, /試験範囲全体を網羅した資料ではありません/);
  own.plan.tags!.push('別の範囲');
  assert.deepEqual(data, before);
  assert.throws(() => arrangeDemoTopic(data, operator, topic.id, now, id), /利用できる/);
});
