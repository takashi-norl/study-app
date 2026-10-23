import assert from 'node:assert/strict';
import test from 'node:test';
import { generationWork, reviewWork } from './prompts.mjs';
import { generationWorkV2, reviewWorkV2 } from './prompts-v2.mjs';
import { generationWorkV3, reviewWorkV3, validateQualityBenchmark, QUESTION_QUALITY_V3 } from './prompts-v3.mjs';
import { checkedVersionedWork, parseVersionedGeneration, parseVersionedReview, newGenerationWork } from './work-versions.mjs';
import { hashContent } from './schema.mjs';
import { quoteInput, priceResponse } from './anthropic-adapter.mjs';
import { seed, generatedContent, response } from './test-fixtures.mjs';
const createdAt = '2026-10-24T00:00:00.000Z';
const target = seed('resilient');

test('v3 has a distinct exact high wire identity; v1/v2 builders and parsers retain provenance', () => {
  const generations = [generationWork, generationWorkV2, generationWorkV3].map(build => build([target], { id: 'same-id', createdAt }));
  assert.equal(newGenerationWork([target], { id: 'same-id', createdAt }).promptVersion, 'v2');
  assert.equal(new Set(generations.map(work => hashContent(work.params))).size, 3);
  assert.deepEqual(generations.map(work => work.params.output_config.effort), ['low', 'medium', 'high']);
  generations.forEach((work, i) => {
    assert.deepEqual(checkedVersionedWork(work), work);
    const [unit] = parseVersionedGeneration(response({ units: [generatedContent(target)] }), work);
    assert.equal(unit.provenance.author, `anthropic-expansion-author-v${i + 1}`);
    const review = [reviewWork, reviewWorkV2, reviewWorkV3][i]([unit], { id: 'review', createdAt });
    const [result] = parseVersionedReview(response({ verdicts: [{ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] }] }), review);
    assert.equal(result.receipt.reviewer, `anthropic-expansion-independent-reviewer-v${i + 1}`);
  });
  const changed = structuredClone(generations[2]); changed.params.output_config.effort = 'medium';
  assert.throws(() => checkedVersionedWork(changed), /historical prompt/);
  assert.throws(() => checkedVersionedWork({ ...generations[1], promptVersion: 'v3' }), /historical prompt/);
  assert.throws(() => generationWorkV3([target, seed('another')], { id: 'two', createdAt }), /exactly one/);
});

test('high preserves token ceiling, pricing and exact content verdict rules', () => {
  const work = generationWorkV3([target], { id: 'generation', createdAt });
  const quote = quoteInput(work.params, 1000, createdAt);
  assert.equal(quote.reservedOutputTokens, 20000); assert.equal(quote.reservedUsd, 0.3);
  assert.equal(priceResponse(response({})), 0.0102);
  assert.throws(() => quoteInput({ ...work.params, max_tokens: 20001 }, 1000, createdAt), /Unsupported/);
  const [unit] = parseVersionedGeneration(response({ units: [generatedContent(target)] }), work);
  const review = reviewWorkV3([unit], { id: 'review', createdAt });
  assert.equal(review.params.max_tokens, 8000); assert.equal(review.params.output_config.effort, 'high');
  assert.throws(() => parseVersionedReview(response({ verdicts: [{ unitId: unit.id, contentSha256: 'a'.repeat(64), approved: true, issues: [] }] }), review), /current content/);
  assert.throws(() => parseVersionedReview(response({ verdicts: [{ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: ['Wrong feedback.'] }] }), review), /current content/);
  assert.match(QUESTION_QUALITY_V3, /No deliberately broken grammar distractors/);
  assert.match(QUESTION_QUALITY_V3, /If an alternative is defensible, fix the question/);
});

test('quality benchmark config is strict and binds the registered seed and separate request IDs', () => {
  const work = generationWorkV3([target], { id: 'generation', createdAt });
  const config = { schemaVersion: 1, promptVersion: 'v3', model: work.params.model, effort: 'high', maxUnits: 1, maxPaidRequests: 2,
    unitId: target.id, seedSha256: hashContent(target), generationWorkId: work.id, generationWorkSha256: hashContent(work), reviewWorkId: 'review' };
  assert.deepEqual(validateQualityBenchmark(config, [target]), config);
  for (const patch of [{ maxUnits: 2 }, { maxPaidRequests: 3 }, { effort: 'medium' }, { promptVersion: 'v2' }, { retry: true }, { unitId: 'unknown' }, { seedSha256: 'a'.repeat(64) }, { reviewWorkId: work.id }]) assert.throws(() => validateQualityBenchmark({ ...config, ...patch }, [target]));
});
