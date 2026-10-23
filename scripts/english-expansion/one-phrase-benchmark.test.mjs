import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { generationWorkV5, reviewWorkV5, parseGeneratedV5, REVIEW_POLICY_V5 } from './prompts-v5.mjs';
import { generationWorkV3 } from './prompts-v3.mjs';
import { hashContent, unitIdFor } from './schema.mjs';
import { seed, generatedContent, response, historicalReceiptFixture } from './test-fixtures.mjs';
import { ONE_PHRASE_PRICING_SHA256, quoteOnePhraseInput, priceOnePhraseResponse } from './one-phrase-benchmark-provider.mjs';
import { onePhraseBenchmarkFiles, dispatchOnePhraseBenchmark, dispatchOnePhraseBenchmarkWithMockSdk } from './one-phrase-benchmark.mjs';
import { approvedSnapshot } from './cheap-benchmark.mjs';
import { sha256File } from './activation.mjs';
import { loadRegistry } from './loaders.mjs';
import { baseLexicalSnapshot } from './canonical-families.mjs';
import { SPENDING_FENCE_PROTOCOL } from '../shared-spending-fence.mjs';
import { withExpansionLock, initializeStore, registerPilotSeeds } from './store.mjs';
import { inspectPhaseOneGate } from './dispatcher.mjs';
import { TARGET_ALLOCATION } from './allocation.mjs';
import { measuredPilotSnapshot } from './scale-approval.mjs';
const phraseSeed = lemma => ({ ...seed('resilient'), id: unitIdFor('phrase', lemma), kind: 'phrase', lemma, primaryCollection: 'idioms-phrasal' });
const date = '2026-10-24T00:00:00.000Z', put = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const read = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-one-phrase-benchmark-'))), runtimeDirectory = join(root, 'runtime'), phaseOneOutput = join(root, 'base'), output = join(root, 'expansion'), sharedLockDirectory = join(runtimeDirectory, 'shared-spending.lock');
  const paths = { runtimeDirectory, phaseOneOutput, output, sharedLockDirectory };
  try {
    const entries = Array.from({ length: 7500 }, (_, i) => ({ id: `frozen-${i}`, word: `baseword${i}` }));
    await put(join(phaseOneOutput, 'frozen-100.json'), entries.map(entry => ({ entry, contentSha256: hashContent(entry) })));
    await put(join(phaseOneOutput, 'manifest.json'), { words: entries.map(entry => ({ ...entry, status: 'preserved' })) });
    await put(join(phaseOneOutput, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'base-call', status: 'complete', actualUsd: 0.1, reservedUsd: 1 }] });
    await mkdir(join(phaseOneOutput, 'approved'), { recursive: true }); await mkdir(join(phaseOneOutput, 'audio', 'reservations'), { recursive: true });
    await put(join(phaseOneOutput, 'audio', 'last-report.json'), { total: 0, ready: 0, existing: 0, missing: 0, failed: 0 });
    await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), 'test stop');
    await writeFile(join(runtimeDirectory, 'production.mjs'), '// synthetic no-op'); await writeFile(join(runtimeDirectory, 'run.mjs'), '// synthetic no-op');
    const seeds = [phraseSeed('on the same wavelength')], work = generationWorkV5(seeds, { id: 'haiku-generation-one', createdAt: date });
    const inventory = { schemaVersion: 1, id: 'pilot-seeds', createdBy: 'independent-author', seeds };
    const proposal = { schemaVersion: 1, id: 'canonical-base', createdBy: 'family-author', baseSnapshotSha256: hashContent(baseLexicalSnapshot(await loadRegistry({ phaseOneOutput }))), groups: [] };
    const config = { schemaVersion: 1, enabled: false, protocol: SPENDING_FENCE_PROTOCOL, scope: 'phase-two-initial-pilot', textOnly: true, pilot: { maxUnits: 20, maxPaidRequests: 10 }, paths,
      expenseCoverage: 'reviewed-ledgers-plus-bounded-historical-allowance', historicalCommitments: historicalReceiptFixture(), cashPurchases: [{ id: 'confirmed-topup', provider: 'elevenlabs', fundingPool: 'audio', amountUsdPreTax: 100 }],
      inventory: { source: inventory, review: { schemaVersion: 1, sourceSha256: hashContent(inventory), reviewedBy: 'independent-seed-reviewer', reviewedAt: date, verdicts: seeds.map(seed => ({ id: seed.id, approved: true, issues: [] })) } },
      canonicalAudit: { proposal, review: { schemaVersion: 1, sourceSha256: hashContent(proposal), reviewedBy: 'independent-family-reviewer', reviewedAt: date, approved: true, issues: [], coverage: 'all-base-lexical-families' } } };
    const configPath = join(runtimeDirectory, 'shared-spending-integration.json'); await put(configPath, config);
    await withExpansionLock(paths, async lease => {
      const gate = await inspectPhaseOneGate(lease, { ...paths, cashPurchases: config.cashPurchases, historicalCommitments: config.historicalCommitments, canonicalAudit: config.canonicalAudit });
      await initializeStore(lease, { phaseOneFingerprint: gate.phaseOneFingerprint, allocationHash: hashContent(TARGET_ALLOCATION) });
      await registerPilotSeeds(lease, seeds);
    });
    // Preserve six settled historical calls, including textless v4 truncation, and five native approvals.
    const ledger = { schemaVersion: 1, calls: [] };
    for (let i = 0; i < 6; i++) {
      const id = `old-call-${i}`, requestHash = hashContent({ id }), oldResponse = i === 5
        ? { ...response({}), model: 'claude-haiku-5-5', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }], usage: { input_tokens: 4785, output_tokens: 16000, thinking_tokens: 16000 } }
        : response({ old: i });
      const raw = { schemaVersion: 1, requestId: id, requestHash, response: oldResponse, savedAt: date };
      ledger.calls.push({ id, stage: 'generation', unitIds: [seed(`oldword${i}`).id], params: { model: 'claude-sonnet-5-5' }, adapterVersion: 1, requestHash, reservedUsd: i === 5 ? 0.018 : 0.3, status: 'complete', actualUsd: i === 5 ? 0.008479 : 0.01, responseHash: hashContent(raw.response) });
      await put(join(output, 'requests', id, 'response.json'), raw);
      if (i < 5) await put(join(output, 'approved', `${seed(`oldword${i}`).id}.json`), { unit: { id: seed(`oldword${i}`).id }, originalNativeApproval: i });
    }
    await put(join(output, 'ledger.json'), ledger);
    const hold = { schemaVersion: 1, reason: 'existing-quality-hold', automaticallyReleasable: false, scaleAuthorized: false };
    await put(join(output, 'native-recoveries', 'scale-hold.json'), hold);
    const researchPath = join(output, 'reviews', 'research.json'), research = { testOnly: true }; await put(researchPath, research);
    const state = await read(join(output, 'store.json'));
    const authority = { schemaVersion: 1, kind: 'haiku-one-unused-phrase-benchmark-v5', id: 'benchmark-one', reviewedBy: '/root', reviewedAt: date, approved: true, textOnly: true, scaleAuthorized: false,
      maxPaidRequests: 2, maxUnits: 1, maxTotalReservedUsd: 0.198, pricingPolicySha256: ONE_PHRASE_PRICING_SHA256, paths, disabledConfigSha256: hashContent(config), storeSha256: hashContent(state),
      baselineLedgerSha256: hashContent(ledger), baselineRequestIds: ledger.calls.map(call => call.id), approvedSnapshotSha256: hashContent(await approvedSnapshot(output)), nativeScaleHoldSha256: hashContent(hold), research: { path: researchPath, sha256: hashContent(research) },
      policyDecision: { seedSelectionReason: 'Use one registered phrase never sent in any prior request.', outputCapReason: 'Keep the previous 16000 cap while changing only explicit thinking and item count.' },
      files: await Promise.all(onePhraseBenchmarkFiles(runtimeDirectory).map(async file => ({ id: file.id, sha256: await sha256File(file.path) }))),
      generation: { id: work.id, workSha256: hashContent(work), seeds: seeds.map(seed => ({ id: seed.id, sha256: hashContent(seed) })), reservedUsd: 0.018 },
      review: { id: 'sonnet-review-one', policySha256: hashContent(REVIEW_POLICY_V5), reservedUsd: 0.18 } };
    const authorityPath = join(output, 'reviews', 'benchmark-authority.json'); await put(authorityPath, authority);
    let calls = 0, counts = 0, onCreate, inputTokens = 1000;
    const sdk = { testOnly: true, networkEnabled: false, models: { retrieve: async model => ({ id: model }) }, messages: {
      countTokens: async () => { counts++; return { input_tokens: inputTokens }; },
      create: async params => {
        calls++; const current = await read(join(output, 'ledger.json')); assert.equal(current.calls.at(-1).status, 'requested');
        assert.equal(await sha256File(join(output, 'requests', current.calls.at(-1).id, 'work.json')).then(Boolean), true);
        if (onCreate) return onCreate(params);
        const prompt = JSON.parse(params.messages[0].content), payload = prompt.seeds ? { units: prompt.seeds.map(generatedContent) } : { verdicts: prompt.units.map(row => ({ unitId: row.unitId, contentSha256: row.contentSha256, approved: true, issues: [] })) };
        return { ...response(payload), model: params.model, ...(params.thinking ? { content: [{ type: 'text', text: JSON.stringify(payload) }], usage: { input_tokens: 100, output_tokens: 1000, thinking_tokens: 0 } } : {}) };
      },
    } };
    const options = { ...paths, work, authorityPath, send: true };
    await action({ root, options, sdk, authority, config, configPath, state, ledger, seeds, getCalls: () => calls, getCounts: () => counts, setCreate: fn => { onCreate = fn; }, setInput: n => { inputTokens = n; },
      rebindConfig: async () => { await put(configPath, config); authority.disabledConfigSha256 = hashContent(config); await put(authorityPath, authority); } });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function reviewOptions(f) {
  const raw = await read(join(f.options.output, 'requests', f.options.work.id, 'response.json')), units = parseGeneratedV5(raw.response, f.options.work);
  const work = reviewWorkV5(units, { id: f.authority.review.id, createdAt: date }), reviewAuthorityPath = join(f.options.output, 'reviews', 'review-authority.json');
  await put(reviewAuthorityPath, { schemaVersion: 1, benchmarkSha256: hashContent(f.authority), generationRawSha256: hashContent(raw), reviewWorkSha256: hashContent(work), reviewedBy: '/root', reviewedAt: date, approved: true });
  return { ...f.options, work, reviewAuthorityPath };
}

