import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnswerInteraction, chooseAnswer, submitAnswer, settleAnswer } from '../src/lib/answer-interaction';

test('the default submits on selection and rapid further taps cannot change or submit it twice', () => {
  const initial = createAnswerInteraction();
  const selected = chooseAnswer(initial, 2, 4);
  assert.equal(selected.requireConfirmation, false);
  assert.equal(selected.selected, 2);
  assert.equal(selected.phase, 'submitting');
  assert.equal(chooseAnswer(selected, 0, 4), selected);
  assert.equal(submitAnswer(selected), selected);
  const answered = settleAnswer(selected, true);
  assert.equal(answered.phase, 'answered');
  assert.equal(chooseAnswer(answered, 0, 4), answered);
  assert.equal(submitAnswer(answered), answered);
});

test('confirmation mode allows changing a choice but sends only after confirmation', () => {
  const initial = createAnswerInteraction(true);
  assert.equal(submitAnswer(initial), initial);
  const first = chooseAnswer(initial, 2, 4);
  const changed = chooseAnswer(first, 1, 4);
  assert.equal(changed.phase, 'choosing');
  assert.equal(changed.selected, 1);
  const submitted = submitAnswer(changed);
  assert.equal(submitted.phase, 'submitting');
  assert.equal(submitted.selected, 1);
  assert.equal(submitAnswer(submitted), submitted);
});

test('an ambiguous failed save can retry only the same answer in either mode', () => {
  for (const confirmation of [false, true]) {
    let state = chooseAnswer(createAnswerInteraction(confirmation), 3, 4);
    if (confirmation) state = submitAnswer(state);
    state = settleAnswer(state, false);
    assert.equal(state.phase, 'failed');
    assert.equal(chooseAnswer(state, 0, 4), state);
    const retry = submitAnswer(state);
    assert.equal(retry.phase, 'submitting');
    assert.equal(retry.selected, 3);
    assert.equal(submitAnswer(retry), retry);
    assert.equal(settleAnswer(retry, true).phase, 'answered');
  }
});

test('new questions clear the choice and new sessions start in immediate mode', () => {
  const answered = settleAnswer(submitAnswer(chooseAnswer(createAnswerInteraction(true), 1, 4)), true);
  const nextQuestion = createAnswerInteraction(answered.requireConfirmation);
  assert.deepEqual(nextQuestion, { requireConfirmation: true, selected: null, phase: 'choosing' });
  const nextSession = createAnswerInteraction();
  assert.equal(nextSession.requireConfirmation, false);
  assert.equal(nextSession.selected, null);
  for (const invalid of [-1, 4, 0.5, NaN]) assert.equal(chooseAnswer(nextSession, invalid, 4), nextSession);
});
