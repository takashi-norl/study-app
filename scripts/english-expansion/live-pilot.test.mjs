import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatchPilotWorkWithMockSdk, dispatchPilotWork } from './live-pilot.mjs';
import { generationWork, reviewWork } from './prompts.mjs';
import { integrationFiles, sha256File, verifyIntegration } from './activation.mjs';
import { PRICING_POLICY_SHA256, PRICING_POLICY } from './anthropic-adapter.mjs';
import { hashContent } from './schema.mjs';
import { loadRegistry } from './loaders.mjs';
import { baseLexicalSnapshot } from './canonical-families.mjs';
import { assertPhaseOneNotHandedOff, withSharedSpendingFence, SPENDING_FENCE_PROTOCOL } from '../shared-spending-fence.mjs';
import { seed, generatedContent, response, historicalReceiptFixture } from './test-fixtures.mjs';

const date = '2026-10-24T00:00:00.000Z';
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-live-pilot-offline-'))), runtimeDirectory = join(root, 'runtime'), phaseOneOutput = join(root, 'base'), output = join(root, 'expansion'), sharedLockDirectory = join(runtimeDirectory, 'shared-spending.lock');
  const paths = { runtimeDirectory, phaseOneOutput, output, sharedLockDirectory };
  try {
    // Synthetic complete base: no credentials, network or user data.
    const entries = Array.from({ length: 7500 }, (_, i) => ({ id: `frozen-${i}`, word: `baseword${i}` }));
    await put(join(phaseOneOutput, 'frozen-100.json'), entries.map(entry => ({ entry, contentSha256: hashContent(entry) })));
    await put(join(phaseOneOutput, 'manifest.json'), { words: entries.map(entry => ({ ...entry, status: 'preserved' })) });
    await put(join(phaseOneOutput, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'phase-one-text', status: 'complete', reservedUsd: 1, actualUsd: 0.1 }] });
    await mkdir(join(phaseOneOutput, 'approved'), { recursive: true }); await mkdir(join(phaseOneOutput, 'audio', 'reservations'), { recursive: true });
    await put(join(phaseOneOutput, 'audio', 'last-report.json'), { total: 0, ready: 0, existing: 0, missing: 0, failed: 0 });
    await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), 'test-only stop checkpoint');
    await writeFile(join(runtimeDirectory, 'production.mjs'), '// TEST ONLY reviewed entry-point fixture; never executed\n');
    await writeFile(join(runtimeDirectory, 'run.mjs'), '// TEST ONLY reviewed child fixture; never executed\n');
    const target = seed('resilient'), work = generationWork([target], { id: 'generation-one', createdAt: date });
    const source = { schemaVersion: 1, id: 'pilot-seeds', createdBy: 'seed-author', seeds: [target] };
    const proposal = { schemaVersion: 1, id: 'canonical-base', createdBy: 'family-author', baseSnapshotSha256: hashContent(baseLexicalSnapshot(await loadRegistry({ phaseOneOutput }))), groups: [] };
    const config = { schemaVersion: 1, protocol: SPENDING_FENCE_PROTOCOL, enabled: true, scope: 'phase-two-initial-pilot', textOnly: true, pilot: { maxUnits: 20, maxPaidRequests: 10 }, reviewedBy: 'independent-integration-reviewer', reviewedAt: date, paths, pricingPolicySha256: PRICING_POLICY_SHA256,
      expenseCoverage: 'reviewed-ledgers-plus-bounded-historical-allowance', historicalCommitments: historicalReceiptFixture(), cashPurchases: [{ id: 'confirmed-topup', provider: 'elevenlabs', fundingPool: 'audio', amountUsdPreTax: 100 }],
      inventory: { source, review: { schemaVersion: 1, sourceSha256: hashContent(source), reviewedBy: 'independent-seed-reviewer', reviewedAt: date, verdicts: [{ id: target.id, approved: true, issues: [] }] } },
      canonicalAudit: { proposal, review: { schemaVersion: 1, sourceSha256: hashContent(proposal), reviewedBy: 'independent-family-reviewer', reviewedAt: date, approved: true, issues: [], coverage: 'all-base-lexical-families' } },
      files: await Promise.all(integrationFiles(runtimeDirectory).map(async file => ({ id: file.id, sha256: await sha256File(file.path) }))),
    };
    const configPath = join(runtimeDirectory, 'shared-spending-integration.json'); await put(configPath, config);
    let calls = 0, counts = 0, onCreate = null;
    const sdk = { testOnly: true, networkEnabled: false, models: { retrieve: async model => ({ id: model }) }, messages: {
      countTokens: async () => { counts++; return { input_tokens: 1000 }; },
      create: async params => {
        calls++; const ledger = await json(join(output, 'ledger.json')); assert.equal(ledger.calls.at(-1).status, 'requested');
        if (onCreate) return onCreate(params);
        const prompt = JSON.parse(params.messages[0].content);
        return prompt.seeds ? response({ units: prompt.seeds.map(generatedContent) }) : response({ verdicts: prompt.units.map(row => ({ unitId: row.unitId, contentSha256: row.contentSha256, approved: true, issues: [] })) });
      },
    } };
    await action({ options: { ...paths, work }, sdk, config, configPath, target, getCalls: () => calls, getCounts: () => counts, setCreate: fn => { onCreate = fn; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('missing integration and incomplete base stop before any provider preflight or key lookup', async () => fixture(async ({ options, sdk, configPath, getCounts }) => {
  await rm(configPath);
  await assert.rejects(dispatchPilotWork(options), /receipt is missing/);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /receipt is missing/); assert.equal(getCounts(), 0);
}));
test('live pilot generates durable drafts, reuses paid output, and independently approves only exact drafts', async () => fixture(async ({ options, sdk, getCalls, target }) => {
  const generated = await dispatchPilotWorkWithMockSdk(options, sdk); assert.equal(generated.state, 'drafts-awaiting-independent-review'); assert.equal(getCalls(), 1);
  await assert.rejects(assertPhaseOneNotHandedOff(options.runtimeDirectory), /Phase two has reserved/);
  assert.equal((await json(join(options.runtimeDirectory, 'phase-two-handoff.json'))).firstRequestId, options.work.id);
  const replay = await dispatchPilotWorkWithMockSdk(options, sdk); assert.equal(replay.replayed, true); assert.equal(getCalls(), 1);
  const raw = await json(join(options.output, 'requests', options.work.id, 'response.json')); assert.equal(raw.response.model, PRICING_POLICY.model);
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(join(options.output, 'drafts', target.id)); const { unit } = await json(join(options.output, 'drafts', target.id, names[0]));
  const review = reviewWork([unit], { id: 'review-one', createdAt: date });
  const result = await dispatchPilotWorkWithMockSdk({ ...options, work: review }, sdk);
  assert.deepEqual(result.approved, [target.id]); assert.equal(getCalls(), 2);
  const approved = await json(join(options.output, 'approved', `${target.id}.json`)); assert.equal(approved.review.contentSha256, hashContent(approved.unit));
  const noRepeat = generationWork([target], { id: 'another-id-not-permission', createdAt: date });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...options, work: noRepeat }, sdk), /already have a request/); assert.equal(getCalls(), 2);
}));
test('unknown submission keeps full reservation; replay and different IDs cannot retry', async () => fixture(async ({ options, sdk, setCreate, getCalls }) => {
  setCreate(async () => { throw new Error('network ended with SECRET HEADER'); });
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /outcome is unknown/);
  const ledger = await json(join(options.output, 'ledger.json')); assert.equal(ledger.calls[0].status, 'uncertain'); assert.ok(ledger.calls[0].reservedUsd > 0);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /no saved response/); assert.equal(getCalls(), 1);
  const another = generationWork(options.work.seeds, { id: 'do-not-resend', createdAt: date });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...options, work: another }, sdk), /already have a request/); assert.equal(getCalls(), 1);
}));
test('truncated content retains paid raw and cost without public assets or automatic retry', async () => fixture(async ({ options, sdk, setCreate, getCalls }) => {
  setCreate(async () => ({ ...response({ units: [] }), stop_reason: 'max_tokens' }));
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /did not complete/);
  const ledger = await json(join(options.output, 'ledger.json')); assert.equal(ledger.calls[0].status, 'complete'); assert.equal(ledger.calls[0].actualUsd, 0.0102);
  assert.ok(await json(join(options.output, 'requests', options.work.id, 'response.json')));
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /did not complete/); assert.equal(getCalls(), 1);
}));
test('independent rejection preserves exact review evidence and never creates an approved asset', async () => fixture(async ({ options, sdk, setCreate, target }) => {
  await dispatchPilotWorkWithMockSdk(options, sdk);
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(join(options.output, 'drafts', target.id)), { unit } = await json(join(options.output, 'drafts', target.id, names[0]));
  setCreate(async () => response({ verdicts: [{ unitId: unit.id, contentSha256: hashContent(unit), approved: false, issues: ['Context distractor also satisfies the stated meaning; replace it.'] }] }));
  const work = reviewWork([unit], { id: 'review-rejected', createdAt: date });
  const result = await dispatchPilotWorkWithMockSdk({ ...options, work }, sdk);
  assert.deepEqual(result.held, [target.id]); assert.deepEqual(result.approved, []);
  assert.equal((await json(join(options.output, 'requests', work.id, 'review-result.json')))[0].receipt.approved, false);
  await assert.rejects(readFile(join(options.output, 'approved', `${target.id}.json`)), { code: 'ENOENT' });
}));
test('7,500 headwords with an independently grouped spelling family are not 7,500 canonical lexemes', async () => fixture(async ({ options, sdk, config, configPath, getCounts }) => {
  const frozenPath = join(options.phaseOneOutput, 'frozen-100.json'), manifestPath = join(options.phaseOneOutput, 'manifest.json');
  const frozen = await json(frozenPath), manifest = await json(manifestPath);
  for (const [i, word] of [[0, 'analog'], [1, 'analogue']]) { frozen[i].entry.word = word; frozen[i].contentSha256 = hashContent(frozen[i].entry); manifest.words[i].word = word; }
  await put(frozenPath, frozen); await put(manifestPath, manifest);
  config.canonicalAudit.proposal.baseSnapshotSha256 = hashContent(baseLexicalSnapshot(await loadRegistry({ phaseOneOutput: options.phaseOneOutput })));
  config.canonicalAudit.proposal.groups = [{ canonicalLemma: 'analog', memberIds: ['frozen-0', 'frozen-1'], reasonJa: '両方の品詞カードを保持し、表記差の語族は一つと数える。' }];
  config.canonicalAudit.review.sourceSha256 = hashContent(config.canonicalAudit.proposal); await put(configPath, config);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /not complete/); assert.equal(getCounts(), 0);
}));
test('changed runtime code, changed canonical coverage, active phase one and missing stop all close the real gate', async () => {
  const cases = [
    async o => writeFile(join(o.runtimeDirectory, 'run.mjs'), 'changed'),
    async o => rm(join(o.runtimeDirectory, 'stop-production')),
    async o => mkdir(join(o.runtimeDirectory, 'production.lock')),
    async o => { const path = join(o.phaseOneOutput, 'frozen-100.json'), rows = await json(path); rows[0].entry.word = 'changed'; rows[0].contentSha256 = hashContent(rows[0].entry); await put(path, rows); },
  ];
  for (const mutate of cases) await fixture(async ({ options, sdk, getCounts }) => { await mutate(options); await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /stale|checkpoint|still running/); assert.equal(getCounts(), 0); });
});
test('cash prepayment plus text liability and unknown phase-one outcomes block paid generation', async () => fixture(async ({ options, sdk, config, configPath, getCalls }) => {
  config.cashPurchases[0].amountUsdPreTax = 500; await put(configPath, config);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /cap violation/); assert.equal(getCalls(), 0);
  config.cashPurchases[0].amountUsdPreTax = 100; await put(configPath, config);
  const path = join(options.phaseOneOutput, 'ledger.json'), ledger = await json(path); ledger.calls[0].status = 'uncertain'; await put(path, ledger);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /fully settled/); assert.equal(getCalls(), 0);
}));
test('phase-one lifetime fence and phase-two action fence cannot both spend', async () => fixture(async ({ options, sdk, getCounts }) => {
  await withSharedSpendingFence({ output: options.phaseOneOutput, sharedLockDirectory: options.sharedLockDirectory, ownerKind: 'phase-one' }, async () => {
    await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /already held/); assert.equal(getCounts(), 0);
  });
  await verifyIntegration(options);
}));

test('live activation requires exact bounded historical coverage before provider preflight', async () => fixture(async ({ options, sdk, config, configPath, getCounts }) => {
  const receipt = config.historicalCommitments; delete config.historicalCommitments; await put(configPath, config);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /Historical costs/); assert.equal(getCounts(), 0);
  config.historicalCommitments = { ...receipt, textUsd: 0 }; await put(configPath, config);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /Historical costs/); assert.equal(getCounts(), 0);
  config.historicalCommitments = receipt; config.expenseCoverage = 'all-costs-settled'; await put(configPath, config);
  await assert.rejects(dispatchPilotWorkWithMockSdk(options, sdk), /receipt is incomplete/); assert.equal(getCounts(), 0);
}));
