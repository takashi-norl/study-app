import assert from 'node:assert/strict';
import test from 'node:test';
import { generationWorkV4, AUTHOR_TASK_V4, AUTHOR_SYSTEM_V4, REVIEW_TASK_V4, REVIEW_SYSTEM_V4 } from './prompts-v4.mjs';
import { generationWorkV5, reviewWorkV5, checkedWorkV5, parseGeneratedV5, parseReviewedV5, GENERATION_POLICY_V5, REVIEW_POLICY_V5 } from './prompts-v5.mjs';
import { quoteOnePhraseInput, validateOnePhraseParams } from './one-phrase-benchmark-provider.mjs';
import { validateCheapParams } from './cheap-benchmark-provider.mjs';
import { hashContent, unitIdFor } from './schema.mjs';
import { seed, generatedContent, response } from './test-fixtures.mjs';
const createdAt = '2026-10-24T00:00:00.000Z';
const phrase = { ...seed('resilient'), kind: 'phrase', lemma: 'on the same wavelength', id: unitIdFor('phrase', 'on the same wavelength') };
const generation = () => generationWorkV5([phrase], { id: 'v5-generation', createdAt });

test('v5 changes one phrase and explicit disabled thinking without weakening the frozen v4 quality text', () => {
  assert.equal(GENERATION_POLICY_V5.system, AUTHOR_SYSTEM_V4); assert.equal(GENERATION_POLICY_V5.task, AUTHOR_TASK_V4);
  assert.equal(REVIEW_POLICY_V5.system, REVIEW_SYSTEM_V4); assert.equal(REVIEW_POLICY_V5.task, REVIEW_TASK_V4);
  const old = generationWorkV4([phrase], { id: 'v4-generation', createdAt }), oldHash = hashContent(old), work = generation();
  assert.deepEqual(work.params.thinking, { type: 'disabled' }); assert.equal(work.params.output_config.effort, 'medium'); assert.equal(work.params.max_tokens, 16000);
  assert.equal(checkedWorkV5(work), work); assert.equal(hashContent(old), oldHash); assert.equal(old.params.thinking, undefined);
  assert.throws(() => validateCheapParams(work.params, 'generation'), /Unsupported provider/);
  assert.throws(() => checkedWorkV5(old), /exact v5/);
  for (const rows of [[], [phrase, phrase], [seed('resilient')]]) assert.throws(() => generationWorkV5(rows, { id: 'v5-generation', createdAt }), /exactly one phrase/);
});
test('provider accepts only disabled without display/budget and retains medium; review cannot inherit disabled', () => {
  const work = generation(); assert.equal(quoteOnePhraseInput(work.params, 'generation', 50000, createdAt).reservedUsd, 0.018);
  for (const change of [p => delete p.thinking, p => { p.thinking = { type: 'adaptive' }; }, p => { p.thinking = { type: 'enabled', budget_tokens: 1000 }; },
    p => { p.thinking.display = 'omitted'; }, p => { p.thinking.budget_tokens = 1000; }, p => { p.output_config.effort = 'low'; }, p => { p.tools = []; }, p => { p.max_tokens = 8000; }]) {
    const params = structuredClone(work.params); change(params); assert.throws(() => validateOnePhraseParams(params, 'generation'));
    assert.throws(() => checkedWorkV5({ ...work, params }));
  }
  const units = parseGeneratedV5(response({ units: [generatedContent(phrase)] }), work), review = reviewWorkV5(units, { id: 'v5-review', createdAt });
  assert.equal(review.params.thinking, undefined); assert.equal(review.params.output_config.effort, 'high');
  assert.equal(quoteOnePhraseInput(review.params, 'review', 25000, createdAt).reservedUsd, 0.18);
  assert.throws(() => validateOnePhraseParams({ ...review.params, thinking: { type: 'disabled' } }, 'review'));
});
test('exact one-card parse preserves the seed and retains complete-card quality boundaries', () => {
  const work = generation(), payload = generatedContent(phrase), units = parseGeneratedV5(response({ units: [payload] }), work);
  assert.equal(units.length, 1); assert.equal(units[0].provenance.author, 'anthropic-expansion-author-v5');
  for (const [key, value] of Object.entries(phrase)) assert.deepEqual(units[0][key], value);
  assert.equal(units[0].senses[0].examples.length, 3); assert.equal(units[0].senses[0].tests.length, 4);
  for (const list of [[], [payload, payload]]) assert.throws(() => parseGeneratedV5(response({ units: list }), work), /count or IDs|Too small/);
  const altered = structuredClone(payload), context = altered.tests.find(row => row.mode === 'context'); context.choices = structuredClone(context.choices); context.choices[context.correctIndex].text = 'an unregistered phrase';
  assert.throws(() => parseGeneratedV5(response({ units: [altered] }), work), /registered lemma/);
  assert.throws(() => parseGeneratedV5({ ...response({ units: [payload] }), stop_reason: 'max_tokens' }, work), /no automatic retry/);
});
test('independent review binds the complete new version and never grants native publication or scale', () => {
  const units = parseGeneratedV5(response({ units: [generatedContent(phrase)] }), generation()), work = reviewWorkV5(units, { id: 'v5-review', createdAt });
  const verdict = { unitId: units[0].id, contentSha256: hashContent(units[0]), approved: true, issues: [] };
  const results = parseReviewedV5(response({ verdicts: [verdict] }), work);
  assert.equal(results[0].receipt.reviewer, 'anthropic-expansion-independent-reviewer-v5');
  assert.throws(() => parseReviewedV5(response({ verdicts: [{ ...verdict, contentSha256: '0'.repeat(64) }] }), work), /current content/);
  assert.throws(() => parseReviewedV5(response({ verdicts: [{ ...verdict, issues: ['A material issue remains.'] }] }), work), /current content/);
});