test('fixed model/tier reservations include reasoning exactly once and enforce the 100k Haiku pricing tier', () => {
  const work = generationWorkV5([phraseSeed('on the same wavelength')], { id: 'quote-one', createdAt: date });
  assert.equal(quoteOnePhraseInput(work.params, 'generation', 50000, date).reservedUsd, 0.018);
  assert.equal(quoteOnePhraseInput(work.params, 'generation', 50000, date).reservedInputTokens, 100000);
  assert.throws(() => quoteOnePhraseInput(work.params, 'generation', 50001, date), /bound/);
  assert.throws(() => quoteOnePhraseInput(work.params, 'generation', 10, '2026-11-02T00:00:00Z'), /stale/);
  const raw = { ...response({}), model: 'claude-haiku-5-5' };
  assert.equal(priceOnePhraseResponse(raw, 'generation'), 0.00051); raw.usage.thinking_tokens = 999;
  assert.equal(priceOnePhraseResponse(raw, 'generation'), 0.00051);
  raw.usage.input_tokens = 100001; assert.throws(() => priceOnePhraseResponse(raw, 'generation'), /pricing tier/);
  raw.usage.input_tokens = 100; raw.usage.cache_read_input_tokens = 1; assert.throws(() => priceOnePhraseResponse(raw, 'generation'), /Unrecognized/);
});
test('dry-run needs no credentials/provider calls; missing or stale authority cannot fall back to the old scope', async () => fixture(async f => {
  const result = await dispatchOnePhraseBenchmark({ ...f.options, send: false }); assert.equal(result.maximumPairReservedUsd, 0.198); assert.equal(result.paidCalls, 0);
  assert.deepEqual(await read(join(f.options.output, 'ledger.json')), f.ledger);
  await rm(f.options.authorityPath); await assert.rejects(dispatchOnePhraseBenchmark(f.options)); assert.equal(f.getCalls(), 0);
}));
test('one unused phrase generates once; optional exact Sonnet review records results without publishing or lifting scale hold', async () => fixture(async f => {
  const approved = await approvedSnapshot(f.options.output), result = await dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk);
  assert.equal(result.unitIds.length, 1); assert.equal(result.actualUsd, 0.00051); assert.equal(f.getCalls(), 1);
  assert.equal((await dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)).replayed, true); assert.equal(f.getCalls(), 1);
  const review = await reviewOptions(f); const judged = await dispatchOnePhraseBenchmarkWithMockSdk(review, f.sdk);
  assert.equal(judged.approvedByModel.length, 1); assert.equal(judged.published, 0); assert.equal(judged.scaleAuthorized, false);
  assert.equal((await dispatchOnePhraseBenchmarkWithMockSdk(review, f.sdk)).replayed, true); assert.equal(f.getCalls(), 2); assert.equal(f.getCounts(), 2);
  const ledger = await read(join(f.options.output, 'ledger.json')); assert.deepEqual(ledger.calls.slice(0, 6), f.ledger.calls); assert.equal(ledger.calls.length, 8);
  assert.deepEqual(await approvedSnapshot(f.options.output), approved); assert.deepEqual(await read(f.configPath), f.config);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.seeds), /does not authorize scale/);
}));
test('review requires separate exact root acceptance of saved complete cards and cannot add a third request', async () => fixture(async f => {
  await dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk); const review = await reviewOptions(f);
  const receipt = await read(review.reviewAuthorityPath); receipt.reviewWorkSha256 = '0'.repeat(64); await put(review.reviewAuthorityPath, receipt);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(review, f.sdk), /Separate exact root/); assert.equal(f.getCalls(), 1);
  await reviewOptions(f); await dispatchOnePhraseBenchmarkWithMockSdk(review, f.sdk);
  const other = { ...review, work: reviewWorkV5(review.work.units, { id: 'third-review', createdAt: date }) };
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(other, f.sdk), /exact authorized/); assert.equal(f.getCalls(), 2);
}));
test('unknown response retains full reservation and can never be retried under the same or another identity', async () => fixture(async f => {
  f.setCreate(async () => { throw Error('SECRET provider header'); });
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), /outcome is unknown/);
  const call = (await read(join(f.options.output, 'ledger.json'))).calls.at(-1); assert.equal(call.status, 'uncertain'); assert.equal(call.reservedUsd, 0.018);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), /never resend/);
  const another = generationWorkV5(f.seeds, { id: 'another-id', createdAt: date });
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk({ ...f.options, work: another }, f.sdk), /exact authorized/);
  assert.equal(f.getCalls(), 1);
}));
test('truncation is saved and charged once; unpriced usage retains its reservation and blocks new spending', async () => {
  for (const bad of ['truncated', 'unpriced']) await fixture(async f => {
    f.setCreate(async params => ({ ...response({ units: [] }), model: params.model, ...(bad === 'truncated' ? { stop_reason: 'max_tokens' } : { usage: { input_tokens: 100001, output_tokens: 1000 } }) }));
    await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), bad === 'truncated' ? /did not complete/ : /pricing is unresolved/);
    const call = (await read(join(f.options.output, 'ledger.json'))).calls.at(-1);
    assert.equal(call.status, bad === 'truncated' ? 'complete' : 'uncertain'); assert.ok(await read(join(f.options.output, 'requests', call.id, 'response.json')));
    await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCalls(), 1);
  });
});
test('used seeds, changed native approvals, removed hold, changed store and old v3 work fail before provider preflight', async () => {
  const cases = [async f => put(join(f.options.output, 'drafts', f.seeds[0].id, 'old.json'), {}),
    async f => put(join(f.options.output, 'approved', 'new-unreviewed.json'), {}), async f => rm(join(f.options.output, 'native-recoveries', 'scale-hold.json')),
    async f => put(join(f.options.output, 'store.json'), { ...f.state, sharedLockDirectory: '/private/tmp/wrong-lock' }),
    async f => { f.options.work = generationWorkV3([f.seeds[0]], { id: 'old-v3-work', createdAt: date }); },
    async f => { f.config.enabled = true; await f.rebindConfig(); }];
  for (const mutate of cases) await fixture(async f => { await mutate(f); await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCounts(), 0); assert.equal(f.getCalls(), 0); });
});
test('all historical ledger costs/raw and the two-request ceiling are immutable', async () => fixture(async f => {
  const changed = structuredClone(f.ledger); changed.calls[0].actualUsd = 0; await put(join(f.options.output, 'ledger.json'), changed);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), /historical paid calls/);
  await put(join(f.options.output, 'ledger.json'), f.ledger); await rm(join(f.options.output, 'requests', f.ledger.calls[0].id, 'response.json'));
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCounts(), 0);
}));
test('shared spend/cash coverage and worker lifecycle remain closed before model preflight', async () => {
  for (const fault of ['cash', 'stop', 'production', 'fence']) await fixture(async f => {
    if (fault === 'cash') { f.config.cashPurchases[0].amountUsdPreTax = 500; await f.rebindConfig(); }
    if (fault === 'stop') await rm(join(f.options.runtimeDirectory, 'stop-production'));
    if (fault === 'production') await mkdir(join(f.options.runtimeDirectory, 'production.lock'));
    if (fault === 'fence') await mkdir(f.options.sharedLockDirectory);
    await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCounts(), 0); assert.equal(f.getCalls(), 0);
  });
});
test('overlong input stops at free preflight without any paid reservation', async () => fixture(async f => {
  f.setInput(50001); await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), /preflight failed/);
  assert.equal(f.getCounts(), 1); assert.equal(f.getCalls(), 0); assert.deepEqual(await read(join(f.options.output, 'ledger.json')), f.ledger);
}));
test('a root work hash cannot silently replace registered seed metadata, and generated cost must match actual preserved usage', async () => fixture(async f => {
  const changedSeeds = structuredClone(f.seeds); changedSeeds[0].aliases.push('on a similar wavelength');
  const changedWork = generationWorkV5(changedSeeds, { id: f.options.work.id, createdAt: date });
  f.authority.generation.workSha256 = hashContent(changedWork); await put(f.options.authorityPath, f.authority);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk({ ...f.options, work: changedWork }, f.sdk), /registered (?:seed|pilot phrase)/); assert.equal(f.getCalls(), 0);
  f.authority.generation.workSha256 = hashContent(f.options.work); await put(f.options.authorityPath, f.authority);
  await dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk);
  const review = await reviewOptions(f), ledger = await read(join(f.options.output, 'ledger.json')); ledger.calls.at(-1).actualUsd = 0;
  await put(join(f.options.output, 'ledger.json'), ledger);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(review, f.sdk), /settled cost/); assert.equal(f.getCalls(), 1);
}));

