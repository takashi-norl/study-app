import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { VocabularyEntry } from '../src/lib/vocabulary-types';
import { buildVocabularyTest, checkVocabularyAnswer, evaluateVocabularyAnswer, summarizeVocabularyTest, vocabularyGroups, VOCABULARY_TEST_MODES, type VocabularyTestMode } from '../src/lib/vocabulary-session';

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
  assert.deepEqual(full, { choice: { correct: 3, total: 3 }, recall: { correct: 3, total: 3 }, targetRecallCorrect: 3, alternativeRecall: 0, wrongWordIds: [], completed: true });
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

const recallAlternatives = JSON.parse(readFileSync(new URL('../content/vocabulary-recall-alternatives.json', import.meta.url), 'utf8')) as Record<string, { answer: string; explanation: string }[]>;
const catalog = (['vocabulary-grade2.json', 'vocabulary-pre1.json'].flatMap(file => JSON.parse(readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8')).entries) as VocabularyEntry[])
  .map(entry => ({ ...entry, recall: { ...entry.recall, alternatives: recallAlternatives[entry.id] } }));
const modes: VocabularyTestMode[] = ['meaning', 'word', 'context', 'usage'];

test('new grade3 and pre2 batches use authored choices without a catalog-sized distractor pool', () => {
  for (const level of ['3級', '準2級'] as const) {
    const word: VocabularyEntry = { ...catalog[0], id: 'new-word', word: 'freshword', level,
      tests: (['meaning', 'word', 'context', 'usage'] as const).map(mode => ({ mode, prompt: `${mode} prompt`,
        choices: [0, 1, 2, 3].map(index => ({ text: `choice-${index}`, meaning: `意味${index}` })),
        correctIndex: 2, explanation: 'choice-2 is appropriate.', alternatives: [{ answer: 'another', explanation: '近い表現' }] })) };
    assert.equal(vocabularyGroups([word], level)[0].length, 1);
    for (const mode of ['meaning', 'word', 'context', 'usage'] as const) {
      for (let round = 0; round < 10; round++) {
        const item = buildVocabularyTest([word], round, mode)[0];
        assert.equal(item.prompt, `${mode} prompt`);
        assert.equal(item.choices![item.correctIndex!], 'choice-2');
        assert.ok(item.choices!.every((choice, index) => item.choiceMeanings![index] === `意味${choice.at(-1)}`));
        assert.deepEqual(item.alternatives, [{ answer: 'another', explanation: '近い表現' }]);
        assert.equal(checkVocabularyAnswer(item, item.correctIndex!), true);
      }
    }
    const incomplete = { ...word, tests: word.tests!.filter(test => test.mode !== 'context') };
    assert.throws(() => buildVocabularyTest([incomplete], 0, 'context'), /まだ準備されていません/);
  }
});

test('all 100 catalog words have one complete, deterministic four-choice question in each of the four selectable modes', () => {
  assert.equal(catalog.length, 100);
  assert.deepEqual(VOCABULARY_TEST_MODES.map(mode => mode.id), modes);
  const before = JSON.stringify(catalog);
  for (const mode of modes) {
    const items = buildVocabularyTest(catalog, 0, mode);
    assert.equal(items.length, 100, mode);
    assert.equal(new Set(items.map(item => item.wordId)).size, 100, mode);
    assert.equal(new Set(items.map(item => item.id)).size, 100, mode);
    assert.deepEqual(buildVocabularyTest(catalog, 0, mode), items);
    assert.notDeepEqual(buildVocabularyTest(catalog, 1, mode).map(item => item.wordId), items.map(item => item.wordId));
    for (const item of items) {
      const entry = catalog.find(candidate => candidate.id === item.wordId)!;
      assert.equal(item.mode, mode);
      if (mode === 'recall') {
        assert.equal(item.kind, 'recall'); assert.equal(item.choices, undefined);
        assert.deepEqual(item.answers, entry.recall.answers);
        assert.ok(checkVocabularyAnswer(item, entry.recall.answers[0]));
      } else {
        assert.equal(item.kind, 'choice');
        assert.equal(item.choices!.length, 4, `${mode}:${entry.word}`);
        assert.equal(new Set(item.choices!.map(choice => choice.trim().toLowerCase())).size, 4, `${mode}:${entry.word}`);
        for (let index = 0; index < 4; index++) assert.equal(checkVocabularyAnswer(item, index), index === item.correctIndex);
        const expected = mode === 'meaning' ? entry.meaning : mode === 'word' ? entry.word : mode === 'context' ? entry.recall.answers[0] : entry.questions[0].choices[entry.questions[0].correctIndex];
        assert.equal(item.choices![item.correctIndex!], expected);
        if (mode === 'meaning') assert.equal(item.prompt, entry.word);
        if (mode === 'word') assert.equal(item.prompt, entry.meaning);
        if (mode === 'context') {
          assert.match(item.prompt, /_{3,}/);
          assert.doesNotMatch(item.prompt, /1語で入れてください/);
          assert.equal(item.choices!.filter(choice => entry.recall.answers.includes(choice)).length, 1);
        }
        if (mode === 'context' || mode === 'word') {
          for (const alternative of entry.recall.alternatives ?? []) assert.ok(!item.choices!.includes(alternative.answer), `${mode}:${entry.word} must not mark accepted ${alternative.answer} as wrong`);
        }
        if (mode === 'usage') assert.match(item.explanation, new RegExp(`^正解は${item.correctIndex! + 1}。`));
      }
    }
    const answers = Object.fromEntries(items.map(item => [item.id, item.kind === 'recall' ? item.answers![0] : item.correctIndex!]));
    const summary = summarizeVocabularyTest(items, answers);
    assert.equal(summary.completed, true);
    assert.equal(summary[mode === 'recall' ? 'recall' : 'choice'].correct, 100);
    assert.deepEqual(summary.wrongWordIds, []);
  }
  assert.equal(JSON.stringify(catalog), before, 'Generating modes does not change the authored catalog or audio text');
});

test('generated choices come from the same-level and same-part-of-speech catalog, including a one-word retry', () => {
  for (const mode of ['meaning', 'word', 'context'] as const) {
    const items = buildVocabularyTest(catalog, 0, mode);
    for (const item of items) {
      const entry = catalog.find(candidate => candidate.id === item.wordId)!;
      for (const choice of item.choices!) {
        const known = catalog.find(candidate => (mode === 'meaning' ? candidate.meaning : candidate.word) === choice)!;
        assert.ok(known, `${mode}:${choice} must be authored catalog content`);
        assert.equal(known.level, entry.level, `${mode}:${entry.word}:${choice}`);
        assert.equal(known.partOfSpeech, entry.partOfSpeech, `${mode}:${entry.word}:${choice}`);
      }
    }
    const retry = buildVocabularyTest([catalog[0]], 1, mode, catalog);
    assert.equal(retry.length, 1); assert.equal(retry[0].wordId, catalog[0].id); assert.equal(retry[0].choices!.length, 4);
  }
});

test('question and answer positions change between rounds without changing correct answers', () => {
  for (const mode of ['meaning', 'word', 'context', 'usage'] as const) {
    const first = buildVocabularyTest(catalog, 0, mode);
    const second = buildVocabularyTest(catalog, 1, mode);
    assert.ok(new Set(first.map(item => item.correctIndex)).size > 1, mode);
    assert.ok(first.some(item => second.find(next => next.wordId === item.wordId)?.correctIndex !== item.correctIndex), mode);
  }
});

test('reviewed context choices exclude near-synonyms that would also fit the cloze', () => {
  const unsafe: Record<string, string[]> = {
    feasible: ['viable'], viable: ['feasible', 'sustainable'],
    retain: ['preserve', 'maintain', 'obtain'], preserve: ['retain', 'maintain'],
    mitigate: ['reduce', 'diminish'], reduce: ['diminish', 'mitigate'],
    develop: ['improve', 'expand'], improve: ['develop'], expand: ['improve', 'develop'],
    avoid: ['prevent'], prevent: ['avoid'],
    obtain: ['discover', 'provide'], discover: ['obtain'],
    substantial: ['sufficient'], compelling: ['coherent', 'plausible'],
    effective: ['suitable'], available: ['convenient'],
  };
  for (let round = 0; round < 3; round++) {
    for (const mode of ['meaning', 'word', 'context'] as const) {
      const items = buildVocabularyTest(catalog, round, mode);
      for (const [word, forbidden] of Object.entries(unsafe)) {
        const item = items.find(candidate => candidate.wordId === word)!;
        const forbiddenChoices = forbidden.map(word => catalog.find(entry => entry.word === word)!).map(entry => mode === 'meaning' ? entry.meaning : entry.word);
        assert.ok(item.choices!.every(choice => !forbiddenChoices.includes(choice)), `${mode}:${word} must not offer a second defensible answer`);
      }
    }
  }
});

test('choice pools deduplicate labels and accepted answers instead of inventing a fourth answer', () => {
  const base = catalog.find(entry => entry.id === 'avoid')!;
  const duplicate = { ...catalog.find(entry => entry.id === 'admit')!, id: 'admit-copy', word: ' ADMIT ' };
  const pool = [base, duplicate, ...catalog, ...catalog];
  for (const mode of ['meaning', 'word', 'context'] as const) {
    const item = buildVocabularyTest([base, base], 0, mode, pool)[0];
    assert.equal(new Set(item.choices!.map(choice => choice.trim().toLowerCase())).size, 4);
    assert.throws(() => buildVocabularyTest([base], 0, mode), /4択に必要な語が足りません/);
  }
  const accepted = { ...base, recall: { ...base.recall, answers: ['avoid', 'admit'] } };
  for (const mode of ['word', 'meaning'] as const) {
    const item = buildVocabularyTest([accepted], 0, mode, catalog)[0];
    const admit = catalog.find(entry => entry.id === 'admit')!;
    assert.ok(!item.choices!.includes(mode === 'meaning' ? admit.meaning : admit.word));
  }
  const unknown = { ...base, id: 'unreviewed' };
  assert.throws(() => buildVocabularyTest([unknown], 0, 'context', catalog), /4択に必要な語が足りません/);
});

test('explicit usage mode remaps numbered explanations while preserving unrelated dates and old callers', () => {
  const avoid = catalog.find(entry => entry.id === 'avoid')!;
  const withDate = { ...avoid, questions: [{ ...avoid.questions[0], explanation: `${avoid.questions[0].explanation} 2024の記録はそのままです。` }] };
  const authored = withDate.questions[0];
  for (let round = 0; round < 4; round++) {
    const item = buildVocabularyTest([withDate], round, 'usage')[0];
    const number = (old: number) => item.choices!.indexOf(authored.choices[old - 1]) + 1;
    assert.match(item.explanation, new RegExp(`正解は${number(2)}。`));
    assert.ok(item.explanation.includes(`${number(1)}の to leave`));
    assert.ok(item.explanation.includes(`${number(4)}の for leaving`));
    assert.ok(item.explanation.includes(`${number(3)}の avoid A from doing`));
    assert.ok(item.explanation.includes('2024の記録'));
  }
  const legacy = buildVocabularyTest([withDate]).find(item => item.kind === 'choice')!;
  assert.deepEqual(legacy.choices, authored.choices);
  assert.equal(legacy.explanation, authored.explanation);
  assert.equal(legacy.mode, undefined);
});

test('a valid typed alternative earns language credit without claiming the target word was recalled', () => {
  const reluctant = catalog.find(entry => entry.id === 'reluctant')!;
  const withAlternatives = { ...reluctant, recall: { ...reluctant.recall, alternatives: [
    { answer: 'hesitant', explanation: 'hesitant も自然です。ためらう気持ちを表します。今回の学習語は reluctant です。' },
  ] } };
  for (const mode of [undefined, 'recall'] as const) {
    const items = buildVocabularyTest([withAlternatives], 0, mode);
    const item = items.find(candidate => candidate.kind === 'recall')!;
    assert.deepEqual(item.alternatives, withAlternatives.recall.alternatives);
    assert.notEqual(item.alternatives, withAlternatives.recall.alternatives);
    assert.notEqual(item.alternatives![0], withAlternatives.recall.alternatives[0]);
    assert.equal(evaluateVocabularyAnswer(item, ' RELUCTANT. '), 'target');
    for (const answer of ['hesitant', ' HESITANT！ ', 'ｈｅｓｉｔａｎｔ']) {
      assert.equal(evaluateVocabularyAnswer(item, answer), 'alternative');
      assert.equal(checkVocabularyAnswer(item, answer), true);
    }
    for (const answer of ['', 'hesitnt', 'other unrecorded wording', 0]) {
      assert.equal(evaluateVocabularyAnswer(item, answer), 'incorrect');
      assert.equal(checkVocabularyAnswer(item, answer), false);
    }
    const answers = Object.fromEntries(items.map(candidate => [candidate.id, candidate.kind === 'recall' ? 'hesitant' : candidate.correctIndex!]));
    const summary = summarizeVocabularyTest(items, answers);
    assert.deepEqual(summary.recall, { correct: 1, total: 1 });
    assert.equal(summary.choice.correct, items.length - 1);
    assert.equal(summary.alternativeRecall, 1);
    assert.equal(summary.targetRecallCorrect, 0);
    assert.deepEqual(summary.wrongWordIds, ['reluctant']);
    assert.equal(summary.completed, true);
    const targetSummary = summarizeVocabularyTest(items, { ...answers, [item.id]: 'reluctant' });
    assert.equal(targetSummary.targetRecallCorrect, 1);
    assert.equal(targetSummary.alternativeRecall, 0);
    assert.deepEqual(targetSummary.wrongWordIds, []);
    const unanswered = summarizeVocabularyTest(items, {});
    assert.equal(unanswered.completed, false);
    assert.equal(unanswered.alternativeRecall, 0);
    assert.equal(unanswered.targetRecallCorrect, 0);
  }
  for (const mode of ['meaning', 'word', 'context', 'usage'] as const) {
    const item = buildVocabularyTest([withAlternatives], 0, mode, catalog)[0];
    assert.equal(item.alternatives, undefined, `${mode} must not expose typed answer metadata`);
    assert.equal(evaluateVocabularyAnswer(item, item.correctIndex!), 'target');
    assert.equal(evaluateVocabularyAnswer(item, 'hesitant'), 'incorrect');
  }
});

test('a typed alternative is never offered as a wrong choice, and target answers take precedence', () => {
  const avoid = catalog.find(entry => entry.id === 'avoid')!;
  // Synthetic collision ensures future edits cannot silently offer an accepted answer as a distractor.
  const entry = { ...avoid, recall: { ...avoid.recall, alternatives: [{ answer: ' ADMIT. ', explanation: 'A recorded alternative.' }] } };
  for (const mode of ['meaning', 'word'] as const) {
    const item = buildVocabularyTest([entry], 0, mode, catalog)[0];
    const admit = catalog.find(candidate => candidate.id === 'admit')!;
    assert.ok(!item.choices!.includes(mode === 'meaning' ? admit.meaning : admit.word));
  }
  // Context never substitutes an unreviewed word to fill a choice slot.
  assert.throws(() => buildVocabularyTest([entry], 0, 'context', catalog), /4択に必要な語が足りません/);
  const item = buildVocabularyTest([entry], 0, 'recall')[0];
  assert.equal(evaluateVocabularyAnswer({ ...item, alternatives: [{ answer: 'avoid', explanation: '' }] }, 'avoid'), 'target');
});
