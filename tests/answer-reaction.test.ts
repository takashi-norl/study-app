import assert from 'node:assert/strict';
import test from 'node:test';
import { answerReaction, sessionAnswerStats, vibrateAnswer, type AnswerVibrationEnvironment } from '../src/lib/answer-reaction';

const attempt = (questionId: string, correct: boolean, seconds = 0, sessionId = 'current', id = questionId) => ({
  id, questionId, correct, sessionId, answeredAt: new Date(Date.UTC(2026, 9, 23, 0, 0, seconds)).toISOString(),
});

test('session counts and streaks use canonical unique answers and never mutate the records', () => {
  const attempts = [attempt('other', true, 0, 'previous'), attempt('q1', true, 1), attempt('q2', true, 2),
    attempt('q2', false, 3, 'current', 'retry-q2'), attempt('q3', false, 4),
    attempt('q4', true, 5), attempt('q5', false, 6, 'current', 'q4')];
  const snapshot = structuredClone(attempts);
  assert.deepEqual(sessionAnswerStats(attempts, 'current'), {
    answered: 4, correct: 3, streak: 1, bestStreak: 2, lastCorrect: true, previousCorrect: false,
  });
  assert.deepEqual(attempts, snapshot);
  assert.deepEqual(sessionAnswerStats(attempts, 'empty'), {
    answered: 0, correct: 0, streak: 0, bestStreak: 0, lastCorrect: null, previousCorrect: null,
  });
});

test('provided question order handles equal timestamps, resumes, and excludes later answers', () => {
  const attempts = [attempt('q3', false), attempt('q2', true), attempt('q1', false), attempt('q4', true)];
  const stats = sessionAnswerStats(attempts, 'current', ['q1', 'q2', 'q2', 'unanswered']);
  assert.deepEqual(stats, { answered: 2, correct: 1, streak: 1, bestStreak: 1, lastCorrect: true, previousCorrect: false });
  assert.equal(answerReaction(stats.lastCorrect!, stats.streak, stats.previousCorrect === false).message, 'よし、切り替えた！');
});

test('without session question order, answer time determines the streak and a wrong answer resets it', () => {
  const attempts = [attempt('q3', true, 3), attempt('q1', false, 1), attempt('q2', true, 2)];
  assert.equal(sessionAnswerStats(attempts, 'current').streak, 2);
  const failed = sessionAnswerStats([...attempts, attempt('q4', false, 4)], 'current');
  assert.deepEqual(failed, { answered: 4, correct: 2, streak: 0, bestStreak: 2, lastCorrect: false, previousCorrect: true });
  assert.equal(sessionAnswerStats([attempt('q1', true)], 'current').previousCorrect, null);
});

test('correct, milestone, comeback, and wrong reactions are distinct and modest', () => {
  assert.deepEqual(answerReaction(true, 1), { message: '正解！ いい感じ。', vibration: 18, milestone: null });
  for (const streak of [3, 5, 10] as const) {
    assert.deepEqual(answerReaction(true, streak), {
      message: `${streak}問連続！ その調子。`, vibration: [18, 45, 18], milestone: streak,
    });
  }
  for (const streak of [0, 2, 4, 6, 11, 20, NaN]) assert.equal(answerReaction(true, streak).milestone, null);
  assert.equal(answerReaction(true, 1, true).message, 'よし、切り替えた！');
  assert.deepEqual(answerReaction(false, 10, true), { message: 'くやしい、次こそ！', vibration: [10, 75, 10], milestone: null });
});

test('native vibration receives the intended pattern with its receiver and no shared array mutation', () => {
  const calls: (number | number[])[] = [];
  const receiver = { vibrate(pattern: number | number[]) {
    assert.equal(this, receiver);
    calls.push(structuredClone(pattern));
    if (Array.isArray(pattern)) pattern[0] = 999;
    return true;
  } };
  const environment: AnswerVibrationEnvironment = { navigator: receiver, visibilityState: 'visible', matchMedia: query => {
    assert.equal(query, '(prefers-reduced-motion: reduce)');
    return { matches: false };
  } };
  const reaction = answerReaction(true, 3);
  assert.equal(vibrateAnswer(reaction, true, environment), true);
  assert.equal(vibrateAnswer(answerReaction(true, 1), true, environment), true);
  assert.deepEqual(calls, [[18, 45, 18], 18]);
  assert.deepEqual(reaction.vibration, [18, 45, 18]);
});

test('disabled, reduced-motion, hidden, unknown visibility and unsupported environments never vibrate', () => {
  let calls = 0;
  const browser: AnswerVibrationEnvironment = { navigator: { vibrate: () => { calls++; return true; } }, visibilityState: 'visible', matchMedia: () => ({ matches: false }) };
  const reaction = answerReaction(false, 0);
  assert.equal(vibrateAnswer(reaction, false, browser), false);
  assert.equal(vibrateAnswer(reaction, true, { ...browser, matchMedia: () => ({ matches: true }) }), false);
  for (const visibilityState of ['hidden', 'prerender', undefined]) assert.equal(vibrateAnswer(reaction, true, { ...browser, visibilityState }), false);
  assert.equal(vibrateAnswer(reaction, true, { ...browser, navigator: {} }), false);
  assert.equal(vibrateAnswer(reaction, true, { ...browser, navigator: undefined }), false);
  assert.equal(calls, 0);
});

test('browser rejection, thrown native calls and media failures are safe no-ops', () => {
  const browser = { visibilityState: 'visible', matchMedia: () => ({ matches: false }) };
  const reaction = answerReaction(true, 1);
  assert.equal(vibrateAnswer(reaction, true, { ...browser, navigator: { vibrate: () => false } }), false);
  assert.equal(vibrateAnswer(reaction, true, { ...browser, navigator: { vibrate: () => { throw new Error('unsupported'); } } }), false);
  let calls = 0;
  assert.equal(vibrateAnswer(reaction, true, { ...browser, navigator: { vibrate: () => { calls++; return true; } },
    matchMedia: () => { throw new Error('unavailable'); } }), false);
  assert.equal(calls, 0);
  assert.equal(vibrateAnswer(reaction, true), false); // Node has no visible browser document.
});
