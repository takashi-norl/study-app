import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, Profile, Question, StudyData, Topic } from '../../src/lib/types';
import { getFamilyId } from '../../src/server/env';
import { prepareLearnerPreview } from '../../src/server/learner-preview';
import { stateForProfile } from '../../src/server/data';
import { mayPracticeQuestion } from '../../src/server/practice-access';

const now = '2026-01-01T00:00:00Z';
const parent: Profile = { id: 'parent', role: 'parent', name: '管理者', familyId: getFamilyId() };
const learner: Profile = { ...parent, id: 'learner', role: 'student', name: '学習者' };
const other: Profile = { ...learner, id: 'other' };

function fixture(): StudyData {
  const topic = (id: string, patch: Partial<Topic> = {}): Topic => ({ id, title: id, subject: '英語', description: '',
    createdAt: now, targetCount: 10, ownerId: learner.id, ...patch });
  const question = (id: string, topicId: string, patch: Partial<Question> = {}): Question => ({ id, topicId,
    prompt: id, choices: ['apple', 'pear'], correctIndex: 1, explanation: 'PRIVATE_ANSWER', learningPoint: 'PRIVATE_POINT',
    sourceIds: ['own-source'], sourceNote: 'PRIVATE_SOURCE_NOTE', status: 'published', version: 2,
    createdAt: now, ownerId: learner.id, ...patch });
  const plan = (id: string, libraryTopicId: string, patch: Partial<LearningPlan> = {}): LearningPlan => ({ id,
    ownerId: learner.id, libraryTopicId, title: id, subject: '英語', goal: '', difficulty: '標準', dailyQuestionTarget: 10,
    sourceIds: [], version: 1, createdAt: now, updatedAt: now, ...patch });
  return {
    profiles: [parent, learner, other, { ...learner, id: 'foreign', familyId: 'other-family' }],
    topics: [topic('own'), topic('other-private', { ownerId: other.id }), topic('admin-private', { ownerId: parent.id }),
      topic('test', { testOnly: true }), topic('adopted', { ownerId: undefined, libraryPublished: true }),
      topic('unadopted', { ownerId: undefined, libraryPublished: true }),
      topic('test-adoption', { ownerId: undefined, libraryPublished: true })],
    questions: [question('own-q', 'own'), question('draft-q', 'own', { status: 'draft' }),
      question('future-q', 'own', { publishedAt: '2099-01-01T00:00:00Z' }),
      question('archived-q', 'own', { status: 'archived' }), question('test-q', 'test', { testOnly: true }),
      question('test-question', 'own', { testOnly: true }), question('other-q', 'other-private', { ownerId: other.id }),
      question('admin-q', 'admin-private', { ownerId: parent.id }),
      question('adopted-q', 'adopted', { ownerId: undefined }), question('unadopted-q', 'unadopted', { ownerId: undefined }),
      question('test-adoption-q', 'test-adoption', { ownerId: undefined }),
      question('other-audience-q', 'adopted', { ownerId: undefined, audienceUserId: other.id }),
      question('orphan-q', 'missing-topic')],
    plans: [plan('adoption', 'adopted'), plan('other-adoption', 'unadopted', { ownerId: other.id }),
      plan('test-only-adoption', 'test-adoption', { testOnly: true })],
    sources: [{ id: 'own-source', ownerId: learner.id, name: 'Own photo', mimeType: 'image/jpeg', createdAt: now },
      { id: 'admin-source', ownerId: parent.id, name: 'ADMIN_PRIVATE_PHOTO', mimeType: 'image/jpeg', createdAt: now }],
    attempts: [{ id: 'own-attempt', userId: learner.id, questionId: 'own-q', questionVersion: 1, sessionId: 'own-session',
      selectedIndex: 0, correct: false, answeredAt: now }, { id: 'other-attempt', userId: other.id, questionId: 'other-q',
      questionVersion: 1, sessionId: 'other-session', selectedIndex: 0, correct: false, answeredAt: now }],
    exposures: [{ id: 'own-exposure', userId: learner.id, questionId: 'own-q', questionVersion: 1,
      sessionId: 'own-session', shownAt: now }],
    sessions: [{ id: 'own-session', userId: learner.id, mode: 'daily', questionIds: ['own-q'], createdAt: now },
      { id: 'other-session', userId: other.id, mode: 'daily', questionIds: ['other-q'], createdAt: now }],
    jobs: [], planningTurns: [],
  };
}