test('settled v4 textless truncation is immutable history, not a retry opportunity or an unpriced call', async () => fixture(async f => {
  const oldRawPath = join(f.options.output, 'requests', f.ledger.calls[5].id, 'response.json'), oldRaw = await read(oldRawPath);
  assert.equal(oldRaw.response.stop_reason, 'max_tokens'); assert.equal(oldRaw.response.content.some(block => block.type === 'text'), false);
  const result = await dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk); assert.equal(result.unitIds.length, 1);
  assert.deepEqual(await read(oldRawPath), oldRaw);
  assert.deepEqual((await read(join(f.options.output, 'ledger.json'))).calls.slice(0, 6), f.ledger.calls);
  assert.equal(f.ledger.calls[5].actualUsd, 0.008479);
}));
test('a seed from a prior completed textless request is still used and cannot enter v5', async () => fixture(async f => {
  const ledger = structuredClone(f.ledger); ledger.calls[5].unitIds = [f.seeds[0].id];
  await put(join(f.options.output, 'ledger.json'), ledger); f.authority.baselineLedgerSha256 = hashContent(ledger); await put(f.options.authorityPath, f.authority);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk), /used pilot seed/); assert.equal(f.getCounts(), 0); assert.equal(f.getCalls(), 0);
}));
test('the new authority is limited to exactly six existing calls and one explicitly registered phrase', async () => fixture(async f => {
  const authority = structuredClone(f.authority); authority.baselineRequestIds.pop(); await put(f.options.authorityPath, authority);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCounts(), 0);
  authority.baselineRequestIds = f.authority.baselineRequestIds; authority.maxUnits = 3; await put(f.options.authorityPath, authority);
  await assert.rejects(dispatchOnePhraseBenchmarkWithMockSdk(f.options, f.sdk)); assert.equal(f.getCalls(), 0);
}));
