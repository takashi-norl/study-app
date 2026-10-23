import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnthropicAdapter, priceResponse, quoteInput, assertPricingFresh, PRICING_POLICY } from './anthropic-adapter.mjs';
import { generationWork, parseGenerated, parseReviewed, reviewWork } from './prompts.mjs';
import { hashContent, unitIdFor } from './schema.mjs';
import { createRegistry, countDistinct } from './registry.mjs';
import { applyCanonicalAudit, baseLexicalSnapshot } from './canonical-families.mjs';

const date = '2026-10-24T00:00:00.000Z';
import { seed, generatedContent, response } from './test-fixtures.mjs';
test('provider quote includes full reasoning/output ceiling and cache accounting does not double-count thinking', () => {
  const work = generationWork([seed('resilient')], { id: 'test', createdAt: date });
  const quote = quoteInput(work.params, 1000, date);
  assert.equal(quote.reservedInputTokens, 50000); assert.equal(quote.reservedOutputTokens, 20000); assert.equal(quote.reservedUsd, 0.3);
  assert.equal(priceResponse(response({})), 0.0102);
  assert.equal(priceResponse({ ...response({}), usage: { ...response({}).usage, cache_read_input_tokens: 1000 } }), 0.0103);
  assert.throws(() => priceResponse({ ...response({}), model: 'unknown' }), /unverified/);
  assert.throws(() => priceResponse({ ...response({}), usage: { ...response({}).usage, cache_creation_input_tokens: 1 } }), /Unsupported/);
  assert.throws(() => quoteInput(work.params, 50000, date), /token bound/);
  assert.throws(() => assertPricingFresh('2026-11-10'), /stale/);
});
test('SDK adapter checks availability and actual structured input before bounded create', async () => {
  const events = [], work = generationWork([seed('resilient')], { id: 'test', createdAt: date });
  const adapter = createAnthropicAdapter({ now: () => new Date(date), client: {
    models: { retrieve: async model => { events.push('model'); return { id: model }; } },
    messages: { countTokens: async params => { events.push('count'); assert.equal(params.max_tokens, undefined); assert.deepEqual(params.output_config, work.params.output_config); return { input_tokens: 100 }; }, create: async params => { events.push('create'); assert.deepEqual(params, work.params); return response({}); } },
  } });
  await adapter.quote(work.params); await adapter.request(work.params); assert.deepEqual(events, ['model', 'count', 'create']);
  const bad = createAnthropicAdapter({ now: () => new Date(date), client: { models: { retrieve: async () => { throw new Error('SECRET RAW HEADERS'); } } } });
  await assert.rejects(bad.quote(work.params), error => error.message.includes('preflight failed') && !error.message.includes('SECRET'));
});
test('prompt metadata is bound into wire hash; compact output derives deterministic scoped IDs', () => {
  const target = seed('resilient'), work = generationWork([target], { id: 'test', createdAt: date });
  assert.throws(() => generationWork([target], { id: 'test', createdAt: 'October 24, 2026' }), /stable work/);
  const changedDate = generationWork([target], { id: 'test', createdAt: '2026-10-24T01:00:00.000Z' });
  assert.notEqual(hashContent(work.params), hashContent(changedDate.params));
  const [unit] = parseGenerated(response({ units: [generatedContent(target)] }), work);
  assert.equal(unit.senses[0].id, `${target.id}:core`); assert.equal(unit.provenance.createdAt, date);
  assert.throws(() => parseGenerated({ ...response({ units: [] }), stop_reason: 'max_tokens' }, work), /did not complete/);
  assert.throws(() => parseGenerated(response({ units: [generatedContent(target), generatedContent(target)] }), work), /count or IDs/);
  const review = reviewWork([unit], { id: 'review', createdAt: date });
  const verdict = { unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] };
  const [approved] = parseReviewed(response({ verdicts: [verdict] }), review);
  assert.notEqual(approved.receipt.reviewer, unit.provenance.author);
  assert.throws(() => parseReviewed(response({ verdicts: [{ ...verdict, contentSha256: 'a'.repeat(64) }] }), review), /current content/);
  assert.throws(() => parseReviewed(response({ verdicts: [{ ...verdict, issues: ['material defect'] }] }), review), /current content/);
});
test('canonical family audit preserves senses/card IDs and dedup while reducing lexical count', () => {
  const entries = [{ id: 'analog-adj', word: 'analog', partOfSpeech: 'adjective' }, { id: 'analogue-noun', word: 'analogue', partOfSpeech: 'noun' }, { id: 'annex-verb', word: 'annex', partOfSpeech: 'verb' }, { id: 'annexe-noun', word: 'annexe', partOfSpeech: 'noun' }];
  const registry = createRegistry({ frozenEntries: entries });
  const proposal = { schemaVersion: 1, id: 'families', createdBy: 'author', baseSnapshotSha256: hashContent(baseLexicalSnapshot(registry)), groups: [
    { canonicalLemma: 'analog', memberIds: ['analog-adj', 'analogue-noun'], reasonJa: '表記差の語族としてまとめ、形容詞・名詞の教材を保持する。' },
    { canonicalLemma: 'annex', memberIds: ['annex-verb', 'annexe-noun'], reasonJa: '表記差の語族としてまとめ、動詞・名詞の教材を保持する。' },
  ] };
  const review = { schemaVersion: 1, sourceSha256: hashContent(proposal), reviewedBy: 'independent', reviewedAt: date, approved: true, issues: [], coverage: 'all-base-lexical-families' };
  const audited = applyCanonicalAudit(registry, proposal, review);
  assert.equal(countDistinct(audited).lexicalUnits, 2); assert.equal(audited.units.size, 4); assert.equal(audited.forms.size, 4); assert.equal(countDistinct(registry).lexicalUnits, 4);
  assert.throws(() => applyCanonicalAudit(registry, proposal, { ...review, reviewedBy: 'author' }), /Independent/);
  const changed = createRegistry({ frozenEntries: [...entries, { id: 'extra', word: 'extra' }] });
  assert.throws(() => applyCanonicalAudit(changed, proposal, review), /stale/);
  const doubled = { ...proposal, groups: [...proposal.groups, proposal.groups[0]] };
  assert.throws(() => applyCanonicalAudit(registry, doubled, { ...review, sourceSha256: hashContent(doubled) }), /repeated/);
});
