import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertProductionDispatchReady, boundedRequest, dispatchWithMockProvider } from './dispatcher.mjs';
import { assertLease, initializeStore, persistDraft, persistLedger, persistRawResponse, publishReviewedUnit, readJson, registerPilotSeeds, withExpansionLock } from './store.mjs';
import { hashContent, senseIdFor, unitIdFor } from './schema.mjs';

const put = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const key = 'a'.repeat(64);
const seed = (lemma = 'resilient') => ({ id: unitIdFor('word', lemma), kind: 'word', lemma, aliases: [], primaryCollection: 'eiken-1', level: { cefrEstimate: 'C1', eikenEstimates: ['grade1'], policy: 'estimated-not-official' }, genres: ['general'], register: 'neutral', audience: { suitableFor: 'teens-and-adults', noteJa: '一般的な文脈で使えます。' }, pitfalls: [{ kind: 'meaning', noteJa: '文脈と語義を確認します。' }] });
function unit() {
  const base = seed(), id = senseIdFor(base.id, 'recovering');
  const choices = ['resilient', 'fragile', 'irrelevant', 'temporary'].map(text => ({ text, meaningJa: '選択肢の意味', feedbackJa: '文脈と語義を確認します。' }));
  return { ...base, schemaVersion: 1, senses: [{ id, key: 'recovering', partOfSpeech: 'adjective', meaningEn: 'Able to recover after difficulties.', meaningJa: '困難から回復できる', examples: ['The team remained resilient after the loss.', 'She became more resilient with practice.', 'The town has a resilient community.'].map((text, index) => ({ id: `${id}:example-${index + 1}`, text, meaningJa: '例文の日本語訳', contextJa: '困難からの回復' })), tests: ['meaning', 'word', 'context', 'usage'].map(mode => ({ mode, prompt: mode === 'context' ? 'The team remained ___.' : 'resilientに合う答えは？', choices, correctIndex: 0, explanationJa: '困難から回復する文脈に合います。', alternatives: [] })), relations: [] }], provenance: { authorship: 'original', author: 'writer', createdAt: '2026-10-23T00:00:00.000Z', usageReferences: [] } };
}
function request(id = 'pilot-one', target = seed()) { return { id, stage: 'generation', unitIds: [target.id], params: { model: 'mock-only', max_tokens: 1000, system: 'Test fixture only', messages: [{ role: 'user', content: target.lemma }] }, reservedUsd: 1 }; }
const receipt = candidate => ({ reviewer: 'independent-reviewer', reviewedAt: '2026-10-24T00:00:00.000Z', unitId: candidate.id, contentSha256: hashContent(candidate), approved: true, issues: [] });
const config = { phaseOneFingerprint: 'a'.repeat(64), allocationHash: 'b'.repeat(64) };
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-expansion-dispatch-'));
  const phaseOneOutput = join(root, 'base'), runtimeDirectory = join(root, 'runtime'), output = join(root, 'expansion'), sharedLockDirectory = join(runtimeDirectory, 'shared-spending.lock');
  const asset = join(phaseOneOutput, 'audio', 'assets', key);
  try {
    const frozen = { id: 'base', word: 'base' }, home = { id: 'home', word: 'home' };
    await put(join(phaseOneOutput, 'frozen-100.json'), [{ entry: frozen, contentSha256: hashContent(frozen) }]);
    await put(join(phaseOneOutput, 'approved', 'grade3', 'batch.json'), { schemaVersion: 1, entries: [{ entry: home, review: { status: 'approved', contentSha256: hashContent(home) } }] });
    await put(join(phaseOneOutput, 'manifest.json'), { words: [{ id: 'base', word: 'base', status: 'preserved' }, { id: 'home', word: 'home', status: 'approved' }] });
    await put(join(phaseOneOutput, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'base', status: 'complete', actualUsd: 0.01, reservedUsd: 1 }] });
    await put(join(phaseOneOutput, 'audio', 'reservations', `${key}.json`), { schemaVersion: 1, cacheKey: key, requestId: 'base-audio', characters: 100, reservedMicroUsd: 18200, createdAt: '2026-10-23T00:00:00.000Z' });
    await mkdir(join(phaseOneOutput, 'audio', 'retry-reservations'), { recursive: true });
    await put(join(asset, 'state.json'), { state: 'ready', updatedAt: '2026-10-23T00:00:03.000Z' });
    await put(join(asset, 'http-status.json'), { status: 200, contentType: 'application/json', receivedAt: '2026-10-23T00:00:03.000Z' });
    await put(join(asset, 'asset.json'), { cacheKey: key, characters: 100, mp3Sha256: 'f'.repeat(64), generatedAt: '2026-10-23T00:00:03.000Z' });
    await writeFile(join(asset, 'audio.mp3'), 'test-audio-only');
    await put(join(phaseOneOutput, 'audio', 'last-report.json'), { total: 1, ready: 1, existing: 0, missing: 0, failed: 0 });
    await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), '');
    let calls = 0;
    const provider = { mode: 'mock', request: async () => { calls++; return { usage: { cost: 0.01 }, data: { value: 'saved' } }; }, price: raw => raw.usage.cost, decode: raw => raw.data };
    const options = { phaseOneOutput, runtimeDirectory, output, sharedLockDirectory, mockExpectedBaseTarget: 2, request: request(), seeds: [seed()], provider };
    return await action({ root, options, asset, getCalls: () => calls });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('live adapter is hard-disabled; no credentials or network implementation can be selected', async () => {
  assert.throws(assertProductionDispatchReady, { code: 'LIVE_EXPANSION_NOT_INTEGRATED' });
  await assert.rejects(dispatchWithMockProvider({ provider: { mode: 'live' } }), { code: 'LIVE_EXPANSION_NOT_INTEGRATED' });
});
test('exclusive shared lock cannot be forged or stolen', async () => fixture(async ({ options }) => {
  await assert.rejects(assertLease({ output: options.output }, options.output), /real exclusive/);
  await withExpansionLock(options, async lease => {
    await assertLease(lease, options.output);
    await assert.rejects(withExpansionLock(options, () => {}), /already held/);
  });
  await withExpansionLock(options, lease => assertLease(lease, options.output));
}));
test('request and reservation are durable before provider entry; raw response precedes accounting and decoding', async () => fixture(async ({ options, getCalls }) => {
  const original = options.provider.request;
  options.provider.request = async params => {
    const ledger = await readJson(join(options.output, 'ledger.json'));
    assert.equal(ledger.calls[0].status, 'requested'); assert.equal(ledger.calls[0].reservedUsd, 1);
    assert.deepEqual((await readJson(join(options.output, 'requests', 'pilot-one', 'request.json'))).params, params);
    return original(params);
  };
  options.provider.price = raw => { const saved = JSON.parse(readFileSync(join(options.output, 'requests', 'pilot-one', 'response.json'))); assert.deepEqual(saved.response, raw); return raw.usage.cost; };
  options.provider.decode = raw => { assert.equal(JSON.parse(readFileSync(join(options.output, 'ledger.json'))).calls[0].status, 'complete'); return raw.data; };
  const result = await dispatchWithMockProvider(options);
  assert.equal(result.replayed, false); assert.equal(getCalls(), 1); assert.equal(result.actualUsd, 0.01);
  assert.equal((await dispatchWithMockProvider(options)).replayed, true); assert.equal(getCalls(), 1);
}));
test('request identity and exact provider input replay cannot cause duplicate payment', async () => fixture(async ({ options, getCalls }) => {
  await dispatchWithMockProvider(options);
  await assert.rejects(dispatchWithMockProvider({ ...options, request: { ...options.request, reservedUsd: 2 } }), /different inputs/);
  await assert.rejects(dispatchWithMockProvider({ ...options, request: { ...options.request, id: 'same-content-another-id' } }), /already have a paid request/);
  assert.equal(getCalls(), 1);
}));
test('unknown submit outcomes remain fully reserved and block both replay and new requests', async () => fixture(async ({ options }) => {
  let calls = 0; options.provider.request = async () => { calls++; throw new Error('Connection ended'); };
  await assert.rejects(dispatchWithMockProvider(options), /outcome is unknown/);
  const ledger = await readJson(join(options.output, 'ledger.json')); assert.equal(ledger.calls[0].status, 'uncertain'); assert.equal(ledger.calls[0].reservedUsd, 1);
  await assert.rejects(dispatchWithMockProvider(options), /Never resend/);
  const next = seed('coherent'); await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [next], request: request('next', next) }), /unresolved/);
  assert.equal(calls, 1);
}));
test('saved raw response recovers from pricing failure without resending', async () => fixture(async ({ options, getCalls }) => {
  options.provider.price = () => { throw new Error('Unknown model price'); };
  await assert.rejects(dispatchWithMockProvider(options), /billing is unresolved/);
  assert.equal((await readJson(join(options.output, 'ledger.json'))).calls[0].status, 'uncertain');
  options.provider.price = raw => raw.usage.cost;
  const result = await dispatchWithMockProvider(options); assert.equal(result.replayed, true); assert.equal(result.actualUsd, 0.01); assert.equal(getCalls(), 1);
}));
test('invalid generated content retains paid raw and known actual cost for offline repair', async () => fixture(async ({ options, getCalls }) => {
  options.provider.decode = () => { throw new Error('Invalid content'); };
  await assert.rejects(dispatchWithMockProvider(options), /Invalid content/);
  assert.equal((await readJson(join(options.output, 'ledger.json'))).calls[0].status, 'complete');
  options.provider.decode = raw => raw.data; assert.equal((await dispatchWithMockProvider(options)).replayed, true); assert.equal(getCalls(), 1);
}));
test('charges above the reservation retain their full actual and hold future spending', async () => fixture(async ({ options, getCalls }) => {
  options.provider.price = () => 2;
  await assert.rejects(dispatchWithMockProvider(options), /exceeded its reservation/);
  const call = (await readJson(join(options.output, 'ledger.json'))).calls[0]; assert.equal(call.actualUsd, 2); assert.equal(call.accountingHold, 'charge-exceeded-reservation');
  const next = seed('coherent'); await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [next], request: request('next', next) }), /accounting hold/); assert.equal(getCalls(), 1);
}));
test('missing spending history cannot silently initialize a fresh budget', async () => fixture(async ({ options }) => {
  await dispatchWithMockProvider(options); await rm(join(options.output, 'ledger.json'));
  await assert.rejects(dispatchWithMockProvider(options), /missing its spending ledger/);
}));
test('first pilot is limited to 20 unique items and provider requests to five', async () => fixture(async ({ options, getCalls }) => {
  const seeds = Array.from({ length: 21 }, (_, i) => seed(`candidate${String.fromCharCode(97 + i)}`));
  await assert.rejects(dispatchWithMockProvider({ ...options, seeds, request: request('large', seeds[0]) }), /20 distinct/); assert.equal(getCalls(), 0);
  assert.throws(() => boundedRequest({ ...request(), unitIds: seeds.slice(0, 6).map(x => x.id) }), /1–5/);
  assert.throws(() => boundedRequest({ ...request(), params: { ...request().params, apiKey: 'never-read-real-key' } }), /credentials/);
}));
test('real phase-one evidence blocks stopped-but-incomplete, running, pending and unknown conditions', async () => {
  const cases = [
    async o => rm(join(o.runtimeDirectory, 'stop-production')),
    async o => mkdir(join(o.runtimeDirectory, 'production.lock')),
    async o => put(join(o.phaseOneOutput, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'pending', status: 'requested', reservedUsd: 1 }] }),
    async o => rm(join(o.phaseOneOutput, 'audio', 'assets', key, 'state.json')),
    async o => put(join(o.phaseOneOutput, 'manifest.json'), { words: [{ id: 'base', status: 'preserved' }, { id: 'home', status: 'held' }] }),
    async o => put(join(o.phaseOneOutput, 'audio', 'last-report.json'), { total: 1, ready: 0, existing: 0, missing: 1, failed: 0 }),
  ];
  for (const mutate of cases) await fixture(async ({ options, getCalls }) => { await mutate(options); await assert.rejects(dispatchWithMockProvider(options), /checkpoint|running|settled|not complete|not drained/); assert.equal(getCalls(), 0); });
});
test('a previously frozen base cannot silently change beneath future reservations', async () => fixture(async ({ options, getCalls }) => {
  await dispatchWithMockProvider(options);
  const ledger = await readJson(join(options.phaseOneOutput, 'ledger.json')); ledger.calls[0].actualUsd = 0.02; await put(join(options.phaseOneOutput, 'ledger.json'), ledger);
  const next = seed('coherent'); await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [next], request: request('next', next) }), /baseline/); assert.equal(getCalls(), 1);
}));
test('settled held inventory is excluded from completion but retained in dedup', async () => fixture(async ({ options, getCalls }) => {
  const path = join(options.phaseOneOutput, 'manifest.json'), manifest = await readJson(path);
  manifest.words.push({ id: 'held-specialist', word: 'specialist', aliases: ['technical'], status: 'inventoried', inventoryHold: { reviewId: 'hold-1' } }); await put(path, manifest);
  await dispatchWithMockProvider(options); assert.equal(getCalls(), 1);
  for (const lemma of ['specialist', 'technical']) {
    const target = seed(lemma); await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [target], request: request(`held-${lemma}`, target) }), /overlap/);
  }
  assert.equal(getCalls(), 1);
}));
test('pilot aliases cannot reintroduce base or previously registered forms', async () => fixture(async ({ options }) => {
  const overlap = seed('home'); await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [overlap], request: request('overlap', overlap) }), /overlap/);
  await dispatchWithMockProvider(options);
  const alias = { ...seed('recovery'), aliases: ['resilient'] }; await assert.rejects(dispatchWithMockProvider({ ...options, seeds: [alias], request: request('alias', alias) }), /overlap/);
}));
test('approved assets require an immutable draft, exact seed and independent current hash', async () => fixture(async ({ options }) => withExpansionLock(options, async lease => {
  await initializeStore(lease, config); await registerPilotSeeds(lease, [seed()]);
  const candidate = unit(); await assert.rejects(publishReviewedUnit(lease, candidate, receipt(candidate)), /ENOENT/);
  const wrongSeed = structuredClone(candidate); wrongSeed.level.cefrEstimate = 'B2'; await assert.rejects(persistDraft(lease, wrongSeed), /registered pilot seed/);
  await persistDraft(lease, candidate);
  await assert.rejects(publishReviewedUnit(lease, candidate, { ...receipt(candidate), reviewer: 'writer' }), /Independent/);
  const changed = structuredClone(candidate); changed.senses[0].meaningJa = '変更された語義'; await assert.rejects(publishReviewedUnit(lease, changed, receipt(candidate)), /Independent/);
  const linked = structuredClone(candidate); linked.senses[0].relations.push({ type: 'synonym', targetUnitId: 'base-recover', targetSenseId: 'base-recover:health', contextJa: '回復', substitutable: false, limitationJa: '品詞の違い' });
  await persistDraft(lease, linked); await assert.rejects(publishReviewedUnit(lease, linked, receipt(linked)), /Unresolved/);
  const approved = await publishReviewedUnit(lease, candidate, receipt(candidate)); assert.equal(approved.review.approved, true);
  assert.deepEqual(await readJson(join(options.output, 'approved', `${candidate.id}.json`)), approved);
  await publishReviewedUnit(lease, candidate, receipt(candidate));
})));
test('spending history and provider evidence cannot be removed, rolled back or overwritten', async () => fixture(async ({ options }) => {
  await dispatchWithMockProvider(options);
  await withExpansionLock(options, async lease => {
    const ledger = await readJson(join(options.output, 'ledger.json'));
    await assert.rejects(persistLedger(lease, { schemaVersion: 1, calls: [] }), /removed/);
    for (const mutate of [c => { c.status = 'reserved'; }, c => { c.reservedUsd = 0.5; }, c => { c.actualUsd = 0; }]) {
      const invalid = structuredClone(ledger); mutate(invalid.calls[0]); await assert.rejects(persistLedger(lease, invalid), /rolled back|immutable/);
    }
    await assert.rejects(persistRawResponse(lease, boundedRequest(options.request), { changed: true }), /differs/);
  });
}));
test('saved complete raw content is checked against its accounting hash before reuse', async () => fixture(async ({ options, getCalls }) => {
  await dispatchWithMockProvider(options);
  const path = join(options.output, 'requests', 'pilot-one', 'response.json'), record = await readJson(path); record.response.data.value = 'tampered'; await put(path, record);
  await assert.rejects(dispatchWithMockProvider(options), /response evidence has changed/); assert.equal(getCalls(), 1);
}));
test('first pilot cannot grow beyond ten generation/review requests', async () => fixture(async ({ options, getCalls }) => {
  for (let i = 0; i < 10; i++) await dispatchWithMockProvider({ ...options, request: { ...options.request, id: `request-${i}`, params: { ...options.request.params, system: `Explicit revision ${i}` } } });
  await assert.rejects(dispatchWithMockProvider({ ...options, request: { ...options.request, id: 'request-eleven', params: { ...options.request.params, system: 'Would exceed bounded pilot' } } }), /request limit/);
  assert.equal(getCalls(), 10);
}));
