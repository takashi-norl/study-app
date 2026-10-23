import assert from 'node:assert/strict';
import test from 'node:test';
import legacy from '../../content/vocabulary-marathon.json';
import { vocabularyEntries } from '../../src/server/vocabulary-catalog';
import { glossaryEntries } from '../../src/server/vocabulary-glossary-catalog';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { matchGlossaryTerms } from '../../src/lib/vocabulary-glossary';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';

test('the fixed catalog has 100 distinct words, 300 examples, valid tests and balanced levels', () => {
  assert.equal(vocabularyEntries.length, 100);
  assert.equal(new Set(vocabularyEntries.map(entry => entry.id)).size, 100);
  assert.equal(new Set(vocabularyEntries.map(entry => entry.word)).size, 100);
  for (const level of ['2級', '準1級']) assert.equal(vocabularyEntries.filter(entry => entry.level === level).length, 50);
  for (const entry of vocabularyEntries) {
    assert.equal(entry.examples.length, 3, entry.word);
    assert.equal(new Set(entry.examples.map(example => example.text)).size, 3, entry.word);
    assert.deepEqual(entry.examples.map(example => example.id), ['example-1', 'example-2', 'example-3']);
    assert.ok(entry.ipa && entry.meaning && entry.definition && entry.usageTip, entry.word);
    assert.ok(entry.recall.answers.length && /_{3,}/.test(entry.recall.prompt), entry.word);
    for (const answer of entry.recall.answers) assert.ok(!new RegExp(`\\b${answer}\\b`, 'i').test(entry.recall.prompt), `${entry.word}: recall must not reveal its answer`);
    assert.equal(entry.production.checkpoints.length, 3, entry.word);
    assert.ok(entry.production.prompt && entry.production.modelAnswer, entry.word);
    assert.ok(entry.questions.length >= 1, entry.word);
    for (const question of entry.questions) {
      assert.equal(question.choices.length, 4, entry.word);
      assert.equal(new Set(question.choices).size, 4, entry.word);
      assert.ok(Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4, entry.word);
      assert.ok(question.explanation.includes(`正解は${question.correctIndex + 1}`), entry.word);
    }
  }
  const specs = vocabularyEntries.map(vocabularyAudioSpec);
  assert.equal(new Set(specs.map(spec => spec.cacheKey)).size, 100);
  assert.ok(specs.reduce((total, spec) => total + spec.characters, 0) <= 35000);
});
test('the six saved recordings retain their exact cache identity, example text and voices', () => {
  for (const old of legacy.entries) {
    const entry = vocabularyEntries.find(entry => entry.id === old.id)!;
    assert.deepEqual(entry.examples, old.examples, old.word);
    assert.equal(vocabularyAudioSpec(entry).cacheKey, vocabularyAudioSpec(old as VocabularyEntry).cacheKey, old.word);
  }
});
test('glossary connects foundation phrases and catalog words without duplicate aliases or dangling references', () => {
  assert.equal(glossaryEntries.length, 136);
  assert.equal(new Set(glossaryEntries.map(entry => entry.id)).size, glossaryEntries.length);
  const keys = glossaryEntries.flatMap(entry => [entry.term, ...entry.aliases].map(term => term.toLowerCase()));
  assert.equal(new Set(keys).size, keys.length, 'An alias must resolve to exactly one entry');
  assert.ok(glossaryEntries.every(entry => entry.relatedIds.every(id => glossaryEntries.some(item => item.id === id))));
  assert.equal(matchGlossaryTerms('We left early in order to avoid rain.', glossaryEntries).filter(part => part.entryId).length, 2);
  assert.deepEqual(matchGlossaryTerms('She achieved her goal and admitted the mistake, justifying her choice.', glossaryEntries).filter(part => part.entryId).map(part => part.entryId), ['achieve', 'admit', 'justify']);
});
