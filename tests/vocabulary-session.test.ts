import assert from 'node:assert/strict';
import test from 'node:test';
import type { VocabularyEntry } from '../src/lib/vocabulary-types';
import { buildVocabularyTest, checkVocabularyAnswer, summarizeVocabularyTest, vocabularyGroups } from '../src/lib/vocabulary-session';

const entries = Array.from({ length: 30 }, (_, index) => ({
  id: `word${index}`, word: `word${index}`, level: index < 20 ? '2級' : '準1級',
  questions: [{ id: `q${index}`, type: 'usage', prompt: 'Choose a natural sentence.', choices: ['A', 'B', 'C', 'D'], correctIndex: index % 4, explanation: '理由' }],
  recall: { prompt: 'Fill in the blank.', answers: [`word${index}`], explanation: '使い方' },
} as VocabularyEntry));

test('a ten-word unit tests every word by recall and usage, without exposing recognition before recall', () => {
  const items = buildVocabularyTest(entries.slice(0, 10));
  assert.equal(items.length, 20);
  assert.ok(items.slice(0, 10).every(item => item.kind === 'recall'));
  assert.ok(items.slice(10).every(item => item.kind === 'choice'));
  assert.equal(new Set(items.slice(0, 10).map(item => item.wordId)).size, 10);
  assert.ok(items.every((item, index) => index === 0 || item.wordId !== items[index - 1].wordId));
  assert.deepEqual(buildVocabularyTest(entries.slice(0, 10)), items);
  assert.notDeepEqual(buildVocabularyTest(entries.slice(0, 10), 1).map(item => item.wordId), items.map(item => item.wordId));
  assert.equal(buildVocabularyTest([entries[0], entries[0]]).length, 2);
});
test('answer checking accepts harmless typing differences but does not turn a different word into a correct answer', () => {
  const item = { ...buildVocabularyTest([entries[0]])[0], answers: ['afford'] };
  assert.ok(checkVocabularyAnswer(item, ' AFFORD. '));
  assert.ok(checkVocabularyAnswer(item, 'ａｆｆｏｒｄ'));
  for (const value of ['', 'avoid', 'affor', 'I can afford it.', 0]) assert.equal(checkVocabularyAnswer(item, value), false);
});
test('results separate choosing from recall, include unanswered words in review, and require a complete test', () => {
  const items = buildVocabularyTest(entries.slice(0, 3));
  const answers = Object.fromEntries(items.map(item => [item.id, item.kind === 'recall' ? item.answers![0] : item.correctIndex!]));
  const full = summarizeVocabularyTest(items, answers);
  assert.deepEqual(full, { choice: { correct: 3, total: 3 }, recall: { correct: 3, total: 3 }, wrongWordIds: [], completed: true });
  delete answers[items[0].id];
  const partial = summarizeVocabularyTest(items, answers);
  assert.equal(partial.completed, false);
  assert.equal(partial.recall.correct, 2);
  assert.deepEqual(partial.wrongWordIds, [items[0].wordId]);
  assert.equal(summarizeVocabularyTest([], {}).completed, false);
});
test('units use only the selected level and never silently discard remainder words', () => {
  assert.deepEqual(vocabularyGroups(entries, '2級').map(group => group.length), [10, 10]);
  assert.deepEqual(vocabularyGroups(entries.slice(0, 17), '2級').map(group => group.length), [10, 7]);
  assert.equal(vocabularyGroups(entries, '準1級').flat().length, 10);
});
