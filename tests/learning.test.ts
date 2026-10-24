import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatJapanDate, getDailyActivity, getQuestionProgress, getTopicStats, selectQuestions,
} from '../src/lib/learning';
import { createDemoData } from '../src/lib/demo-data';
import type { Attempt, Exposure, Question } from '../src/lib/types';

const now = new Date('2026-10-22T03:00:00Z');
const question = (id: string, overrides: Partial<Question> = {}): Question => ({
  id, topicId: 'topic', prompt: '例題', choices: ['正解', '誤答'], correctIndex: 0,
  explanation: '説明', learningPoint: '基本', sourceIds: [], sourceNote: '', status: 'published',
  version: 1, createdAt: '2026-10-01T00:00:00Z', publishedAt: '2026-10-01T00:00:00Z', ...overrides,
});
const attempt = (id: string, questionId: string, correct: boolean, answeredAt: string, userId = 'student'): Attempt => ({
  id, questionId, correct, answeredAt, userId, questionVersion: 1, sessionId: 'session', selectedIndex: correct ? 0 : 1,
});
const exposure = (id: string, questionId: string, shownAt = '2026-10-20T01:00:00Z'): Exposure => ({
  id, questionId, shownAt, userId: 'student', questionVersion: 1, sessionId: 'session',
});

test('JST calendar boundaries determine activity dates and future attempts are excluded', () => {
  assert.equal(formatJapanDate('2026-10-21T14:59:59Z'), '2026-10-21');
  assert.equal(formatJapanDate('2026-10-21T15:00:00Z'), '2026-10-22');
  const history = [
    attempt('one', 'q', false, '2026-10-21T14:59:00Z'),
    attempt('two', 'q', true, '2026-10-21T15:01:00Z'),
    attempt('future', 'q2', true, '2026-10-23T00:00:00Z'),
    attempt('other', 'q3', true, '2026-10-22T00:00:00Z', 'other-student'),
  ];
  const days = getDailyActivity(history, 'student', 2, now);
  assert.deepEqual(days, [
    { date: '2026-10-21', answers: 1, correct: 0, firstAnswers: 1, firstCorrect: 0 },
    { date: '2026-10-22', answers: 1, correct: 1, firstAnswers: 0, firstCorrect: 0 },
  ]);
  assert.equal(getQuestionProgress('q', history, 'student', now).stage, 1);
});

test('same-day retries do not advance memory stage, and an error keeps a next-day review', () => {
  const history = [
    attempt('1', 'q', false, '2026-10-20T01:00:00Z'),
    attempt('2', 'q', true, '2026-10-20T01:02:00Z'),
    attempt('3', 'q', true, '2026-10-20T08:00:00Z'),
  ];
  const result = getQuestionProgress('q', history, 'student', now);
  assert.equal(result.stage, 0);
  assert.equal(result.correctCount, 2);
  assert.equal(result.wrongCount, 1);
  assert.equal(result.nextReviewAt, '2026-10-20T15:00:00.000Z');
  history.push(attempt('4', 'q', true, '2026-10-21T01:00:00Z'));
  assert.equal(getQuestionProgress('q', history, 'student', now).stage, 1);
  history.push(attempt('5', 'q', true, '2026-10-21T03:00:00Z'));
  assert.equal(getQuestionProgress('q', history, 'student', now).stage, 1);
});

test('reviews widen to 30 days, remain scheduled, and errors shorten the interval', () => {
  const history = [
    attempt('1', 'q', true, '2026-08-01T01:00:00Z'),
    attempt('2', 'q', true, '2026-08-02T01:00:00Z'),
    attempt('3', 'q', true, '2026-08-05T01:00:00Z'),
    attempt('4', 'q', true, '2026-08-12T01:00:00Z'),
    attempt('5', 'q', true, '2026-08-26T01:00:00Z'),
    attempt('6', 'q', true, '2026-09-25T01:00:00Z'),
  ];
  const remembered = getQuestionProgress('q', history, 'student', now);
  assert.equal(remembered.stage, 5);
  assert.equal(remembered.nextReviewAt, '2026-10-24T15:00:00.000Z');
  history.push(attempt('7', 'q', false, '2026-10-21T01:00:00Z'));
  const forgotten = getQuestionProgress('q', history, 'student', now);
  assert.equal(forgotten.stage, 0);
  assert.equal(forgotten.streak, 0);
  assert.equal(forgotten.nextReviewAt, '2026-10-21T15:00:00.000Z');
});

test('an early voluntary review does not advance or postpone the next scheduled review', () => {
  const history = [
    attempt('1', 'q', true, '2026-10-18T01:00:00Z'),
    attempt('2', 'q', true, '2026-10-19T01:00:00Z'),
    attempt('3', 'q', true, '2026-10-20T01:00:00Z'),
  ];
  const result = getQuestionProgress('q', history, 'student', now);
  assert.equal(result.stage, 2);
  assert.equal(result.nextReviewAt, '2026-10-21T15:00:00.000Z');
});