test('learner preview rejects learners and administrators from another family', () => {
  const data = fixture();
  assert.throws(() => prepareLearnerPreview(data, learner, learner.id), { status: 403, code: 'LEARNER_PREVIEW_FORBIDDEN' });
  assert.throws(() => prepareLearnerPreview(data, { ...parent, familyId: 'other-family' }, learner.id),
    { status: 403, code: 'LEARNER_PREVIEW_FORBIDDEN' });
  for (const id of ['unknown', parent.id, 'foreign']) {
    assert.throws(() => prepareLearnerPreview(data, parent, id), { status: 404, code: 'LEARNER_NOT_FOUND' });
  }
});

test('learner preview uses real visibility and practice access for private, public, test and archived questions', () => {
  const data = fixture();
  const preview = prepareLearnerPreview(data, parent, learner.id);
  assert.deepEqual(preview.data, stateForProfile(data, learner));
  assert.deepEqual(preview.profile, learner);
  assert.deepEqual(preview.practiceQuestions.map(question => question.id), ['own-q', 'draft-q', 'future-q', 'adopted-q']);
  assert.deepEqual(preview.practiceQuestions.map(question => question.id),
    data.questions.filter(question => mayPracticeQuestion(data, learner, question)).map(question => question.id));
  // Saved drafts and future-dated own questions are usable under the current production policy.
  assert.ok(preview.practiceQuestions.every(question => question.status === 'published' && question.publishedAt === now));
  assert.ok(preview.data.topics.some(topic => topic.id === 'unadopted'));
  assert.ok(!preview.data.questions.some(question => question.topicId === 'unadopted'));
});

test('learner view strips answers and session snapshots while administrator rehearsal receives eligible answer snapshots', () => {
  const data = fixture();
  Object.assign(data.sessions[0], { questionSnapshots: [{ ...data.questions[0], explanation: 'OLD_SNAPSHOT_ANSWER' }] });
  const preview = prepareLearnerPreview(data, parent, learner.id);
  assert.ok(preview.data.questions.every(question => question.correctIndex === -1 && question.explanation === ''
    && question.learningPoint === '' && question.sourceNote === '' && question.sourceIds.length === 0));
  assert.deepEqual(preview.data.profiles, [learner]);
  assert.deepEqual(preview.data.attempts.map(attempt => attempt.id), ['own-attempt']);
  assert.deepEqual(preview.data.sessions.map(session => session.id), ['own-session']);
  assert.doesNotMatch(JSON.stringify(preview.data), /PRIVATE_ANSWER|PRIVATE_POINT|PRIVATE_SOURCE_NOTE|ADMIN_PRIVATE_PHOTO|OLD_SNAPSHOT_ANSWER|questionSnapshots/);
  assert.equal(preview.practiceQuestions[0].correctIndex, 1);
  assert.equal(preview.practiceQuestions[0].explanation, 'PRIVATE_ANSWER');
  assert.equal(preview.practiceQuestions[0].version, 2);
  data.questions[0].choices[1] = 'changed after preview';
  data.questions[0].correctIndex = 0;
  assert.equal(preview.practiceQuestions[0].choices[1], 'pear');
  assert.equal(preview.practiceQuestions[0].correctIndex, 1);
});

test('preview creates no sessions, answers or exposures and its local state cannot mutate stored data', () => {
  const data = fixture();
  const before = structuredClone(data);
  const preview = prepareLearnerPreview(data, parent, learner.id);
  assert.deepEqual(data, before);
  preview.data.attempts[0].correct = true;
  preview.data.sessions[0].questionIds.push('local-question');
  preview.data.exposures[0].shownAt = '2099-01-01T00:00:00Z';
  preview.profile.name = 'Local name';
  preview.practiceQuestions[0].sourceIds.push('local-source');
  assert.deepEqual(data, before);
});
