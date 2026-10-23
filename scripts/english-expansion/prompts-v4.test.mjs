import assert from 'node:assert/strict';
import test from 'node:test';
import { generationWorkV3 } from './prompts-v3.mjs';
import { generationWorkV4, reviewWorkV4, checkedWorkV4, parseGeneratedV4, parseReviewedV4,
  GENERATION_POLICY_V4, REVIEW_POLICY_V4, GENERATION_POLICY_SHA256_V4, REVIEW_POLICY_SHA256_V4 } from './prompts-v4.mjs';
import { hashContent } from './schema.mjs';
import { seed, generatedContent, response } from './test-fixtures.mjs';

const createdAt = '2026-10-24T00:00:00.000Z';
const seeds = ['resilient', 'candid', 'meticulous'].map(seed);
test('v4 authoring is fixed to three-or-fewer distinct seeds, Haiku medium and a separate exact wire identity', () => {
  const original = hashContent(seeds), work = generationWorkV4(seeds, { id: 'v4-author', createdAt });
  assert.equal(work.params.model, 'claude-haiku-5-5');
  assert.equal(work.params.output_config.effort, 'medium');
  assert.equal(work.params.max_tokens, 16000);
  assert.equal(hashContent(seeds), original);
  assert.deepEqual(checkedWorkV4(work), work);
  assert.notEqual(hashContent(generationWorkV4([seeds[0]], { id: 'same', createdAt }).params), hashContent(generationWorkV3([seeds[0]], { id: 'same', createdAt }).params));
  for (const rows of [[], [seeds[0], seeds[0]], [...seeds, seed('different')]]) assert.throws(() => generationWorkV4(rows, { id: 'v4-author', createdAt }), /1–3 unique/);
  assert.throws(() => generationWorkV4(seeds, { id: '../escape', createdAt }));
  assert.throws(() => generationWorkV4(seeds, { id: 'v4-author', createdAt, model: 'claude-sonnet-5-5' }), /fixed/);
});
test('fixed policy hashes bind actual prompt, structured output, model and token parameters', () => {
  assert.equal(GENERATION_POLICY_SHA256_V4, hashContent(GENERATION_POLICY_V4));
  assert.equal(REVIEW_POLICY_SHA256_V4, hashContent(REVIEW_POLICY_V4));
  const work = generationWorkV4(seeds, { id: 'v4-author', createdAt });
  for (const change of [w => { w.params.output_config.effort = 'high'; }, w => { w.params.max_tokens = 20000; }, w => { w.params.system += 'changed'; }, w => { w.seeds[0].aliases.push('foreign'); }, w => { w.unitIds.reverse(); }, w => { w.promptVersion = 'v3'; }]) {
    const altered = structuredClone(work); change(altered); assert.throws(() => checkedWorkV4(altered));
  }
});
test('v4 parsing preserves exact seeds and three examples while requiring every requested ID once', () => {
  const work = generationWorkV4(seeds, { id: 'v4-author', createdAt });
  const units = parseGeneratedV4(response({ units: seeds.map(generatedContent) }), work);
  assert.equal(units.length, 3);
  for (const unit of units) {
    assert.equal(unit.provenance.author, 'anthropic-expansion-author-v4');
    assert.equal(unit.senses[0].examples.length, 3);
    assert.equal(unit.senses[0].tests.length, 4);
    const exactSeed = seeds.find(s => s.id === unit.id);
    for (const [key, value] of Object.entries(exactSeed)) assert.deepEqual(unit[key], value);
  }
  assert.throws(() => parseGeneratedV4(response({ units: seeds.slice(0, 2).map(generatedContent) }), work), /count or IDs/);
  assert.throws(() => parseGeneratedV4(response({ units: [generatedContent(seeds[0]), generatedContent(seeds[0]), generatedContent(seeds[2])] }), work), /count or IDs/);
  const truncated = response({ units: seeds.map(generatedContent) }); truncated.stop_reason = 'max_tokens';
  assert.throws(() => parseGeneratedV4(truncated, work), /no automatic retry/);
  const changedContext = seeds.map(generatedContent);
  const cloze = changedContext[0].tests.find(t => t.mode === 'context');
  cloze.choices = structuredClone(cloze.choices); cloze.choices[cloze.correctIndex].text = 'unregistered';
  assert.throws(() => parseGeneratedV4(response({ units: changedContext }), work), /context answer must preserve/);
});
test('v4 review uses independent Sonnet high and exact whole-card hashes, never the author model', () => {
  const generation = generationWorkV4(seeds, { id: 'v4-author', createdAt });
  const units = parseGeneratedV4(response({ units: seeds.map(generatedContent) }), generation);
  const work = reviewWorkV4(units, { id: 'v4-review', createdAt });
  assert.equal(work.params.model, 'claude-sonnet-5-5'); assert.equal(work.params.output_config.effort, 'high'); assert.equal(work.params.max_tokens, 8000);
  assert.deepEqual(checkedWorkV4(work), work);
  const verdicts = units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] }));
  const results = parseReviewedV4(response({ verdicts }), work);
  results.forEach(r => assert.equal(r.receipt.reviewer, 'anthropic-expansion-independent-reviewer-v4'));
  const stale = structuredClone(verdicts); stale[0].contentSha256 = '0'.repeat(64);
  assert.throws(() => parseReviewedV4(response({ verdicts: stale }), work), /current content/);
  const inconsistent = structuredClone(verdicts); inconsistent[0].issues = ['A material error remains.'];
  assert.throws(() => parseReviewedV4(response({ verdicts: inconsistent }), work), /current content/);
  assert.throws(() => reviewWorkV4(units, { id: 'v4-review', createdAt, model: 'claude-haiku-5-5' }), /fixed/);
  assert.throws(() => parseReviewedV4(response({ verdicts }), generation), /Expected v4 review/);
});
