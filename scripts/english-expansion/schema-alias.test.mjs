import assert from 'node:assert/strict';
import test from 'node:test';
import { generationWork, parseGenerated } from './prompts.mjs';
import { hashContent, validateUnit } from './schema.mjs';
import { generatedContent, response, seed } from './test-fixtures.mjs';

const date = '2026-10-24T00:00:00.000Z';
function fixture({ aliases = ['repercussions'], answer = 'repercussions' } = {}) {
  const target = { ...seed('repercussion'), aliases };
  const work = generationWork([target], { id: 'alias-validation-only', createdAt: date });
  const card = structuredClone(generatedContent(target));
  card.partOfSpeech = 'noun';
  card.meaningEn = 'An unintended effect, usually an unpleasant one, of an action or event.';
  card.meaningJa = '行動や出来事から生じる、通常は好ましくない影響';
  const question = card.tests.find(item => item.mode === 'word');
  question.prompt = '「その決定が及ぼす、好ましくない複数の影響」に合う英語を選びましょう。';
  question.choices = [
    { text: answer, meaningJa: '好ましくない影響', feedbackJa: '出来事から生じた影響を表します。' },
    { text: 'precautions', meaningJa: '予防策', feedbackJa: '問題を防ぐために事前に取る対策を表します。' },
    { text: 'intentions', meaningJa: '意図', feedbackJa: '行動する前の意図を表します。' },
    { text: 'permissions', meaningJa: '許可', feedbackJa: '行動することへの許可を表します。' },
  ];
  question.correctIndex = 0;
  return { target, work, raw: response({ units: [card] }) };
}

test('word-mode accepts a declared plural alias after normalization without changing the paid wire work or seed', () => {
  const { target, work, raw } = fixture({ answer: '  Repercussions  ' });
  const before = hashContent({ target, work, raw });
  const [unit] = parseGenerated(raw, work);
  assert.equal(unit.lemma, 'repercussion');
  assert.deepEqual(unit.aliases, ['repercussions']);
  assert.equal(unit.senses[0].tests.find(item => item.mode === 'word').choices[0].text, 'Repercussions');
  assert.equal(hashContent({ target, work, raw }), before);
  assert.equal(validateUnit(unit).id, target.id);
});

test('canonical word remains valid with or without alias declarations', () => {
  for (const aliases of [[], ['repercussions']]) {
    const { work, raw } = fixture({ aliases, answer: 'repercussion' });
    assert.equal(parseGenerated(raw, work)[0].lemma, 'repercussion');
  }
});

test('an undeclared plural or semantically valid synonym is still rejected; no automatic stemming or synonym expansion', () => {
  for (const options of [{ aliases: [], answer: 'repercussions' }, { aliases: ['repercussions'], answer: 'consequences' }]) {
    const { work, raw } = fixture(options);
    assert.throws(() => parseGenerated(raw, work), /canonical target or an explicitly declared alias/);
  }
});

test('a saved five-card result can retain all cards when one word answer uses its reviewed plural alias', () => {
  const first = fixture();
  const seeds = [first.target, ...['resilient', 'pragmatic', 'tenacious', 'meticulous'].map(seed)];
  const work = generationWork(seeds, { id: 'saved-five-alias', createdAt: date });
  const card = JSON.parse(first.raw.content.find(item => item.type === 'text').text).units[0];
  const raw = response({ units: [card, ...seeds.slice(1).map(generatedContent)] });
  assert.deepEqual(parseGenerated(raw, work).map(unit => unit.id), seeds.map(item => item.id));
});
