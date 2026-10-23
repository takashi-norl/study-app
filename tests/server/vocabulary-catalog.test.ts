import assert from 'node:assert/strict';
import test from 'node:test';
import legacy from '../../content/vocabulary-marathon.json';
import grade2 from '../../content/vocabulary-grade2.json';
import pre1 from '../../content/vocabulary-pre1.json';
import alternatives from '../../content/vocabulary-recall-alternatives.json';
import { buildVocabularyTest, VOCABULARY_TEST_MODES } from '../../src/lib/vocabulary-session';
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

test('contextual alternatives cover known words, stay distinct from distractors, and retain the saved recordings', () => {
  assert.deepEqual(Object.keys(alternatives).sort(), vocabularyEntries.map(entry => entry.id).sort());
  const originals = [...grade2.entries, ...pre1.entries] as VocabularyEntry[];
  for (const entry of vocabularyEntries) {
    const synonyms = entry.recall.alternatives ?? [];
    assert.equal(new Set(synonyms.map(item => item.answer.toLowerCase())).size, synonyms.length, entry.word);
    for (const item of synonyms) {
      assert.ok(item.answer.trim() && item.explanation.trim(), entry.word);
      assert.ok(!entry.recall.answers.includes(item.answer), entry.word);
    }
    for (const mode of VOCABULARY_TEST_MODES) {
      const [question] = buildVocabularyTest([entry], 0, mode.id, vocabularyEntries);
      assert.equal(question.kind, 'choice');
      assert.equal(question.choices?.length, 4, `${entry.word}:${mode.id}`);
      if (mode.id === 'context') for (const synonym of synonyms) assert.ok(!question.choices?.includes(synonym.answer), `${entry.word}: ${synonym.answer} must not be a wrong choice`);
    }
    assert.equal(vocabularyAudioSpec(entry).cacheKey, vocabularyAudioSpec(originals.find(old => old.id === entry.id)!).cacheKey, entry.word);
  }
  assert.ok(vocabularyEntries.find(entry => entry.id === 'reluctant')?.recall.alternatives?.some(item => item.answer === 'hesitant'));
});
test('glossary connects foundation phrases and catalog words without duplicate aliases or dangling references', () => {
  assert.equal(glossaryEntries.length, 146);
  assert.equal(new Set(glossaryEntries.map(entry => entry.id)).size, glossaryEntries.length);
  const keys = glossaryEntries.flatMap(entry => [entry.term, ...entry.aliases].map(term => term.toLowerCase()));
  assert.equal(new Set(keys).size, keys.length, 'An alias must resolve to exactly one entry');
  assert.ok(glossaryEntries.every(entry => entry.relatedIds.every(id => glossaryEntries.some(item => item.id === id))));
  assert.equal(matchGlossaryTerms('We left early in order to avoid rain.', glossaryEntries).filter(part => part.entryId).length, 2);
  assert.deepEqual(matchGlossaryTerms('She achieved her goal and admitted the mistake, justifying her choice.', glossaryEntries).filter(part => part.entryId).map(part => part.entryId), ['achieve', 'admit', 'justify']);
});

test('verb metadata covers every catalog verb without changing any saved audio identity', () => {
  const originals = [...grade2.entries, ...pre1.entries] as VocabularyEntry[];
  for (const entry of vocabularyEntries) {
    if (entry.partOfSpeech === '動詞') assert.ok(entry.verbForms, `${entry.word} needs a conjugation table`);
    else assert.equal(entry.verbForms, undefined, `${entry.word} is not a verb entry`);
    assert.equal(vocabularyAudioSpec(entry).cacheKey, vocabularyAudioSpec(originals.find(old => old.id === entry.id)!).cacheKey, entry.word);
  }
});

test('all displayed verb forms resolve back to their canonical glossary history ID', () => {
  for (const entry of glossaryEntries) {
    if (!entry.verbForms) continue;
    const { base, past, pastParticiple, presentParticiple, thirdPersonSingular } = entry.verbForms;
    for (const form of [...base, ...past, ...pastParticiple, ...presentParticiple, ...thirdPersonSingular]) {
      assert.deepEqual(matchGlossaryTerms(form, glossaryEntries), [{ text: form, entryId: entry.id }], `${entry.term}: ${form}`);
    }
  }
  const text = 'She took part in it, has taken part in it, then took notes and has written a report.';
  assert.deepEqual(matchGlossaryTerms(text, glossaryEntries).filter(part => part.entryId).map(part => part.entryId),
    ['basic-take-part-in', 'basic-take-part-in', 'basic-take', 'basic-write']);
});