test('normal sessions combine six new and four due questions and exclude unpublished, scheduled and today-correct content', () => {
  const fresh = Array.from({ length: 8 }, (_, i) => question(`new-${i}`));
  const due = Array.from({ length: 6 }, (_, i) => question(`due-${i}`));
  const excluded = [
    question('draft', { status: 'draft' }), question('approved', { status: 'approved' }),
    question('archived', { status: 'archived' }),
    question('future', { publishedAt: '2026-10-23T00:00:00Z' }), question('done-today'),
  ];
  const history = due.map((q, i) => attempt(`a-${i}`, q.id, i > 1, '2026-10-18T01:00:00Z'));
  history.push(attempt('today', 'done-today', true, '2026-10-22T01:00:00Z'));
  const result = selectQuestions([...fresh, ...due, ...excluded], history, [], 'student', 'daily', now);
  assert.equal(result.length, 10);
  assert.equal(result.filter((q) => q.id.startsWith('new-')).length, 6);
  assert.equal(result.filter((q) => q.id.startsWith('due-')).length, 4);
  assert.equal(new Set(result.map((q) => q.id)).size, 10);
  const fill = selectQuestions([fresh[0], ...due], history, [], 'student', 'daily', now, 10);
  assert.equal(fill.length, 7);
});

test('a failed question returns later despite one correct answer, and weak practice can deliberately repeat it', () => {
  const questions = [question('weak'), question('strong')];
  const history = [
    attempt('1', 'weak', false, '2026-10-20T01:00:00Z'),
    attempt('2', 'weak', true, '2026-10-21T01:00:00Z'),
    attempt('3', 'strong', true, '2026-10-22T01:00:00Z'),
  ];
  assert.deepEqual(selectQuestions(questions, history, [], 'student', 'daily', now).map((q) => q.id), ['weak']);
  history.push(attempt('4', 'weak', true, '2026-10-22T01:00:00Z'));
  assert.equal(selectQuestions(questions, history, [], 'student', 'extra', now).length, 0);
  assert.deepEqual(selectQuestions(questions, history, [], 'student', 'weak', now).map((q) => q.id), ['weak']);
});

test('coverage counts unique exposures independently of answers, and next-day recall is distinct from first answers and retries', () => {
  const questions = [question('q1'), question('q2'), question('q3'), question('draft', { status: 'draft' })];
  const history = [
    attempt('1', 'q1', false, '2026-10-20T01:00:00Z'),
    attempt('2', 'q1', true, '2026-10-20T01:01:00Z'),
    attempt('3', 'q1', false, '2026-10-21T01:00:00Z'),
    attempt('4', 'q1', true, '2026-10-21T01:01:00Z'),
    attempt('5', 'q2', true, '2026-10-21T01:00:00Z'),
  ];
  const exposures = [exposure('1', 'q1'), exposure('2', 'q1'), exposure('3', 'q2'), exposure('4', 'q3'), exposure('5', 'draft')];
  const stats = getTopicStats('topic', questions, history, exposures, 'student', now);
  assert.equal(stats.total, 3);
  assert.equal(stats.exposed, 3);
  assert.equal(stats.answered, 2);
  assert.equal(stats.unattempted, 1);
  assert.equal(stats.coverageRate, 1);
  assert.equal(stats.firstAccuracy, 0.5);
  assert.equal(stats.reviewAccuracy, 0);
  assert.equal(stats.weakCount, 1);
  assert.equal(stats.dueCount, 2);
  const empty = getTopicStats('missing', questions, history, exposures, 'student', now);
  assert.equal(empty.coverageRate, 0);
  assert.equal(empty.firstAccuracy, null);
  assert.equal(empty.reviewAccuracy, null);
  assert.equal(getQuestionProgress('never', [], 'student', now).nextReviewAt, null);
});

test('activity does not mistake an older question for a first attempt when its first answer is outside the chart window', () => {
  const history = [attempt('1', 'q', false, '2026-09-01T01:00:00Z'), attempt('2', 'q', true, '2026-10-22T01:00:00Z')];
  const [today] = getDailyActivity(history, 'student', 1, now);
  assert.equal(today.answers, 1);
  assert.equal(today.firstAnswers, 0);
});

test('demo contains at least twelve published questions per subject and clearly separate drafts', () => {
  const demo = createDemoData(now);
  for (const topic of demo.topics) {
    assert.ok(demo.questions.filter((q) => q.topicId === topic.id && q.status === 'published').length >= 12);
  }
  assert.ok(demo.questions.some((q) => q.status === 'draft'));
  assert.ok(demo.questions.every((q) => q.correctIndex >= 0 && q.correctIndex < q.choices.length));
  assert.equal(demo.attempts.filter((a) => formatJapanDate(a.answeredAt) === '2026-10-22').length, 0);
  assert.equal(demo.profiles[0].id, 'student-demo');
});
