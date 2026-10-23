import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancePreviewQuestion, answerPreviewQuestion, createPreviewPractice, finishPreviewPractice,
  previewCurrentQuestion, previewQuestionKey, startPreviewPractice,
  type LearnerPreviewPayload,
} from '../src/lib/learner-preview';
import type { Question } from '../src/lib/types';

const now = new Date('2026-10-23T00:00:00.000Z');
function fixture(count = 3) {
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const profile = { id: 'learner', familyId: 'family', name: '学習者', role: 'student' as const };
  const questions: Question[] = Array.from({ length: count }, (_, index) => ({
    id: `question-${String(index).padStart(2, '0')}`, topicId: 'private-topic',
    prompt: `問題 ${index + 1}`, choices: ['正解', '不正解'], correctIndex: 0,
    explanation: '正解の解説', learningPoint: '覚える内容',
    sourceIds: ['original-photo'], sourceNote: '原本への参照', status: 'published', version: 1,
    createdAt: '2026-10-22T00:00:00.000Z', publishedAt: '2026-10-22T00:00:00.000Z',
  }));
  const payload: LearnerPreviewPayload = {
    profile, practiceQuestions: questions,
    data: { profiles: [profile], topics: [{ id: 'private-topic', title: '自分の問題集', subject: '英語',
      description: '', ownerId: profile.id, createdAt: now.toISOString(), targetCount: count }],
      questions: questions.map(question => ({ ...question, correctIndex: -1, explanation: '', learningPoint: '', sourceIds: [], sourceNote: '' })),
      sources: [], attempts: [], exposures: [], sessions: [], jobs: [], plans: [], planningTurns: [],
    },
  };
  return { payload, id };
}

test('preview excludes full-answer questions outside the learner view, archived questions, test questions, and mismatched versions', () => {
  const { payload } = fixture();
  const question = payload.practiceQuestions[0];
  payload.practiceQuestions = [...payload.practiceQuestions,
    { ...question, id: 'other-learner-question' },
    { ...question, id: 'unadded-public-question', topicId: 'unadded-topic' },
    { ...question, version: 2 }, { ...question, testOnly: true }, { ...question, status: 'archived' },
  ];
  const state = createPreviewPractice(payload);
  assert.deepEqual(state.practiceQuestions.map(item => item.id), payload.data.questions.map(item => item.id));
  assert.equal(startPreviewPractice(state, 'daily', 'unadded-topic', now).session, null);
});

test('preview rehearses answers, explanations, next, and completion without changing the saved payload', () => {
  const { payload, id } = fixture();
  const original = JSON.stringify(payload);
  let state = startPreviewPractice(createPreviewPractice(payload), 'daily', undefined, now, id);
  assert.equal(state.session?.questionIds.length, 3);
  assert.equal(state.data.exposures.length, 1);
  assert.equal(previewCurrentQuestion(state)?.correctIndex, -1);
  assert.equal(previewCurrentQuestion(state)?.explanation, '');
  assert.equal(previewCurrentQuestion(state)?.learningPoint, '');
  for (let index = 0; index < 3; index += 1) {
    const key = previewQuestionKey(state);
    state = answerPreviewQuestion(state, index === 0 ? 1 : 0, key, now, id);
    assert.equal(state.feedback?.correct, index !== 0);
    assert.equal(state.feedback?.explanation, '正解の解説');
    assert.equal(previewCurrentQuestion(state)?.learningPoint, '覚える内容');
    assert.deepEqual(previewCurrentQuestion(state)?.sourceIds, []);
    state = advancePreviewQuestion(state, key, now, id);
  }
  assert.equal(previewCurrentQuestion(state), null);
  assert.equal(state.session?.completedAt, now.toISOString());
  assert.equal(state.data.sessions.at(-1)?.completedAt, now.toISOString());
  assert.equal(state.data.attempts.length, 3);
  assert.equal(state.data.attempts.filter(attempt => attempt.correct).length, 2);
  assert.equal(state.data.exposures.length, 3);
  assert.equal(JSON.stringify(payload), original);
  assert.ok(state.data.questions.every(question => question.correctIndex === -1 && !question.explanation));
  const finished = finishPreviewPractice(state);
  assert.equal(finished.session, null);
  const weak = startPreviewPractice(finished, 'weak', undefined, now, id);
  assert.deepEqual(weak.session?.questionIds, [payload.practiceQuestions[0].id]);
  assert.equal(JSON.stringify(payload), original);
});

test('double clicks, stale question callbacks, and invalid choices cannot duplicate answers or skip questions', () => {
  const { payload, id } = fixture();
  let state = startPreviewPractice(createPreviewPractice(payload), 'daily', undefined, now, id);
  assert.equal(startPreviewPractice(state, 'daily', undefined, now, id), state);
  const key = previewQuestionKey(state);
  assert.equal(advancePreviewQuestion(state, key, now, id), state);
  for (const invalid of [-1, 2, 0.5, NaN]) assert.equal(answerPreviewQuestion(state, invalid, key, now, id), state);
  state = answerPreviewQuestion(state, 1, key, now, id);
  assert.equal(answerPreviewQuestion(state, 0, key, now, id), state);
  assert.equal(state.data.attempts.length, 1);
  state = advancePreviewQuestion(state, key, now, id);
  assert.equal(advancePreviewQuestion(state, key, now, id), state);
  assert.equal(answerPreviewQuestion(state, 0, key, now, id), state);
  assert.equal(state.index, 1);
  assert.equal(state.data.exposures.length, 2);
  assert.equal(state.data.attempts.length, 1);
});

test('preview uses the real ten-question selection and existing learner history', () => {
  const { payload, id } = fixture(12);
  payload.data.attempts = [{ id: 'saved-answer', userId: payload.profile.id, questionId: 'question-00',
    questionVersion: 1, sessionId: 'saved-session', selectedIndex: 0, correct: true, answeredAt: now.toISOString() }];
  const initial = createPreviewPractice(payload);
  const state = startPreviewPractice(initial, 'daily', undefined, now, id);
  assert.equal(state.session?.questionIds.length, 10);
  assert.ok(!state.session?.questionIds.includes('question-00'));
  assert.equal(state.data.attempts.length, 1);
  assert.equal(startPreviewPractice(initial, 'weak', undefined, now, id).session, null);
  assert.match(startPreviewPractice(initial, 'weak', undefined, now, id).error!, /間違えた問題/);
});
