import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { integrationFiles, sha256File } from './activation.mjs';
import { BATCH_POLICY_SHA256, priceBatchResult, quoteBatchInput, validateBatchRequests } from './batch-provider.mjs';
import { PRICING_POLICY_SHA256, priceResponse } from './anthropic-adapter.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { loadRegistry } from './loaders.mjs';
import { baseLexicalSnapshot } from './canonical-families.mjs';
import { generationWork, parseGenerated, parseReviewed, reviewWork } from './prompts.mjs';
import { approveUnit, hashContent } from './schema.mjs';
import { initializeStore, registerPilotSeeds, withExpansionLock } from './store.mjs';
import { SPENDING_FENCE_PROTOCOL } from '../shared-spending-fence.mjs';
import { measuredPilotSnapshot, SCALE_POLICY_SHA256, scaleFiles, forecastFromPilot } from './scale-approval.mjs';
import { validateScaleInventory } from './scale-store.mjs';
import { dispatchScaleCycle, dispatchScaleCycleWithMockSdk } from './scale-worker.mjs';
import { seed, generatedContent, response, historicalReceiptFixture } from './test-fixtures.mjs';

const date = '2026-10-24T00:00:00.000Z';
const put = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inventory = words => {
  const source = { schemaVersion: 1, id: 'test-candidates', createdBy: 'synthetic-author', seeds: words.map(seed) };
  return { source, review: { schemaVersion: 1, sourceSha256: hashContent(source), reviewedBy: 'synthetic-reviewer', reviewedAt: date,
    verdicts: source.seeds.map(item => ({ id: item.id, approved: true, issues: [] })) } };
};
async function fixture(action, words = ['scalealpha', 'scalebeta', 'scalegamma', 'scaledelta', 'scaleepsilon', 'scalezeta']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-scale-mock-')));
  const runtimeDirectory = join(root, 'runtime'), phaseOneOutput = join(root, 'base'), output = join(root, 'expansion');
  const options = { runtimeDirectory, phaseOneOutput, output, sharedLockDirectory: join(runtimeDirectory, 'shared-spending.lock') };
  try {
    const base = Array.from({ length: 7500 }, (_, i) => ({ id: `frozen-${i}`, word: `baseword${i}` }));
    await put(join(phaseOneOutput, 'frozen-100.json'), base.map(entry => ({ entry, contentSha256: hashContent(entry) })));
    await put(join(phaseOneOutput, 'manifest.json'), { words: base.map(entry => ({ ...entry, status: 'preserved' })) });
    await put(join(phaseOneOutput, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'base-text', status: 'complete', reservedUsd: 1, actualUsd: 0.1 }] });
    await mkdir(join(phaseOneOutput, 'approved'), { recursive: true }); await mkdir(join(phaseOneOutput, 'audio/reservations'), { recursive: true });
    await put(join(phaseOneOutput, 'audio/last-report.json'), { total: 0, ready: 0, existing: 0, missing: 0, failed: 0 });
    await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), 'test-only');
    for (const name of ['production.mjs', 'run.mjs']) await writeFile(join(runtimeDirectory, name), '// synthetic entry point; never executed');
    const seeds = Array.from({ length: 20 }, (_, i) => seed(`pilotword${String.fromCharCode(97 + i)}`));
    const source = { schemaVersion: 1, id: 'pilot-fixture', createdBy: 'pilot-author', seeds };
    const proposal = { schemaVersion: 1, id: 'base-fixture', createdBy: 'family-author', baseSnapshotSha256: hashContent(baseLexicalSnapshot(await loadRegistry({ phaseOneOutput }))), groups: [] };
    const config = { schemaVersion: 1, protocol: SPENDING_FENCE_PROTOCOL, enabled: true, scope: 'phase-two-initial-pilot', textOnly: true,
      pilot: { maxUnits: 20, maxPaidRequests: 10 }, reviewedBy: 'test-only-root', reviewedAt: date, paths: options,
      pricingPolicySha256: PRICING_POLICY_SHA256, expenseCoverage: 'reviewed-ledgers-plus-bounded-historical-allowance', historicalCommitments: historicalReceiptFixture(),
      cashPurchases: [{ id: 'test-cash', provider: 'elevenlabs', fundingPool: 'audio', amountUsdPreTax: 100 }],
      inventory: { source, review: { schemaVersion: 1, sourceSha256: hashContent(source), reviewedBy: 'pilot-reviewer', reviewedAt: date, verdicts: seeds.map(item => ({ id: item.id, approved: true, issues: [] })) } },
      canonicalAudit: { proposal, review: { schemaVersion: 1, sourceSha256: hashContent(proposal), reviewedBy: 'family-reviewer', reviewedAt: date, approved: true, issues: [], coverage: 'all-base-lexical-families' } },
      files: await Promise.all(integrationFiles(runtimeDirectory).map(async file => ({ id: file.id, sha256: await sha256File(file.path) }))) };
    await put(join(runtimeDirectory, 'shared-spending-integration.json'), config);
    await withExpansionLock(options, async lease => {
      const gate = await inspectPhaseOneGate(lease, { ...options, historicalCommitments: config.historicalCommitments, cashPurchases: config.cashPurchases, canonicalAudit: config.canonicalAudit });
      await initializeStore(lease, { phaseOneFingerprint: gate.phaseOneFingerprint, allocationHash: hashContent('synthetic') }); await registerPilotSeeds(lease, seeds);
    });
    const ledger = { schemaVersion: 1, calls: [] };
    for (let offset = 0; offset < 20; offset += 5) {
      const gen = generationWork(seeds.slice(offset, offset + 5), { id: `pilot-generate-${offset}`, createdAt: date });
      const generated = response({ units: gen.seeds.map(generatedContent) }), units = parseGenerated(generated, gen);
      const rev = reviewWork(units, { id: `pilot-review-${offset}`, createdAt: date });
      const reviewed = response({ verdicts: units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] })) });
      for (const [work, result] of [[gen, generated], [rev, reviewed]]) {
        const request = boundedRequest({ ...work, reservedUsd: 0.3 });
        ledger.calls.push({ ...request, status: 'complete', actualUsd: priceResponse(result), responseHash: hashContent(result), completedAt: date });
        await put(join(output, 'requests', request.id, 'work.json'), { work, quote: {} });
        await put(join(output, 'requests', request.id, 'response.json'), { requestId: request.id, requestHash: request.requestHash, response: result, savedAt: date });
      }
      await put(join(output, 'requests', rev.id, 'review-result.json'), parseReviewed(reviewed, rev, date).map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })));
      for (const { unit, receipt } of parseReviewed(reviewed, rev, date)) await put(join(output, 'approved', `${unit.id}.json`), approveUnit(unit, receipt));
    }
    await put(join(output, 'ledger.json'), ledger);
    const pilot = await measuredPilotSnapshot(output, seeds);
    const approval = { schemaVersion: 1, enabled: true, scope: 'reviewed-text-batch-expansion', reviewedBy: '/root', reviewedAt: date, approved: true, issues: [],
      integrationSha256: hashContent(config), policySha256: SCALE_POLICY_SHA256, batchPolicySha256: BATCH_POLICY_SHA256,
      pilotSnapshotSha256: hashContent(pilot), measuredPilotUsd: pilot.actualUsd, pilotApprovedUnits: 20, maxAdditionalUnits: 12480,
      budgetBoundedTarget: true, textOnly: true, files: await Promise.all(scaleFiles().map(async file => ({ id: file.id, sha256: await sha256File(file.path) }))) };
    await put(join(runtimeDirectory, 'shared-spending-scale.json'), approval);
    const candidates = inventory(words);
    await put(join(output, 'scale/inbox/test-candidates.source.json'), candidates.source); await put(join(output, 'scale/inbox/test-candidates.review.json'), candidates.review);
    let createCount = 0, countCount = 0, resultCount = 0, createHook, resultsHook, responseHook, retrieveHook;
    const batches = new Map();
    const sdk = { testOnly: true, networkEnabled: false, models: { retrieve: async id => ({ id }) }, messages: {
      countTokens: async () => { countCount++; return { input_tokens: 1000 }; },
      batches: {
        create: async ({ requests }) => {
          createCount++; const current = await json(join(output, 'ledger.json'));
          for (const request of requests) { const call = current.calls.find(row => row.id === request.custom_id); assert.equal(call.status, 'requested'); assert.ok(call.reservedUsd > 0); }
          if (createHook) return createHook(requests);
          const id = `msgbatch_mock${createCount}`; batches.set(id, requests); return { id, processing_status: 'in_progress', request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } };
        },
        retrieve: async id => retrieveHook ? retrieveHook(id) : ({ id, processing_status: 'ended' }),
        results: async id => {
          resultCount++; const requests = batches.get(id);
          const rows = requests.map(request => {
            const prompt = JSON.parse(request.params.messages[0].content), message = response(prompt.seeds ? { units: prompt.seeds.map(generatedContent) } : { verdicts: prompt.units.map(unit => ({ unitId: unit.unitId, contentSha256: unit.contentSha256, approved: true, issues: [] })) });
            return { custom_id: request.custom_id, result: responseHook ? responseHook(request, message) : { type: 'succeeded', message } };
          });
          return resultsHook ? resultsHook(rows) : (async function* () { for (const row of [...rows].reverse()) yield row; })();
        },
      },
    } };
    await action({ options, sdk, candidates, pilot, config, approval, batches, getCounts: () => ({ createCount, countCount, resultCount }),
      setCreate: fn => { createHook = fn; }, setResults: fn => { resultsHook = fn; }, setResponse: fn => { responseHook = fn; }, setRetrieve: fn => { retrieveHook = fn; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Batch pricing discounts all usage once; thinking tokens are already output; terminal non-billed rows retain valid identities', () => {
  const work = generationWork([seed('resilient')], { id: 'pricing', createdAt: date });
  assert.equal(quoteBatchInput(work.params, 1000).reservedUsd, 0.15);
  assert.equal(priceBatchResult({ custom_id: 'one', result: { type: 'succeeded', message: response({}) } }), 0.0051);
  for (const type of ['errored', 'canceled', 'expired']) assert.equal(priceBatchResult({ custom_id: 'one', result: { type } }), 0);
  assert.throws(() => priceBatchResult({ custom_id: 'one', result: { type: 'network_timeout' } }), /Unrecognized/);
  assert.throws(() => validateBatchRequests(Array.from({ length: 41 }, (_, i) => ({ custom_id: `r${i}`, params: work.params }))), /1–40/);
  assert.equal(validateBatchRequests(Array.from({ length: 40 }, (_, i) => ({ custom_id: `r${i}`, params: work.params }))).length, 40);
  assert.throws(() => validateBatchRequests([{ custom_id: 'one', params: work.params }, { custom_id: 'one', params: work.params }]), /1–40/);
});
test('candidate inventory requires independent full-source review and every accepted ID; forecast remains explicitly uncertain', () => {
  const { source, review } = inventory(['resilient']); assert.equal(validateScaleInventory(source, review).length, 1);
  assert.throws(() => validateScaleInventory(source, { ...review, reviewedBy: ' SYNTHETIC-AUTHOR ' }), /independent/);
  assert.throws(() => validateScaleInventory(source, { ...review, verdicts: [] }), /independent/);
  assert.throws(() => validateScaleInventory({ ...source, seeds: [...source.seeds, ...source.seeds] }, review), /independent/);
  const forecast = forecastFromPilot({ actualUsd: 1, approvedUnits: 20 }, 10); assert.equal(forecast.isGuarantee, false); assert.equal(forecast.estimatedAffordableUnits, 266);
});
test('missing measured-pilot receipt stops before credentials or model lookup; frozen pilot remains capped', async () => fixture(async ({ options, sdk, getCounts }) => {
  await rm(join(options.runtimeDirectory, 'shared-spending-scale.json'));
  await assert.rejects(dispatchScaleCycle(options), /measured-pilot approval receipt is missing/);
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /measured-pilot approval receipt is missing/);
  assert.deepEqual(getCounts(), { createCount: 0, countCount: 0, resultCount: 0 });
  const store = await json(join(options.output, 'store.json')); assert.equal(store.pilot.maxUnits, 20); assert.equal(store.pilot.seeds.length, 20);
}));
test('bounded generation → raw collection → independent review → approved assets; review comes before more generation', async () => fixture(async ({ options, sdk, candidates, getCounts }) => {
  const first = await dispatchScaleCycleWithMockSdk(options, sdk); assert.equal(first.state, 'batch-submitted'); assert.equal(first.requests, 2); assert.equal(first.units, 6);
  const pending = await json(join(options.output, 'ledger.json')); assert.ok(pending.calls.slice(8).every(call => call.status === 'batch_pending' && call.providerBatchId));
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'batch-collected');
  for (const target of candidates.source.seeds) await assert.rejects(readFile(join(options.output, 'approved', `${target.id}.json`)), { code: 'ENOENT' });
  const review = await dispatchScaleCycleWithMockSdk(options, sdk); assert.equal(review.stage, 'review'); assert.equal(review.requests, 2);
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'batch-collected');
  const last = await dispatchScaleCycleWithMockSdk(options, sdk); assert.equal(last.additionalApproved, 6); assert.equal(last.state, 'reviewed-inventory-needed');
  for (const target of candidates.source.seeds) { const approved = await json(join(options.output, 'approved', `${target.id}.json`)); assert.equal(approved.review.contentSha256, hashContent(approved.unit)); }
  assert.equal(getCounts().createCount, 2);
  assert.equal((await json(join(options.output, 'store.json'))).pilot.seeds.length, 20);
}));
test('unknown batch submission never repeats, retaining the entire wave liability', async () => fixture(async ({ options, sdk, setCreate, getCounts }) => {
  setCreate(async () => { throw new Error('do not disclose secret SDK headers'); });
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /submission outcome is unknown/);
  const ledger = await json(join(options.output, 'ledger.json')); assert.ok(ledger.calls.slice(8).every(call => call.status === 'uncertain' && call.reservedUsd > 0));
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /never resubmit automatically/); assert.equal(getCounts().createCount, 1);
}));
test('interrupted unordered result download retains raw, full reservations and safely resumes read-only collection', async () => fixture(async ({ options, sdk, setResults, getCounts }) => {
  await dispatchScaleCycleWithMockSdk(options, sdk);
  setResults(rows => (async function* () { yield rows[0]; throw new Error('stream ended'); })());
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /download is incomplete/);
  assert.ok((await json(join(options.output, 'ledger.json'))).calls.slice(8).every(call => call.status === 'batch_pending'));
  setResults(null); assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'batch-collected');
  assert.equal(getCounts().createCount, 1); assert.equal(getCounts().resultCount, 2);
}));
test('a duplicate result after all rows does not falsely mark a complete stream; exact stream must be recollected', async () => fixture(async ({ options, sdk, setResults, getCounts }) => {
  await dispatchScaleCycleWithMockSdk(options, sdk);
  setResults(rows => (async function* () { for (const row of rows) yield row; yield rows[0]; })());
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /download is incomplete/);
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /download is incomplete/);
  setResults(null); assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'batch-collected'); assert.equal(getCounts().createCount, 1);
}));
test('known provider terminal error settles zero after exact ended evidence, preserves reservations and holds content without retries', async () => fixture(async ({ options, sdk, setResponse, getCounts }) => {
  setResponse(() => ({ type: 'errored', error: { type: 'invalid_request_error', message: 'synthetic' } }));
  await dispatchScaleCycleWithMockSdk(options, sdk); await dispatchScaleCycleWithMockSdk(options, sdk);
  const calls = (await json(join(options.output, 'ledger.json'))).calls.slice(8); assert.ok(calls.every(call => call.actualUsd === 0 && call.reservedUsd > 0 && call.status === 'complete'));
  const next = await dispatchScaleCycleWithMockSdk(options, sdk); assert.equal(next.state, 'quality-hold-above-ten-percent'); assert.equal(getCounts().createCount, 1);
}));
test('truncated output is charged and held without regeneration', async () => fixture(async ({ options, sdk, setResponse, getCounts }) => {
  setResponse((_request, message) => ({ type: 'succeeded', message: { ...message, stop_reason: 'max_tokens' } }));
  await dispatchScaleCycleWithMockSdk(options, sdk); await dispatchScaleCycleWithMockSdk(options, sdk);
  assert.ok((await json(join(options.output, 'ledger.json'))).calls.slice(8).every(call => call.actualUsd > 0));
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'quality-hold-above-ten-percent'); assert.equal(getCounts().createCount, 1);
}));
test('unrecognized model usage keeps an accounting hold and every saved result; no subsequent paid wave', async () => fixture(async ({ options, sdk, setResponse, getCounts }) => {
  setResponse((_request, message) => ({ type: 'succeeded', message: { ...message, model: 'unverified-model' } }));
  const first = await dispatchScaleCycleWithMockSdk(options, sdk);
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /billing needs explicit review/);
  const calls = (await json(join(options.output, 'ledger.json'))).calls.slice(8); assert.ok(calls.some(call => call.accountingHold));
  for (const call of calls) assert.ok(await json(join(options.output, 'scale/waves', first.waveId, 'results', `${call.id}.json`)));
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /accounting is held/); assert.equal(getCounts().createCount, 1);
}));
test('funding obligation guard reserves an affordable prefix plus independent review headroom, never the whole unfunded candidate list', async () => fixture(async ({ options, sdk, config, approval, getCounts }) => {
  config.cashPurchases[0].amountUsdPreTax = 459.5;
  await put(join(options.runtimeDirectory, 'shared-spending-integration.json'), config); approval.integrationSha256 = hashContent(config);
  await put(join(options.runtimeDirectory, 'shared-spending-scale.json'), approval);
  const result = await dispatchScaleCycleWithMockSdk(options, sdk); assert.equal(result.state, 'batch-submitted'); assert.equal(result.requests, 1); assert.equal(result.units, 5);
  assert.equal(getCounts().createCount, 1);
}));
test('eighteen approved pilot cards can qualify while two held cards remain hash-bound and unpublished; three holds close the gate', async () => fixture(async ({ options, config }) => {
  const ledgerFile = join(options.output, 'ledger.json'), ledger = await json(ledgerFile), call = ledger.calls.find(row => row.id === 'pilot-review-0');
  const work = (await json(join(options.output, 'requests', call.id, 'work.json'))).work;
  const rawPath = join(options.output, 'requests', call.id, 'response.json'), raw = await json(rawPath);
  const changeHolds = async count => {
    raw.response = response({ verdicts: work.units.map((unit, i) => ({ unitId: unit.id, contentSha256: hashContent(unit), approved: i >= count, issues: i < count ? ['Synthetic quality hold.'] : [] })) });
    call.responseHash = hashContent(raw.response); await put(rawPath, raw); await put(ledgerFile, ledger);
    const rows = parseReviewed(raw.response, work, raw.savedAt);
    await put(join(options.output, 'requests', call.id, 'review-result.json'), rows.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })));
    for (const { unit, receipt } of rows) { const file = join(options.output, 'approved', `${unit.id}.json`); if (receipt.approved) await put(file, approveUnit(unit, receipt)); else await rm(file, { force: true }); }
  };
  await changeHolds(2); const snapshot = await measuredPilotSnapshot(options.output, config.inventory.source.seeds);
  assert.equal(snapshot.approvedUnits, 18); assert.equal(snapshot.heldUnits, 2); assert.equal(snapshot.units.filter(unit => !unit.approved).length, 2);
  assert.ok(forecastFromPilot(snapshot, 100).estimatedUsdPerApprovedUnit > snapshot.actualUsd / 20 * 0.75);
  await changeHolds(3); await assert.rejects(measuredPilotSnapshot(options.output, config.inventory.source.seeds), /Fewer than eighteen/);
}));
test('stop checkpoint prevents new requests but still allows known batch collection', async () => fixture(async ({ options, sdk, getCounts }) => {
  await writeFile(join(options.runtimeDirectory, 'stop-scale'), 'test-stop');
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'stopped-at-checkpoint'); assert.equal(getCounts().createCount, 0);
  await rm(join(options.runtimeDirectory, 'stop-scale')); await dispatchScaleCycleWithMockSdk(options, sdk);
  await writeFile(join(options.runtimeDirectory, 'stop-scale'), 'test-stop');
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'batch-collected');
  assert.equal((await dispatchScaleCycleWithMockSdk(options, sdk)).state, 'stopped-at-checkpoint'); assert.equal(getCounts().createCount, 1);
}));
test('base/seed aliases cannot inflate scale inventory and stale price/cost approvals cannot pass', async () => fixture(async ({ options, sdk, candidates, getCounts }) => {
  candidates.source.seeds[0].aliases = ['pilotworda']; candidates.review.sourceSha256 = hashContent(candidates.source);
  await put(join(options.output, 'scale/inbox/test-candidates.source.json'), candidates.source); await put(join(options.output, 'scale/inbox/test-candidates.review.json'), candidates.review);
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /overlaps retained/); assert.equal(getCounts().createCount, 0);
  const approvalFile = join(options.runtimeDirectory, 'shared-spending-scale.json'), receipt = await json(approvalFile); receipt.measuredPilotUsd = 0; await put(approvalFile, receipt);
  await assert.rejects(dispatchScaleCycleWithMockSdk(options, sdk), /differs from the root/); assert.equal(getCounts().countCount, 0);
}));
