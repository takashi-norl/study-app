import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatchPilotWorkWithMockSdk, dispatchPilotWork } from './live-pilot.mjs';
import { generationWork, reviewWork, parseGenerated } from './prompts.mjs';
import { checkedVersionedWork, newGenerationWork, newReviewWork, repairWorkV2, parseVersionedGeneration } from './work-versions.mjs';
import { validateRepairAuthority, inspectRepairEvidence, assertOnlyTestsChanged, assertSingleRepairDispatch } from './pilot-repair.mjs';
import { measuredPilotSnapshot } from './scale-approval.mjs';
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
    const seeds = Array.from({ length: 20 }, (_, i) => seed(`pilotword${String.fromCharCode(97 + i)}`)), target = seeds[0], work = generationWork(seeds.slice(0, 5), { id: 'generation-one', createdAt: date });
    const source = { schemaVersion: 1, id: 'pilot-seeds', createdBy: 'seed-author', seeds };
    const proposal = { schemaVersion: 1, id: 'canonical-base', createdBy: 'family-author', baseSnapshotSha256: hashContent(baseLexicalSnapshot(await loadRegistry({ phaseOneOutput }))), groups: [] };
    const config = { schemaVersion: 1, protocol: SPENDING_FENCE_PROTOCOL, enabled: true, scope: 'phase-two-initial-pilot', textOnly: true, pilot: { maxUnits: 20, maxPaidRequests: 10 }, reviewedBy: 'independent-integration-reviewer', reviewedAt: date, paths, pricingPolicySha256: PRICING_POLICY_SHA256,
      expenseCoverage: 'reviewed-ledgers-plus-bounded-historical-allowance', historicalCommitments: historicalReceiptFixture(), cashPurchases: [{ id: 'confirmed-topup', provider: 'elevenlabs', fundingPool: 'audio', amountUsdPreTax: 100 }],
      inventory: { source, review: { schemaVersion: 1, sourceSha256: hashContent(source), reviewedBy: 'independent-seed-reviewer', reviewedAt: date, verdicts: seeds.map(item => ({ id: item.id, approved: true, issues: [] })) } },
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
        if (prompt.workflow?.kind === 'tests-only-repair') return response({ units: prompt.units.map(row => ({ unitId: row.unitId, sourceContentSha256: row.sourceContentSha256, tests: repairedTests(row.unit) })) });
        return prompt.seeds ? response({ units: prompt.seeds.map(generatedContent) }) : response({ verdicts: prompt.units.map(row => ({ unitId: row.unitId, contentSha256: row.contentSha256, approved: true, issues: [] })) });
      },
    } };
    await action({ options: { ...paths, work }, sdk, config, configPath, target, seeds, getCalls: () => calls, getCounts: () => counts, setCreate: fn => { onCreate = fn; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const repairedTests = unit => unit.senses[0].tests.map(test => ({ ...test, explanationJa: test.explanationJa + ' 修復後の文脈を確認します。' }));
async function authorize(f) {
  const raw = await json(join(f.options.output, 'requests', f.options.work.id, 'response.json'));
  const units = parseGenerated(raw.response, f.options.work);
  const rejection = { schemaVersion: 1, sourceRequestId: f.options.work.id, workSha256: hashContent(f.options.work), rawSha256: hashContent(raw), reviewedBy: 'offline-independent-editor', reviewedAt: date,
    verdicts: units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit), approved: false, issues: ['Synthetic material distractor defect: repair the four questions.'] })) };
  const plan = { schemaVersion: 1, id: 'repair-plan-one', kind: 'pilot-tests-only-repair', createdBy: 'repair-planner', createdAt: date,
    sourceRequestId: f.options.work.id, sourceRequestHash: raw.requestHash, workSha256: hashContent(f.options.work), rawSha256: hashContent(raw), rejectionSha256: hashContent(rejection),
    unitContentHashes: units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit) })), repairWorkId: 'repair-one', promptVersion: 'v2',
    allowedModes: ['meaning', 'word', 'context', 'usage'], maxRepairRequests: 1, preserveNonTestFields: true };
  const authority = { plan, rejection, review: { schemaVersion: 1, sourceSha256: hashContent(plan), reviewedBy: '/root', reviewedAt: date, approved: true, issues: [] } };
  f.config.pilotRepair = authority; await put(f.configPath, f.config);
  return { authority, units, work: repairWorkV2(units, plan, rejection, { id: plan.repairWorkId, createdAt: date }) };
}
test('historical work stays exact while v2 uses worked plausible-error examples and medium effort', () => {
  const original = generationWork([seed('resilient')], { id: 'historical', createdAt: date });
  assert.deepEqual(checkedVersionedWork(original), original); assert.equal(original.params.output_config.effort, 'low');
  const improved = newGenerationWork(original.seeds, { id: 'improved', createdAt: date });
  assert.equal(improved.params.output_config.effort, 'medium'); assert.equal(improved.promptVersion, 'v2');
  assert.match(improved.params.messages[0].content, /Worked example A/); assert.match(improved.params.messages[0].content, /explicitly reviewed alias/);
  assert.notEqual(hashContent(original.params), hashContent(improved.params));
  assert.throws(() => checkedVersionedWork({ ...original, promptVersion: 'v2' }), /historical prompt/);
  assert.throws(() => checkedVersionedWork({ ...improved, params: original.params }), /historical prompt/);
});
test('repair changes only all-four tests; protected fields, foreign IDs, wrong hashes and omitted cards reject', async () => fixture(async f => {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const a = await authorize(f);
  const payload = { units: a.units.map(unit => ({ unitId: unit.id, sourceContentSha256: hashContent(unit), tests: repairedTests(unit) })) };
  const repaired = parseVersionedGeneration(response(payload), a.work);
  repaired.forEach((unit, i) => { assertOnlyTestsChanged(a.units[i], unit); assert.deepEqual(unit.provenance, a.units[i].provenance); assert.notEqual(hashContent(unit), hashContent(a.units[i])); });
  for (const mutate of [p => { p.units[0].meaningJa = 'unauthorized'; }, p => { p.units[0].sourceContentSha256 = '0'.repeat(64); }, p => { p.units[0].unitId = a.units[1].id; }, p => { p.units.pop(); }]) {
    const changed = structuredClone(payload); mutate(changed); assert.throws(() => parseVersionedGeneration(response(changed), a.work));
  }
  const changedUnit = structuredClone(repaired[0]); changedUnit.senses[0].examples[0].text = 'Changed protected example.';
  assert.throws(() => assertOnlyTestsChanged(a.units[0], changedUnit), /protected/);
}));
test('authority rejects changed rejection, foreign approval, broadened modes and unresolved original outcomes', async () => fixture(async f => {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const a = await authorize(f);
  assert.equal(validateRepairAuthority(a.authority).planSha256, hashContent(a.authority.plan));
  for (const mutate of [p => { p.rejection.verdicts[0].approved = true; }, p => { p.review.reviewedBy = 'author'; }, p => { p.plan.allowedModes = ['meaning', 'meaning', 'context', 'usage']; }, p => { p.plan.maxRepairRequests = 2; }]) {
    const changed = structuredClone(a.authority); mutate(changed); assert.throws(() => validateRepairAuthority(changed));
  }
  const file = join(f.options.output, 'ledger.json'), ledger = await json(file); ledger.calls[0].status = 'uncertain'; await put(file, ledger);
  await assert.rejects(inspectRepairEvidence(f.options.output, a.authority, a.work), /unknown outcomes/);
}));
test('one explicit repair plus remaining generation and final reviews produces twenty cards in nine paid requests including original cost', async () => fixture(async f => {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const a = await authorize(f);
  const rawBefore = await readFile(join(f.options.output, 'requests', f.options.work.id, 'response.json'));
  const prematureReview = newReviewWork(a.units, { id: 'premature-review', createdAt: date });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: prematureReview }, f.sdk), /wait for the exact/);
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: generationWork(f.seeds.slice(5, 10), { id: 'legacy-new', createdAt: date }) }, f.sdk), /v2 quality/);
  await dispatchPilotWorkWithMockSdk({ ...f.options, work: a.work }, f.sdk);
  assert.equal((await dispatchPilotWorkWithMockSdk({ ...f.options, work: a.work }, f.sdk)).replayed, true); assert.equal(f.getCalls(), 2);
  assert.deepEqual(await readFile(join(f.options.output, 'requests', f.options.work.id, 'response.json')), rawBefore);
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: prematureReview }, f.sdk), /never the rejected original/);
  const repairRaw = await json(join(f.options.output, 'requests', a.work.id, 'response.json'));
  const finalUnits = parseVersionedGeneration(repairRaw.response, a.work);
  for (let offset = 5; offset < 20; offset += 5) {
    const work = newGenerationWork(f.seeds.slice(offset, offset + 5), { id: `generation-v2-${offset}`, createdAt: date });
    await dispatchPilotWorkWithMockSdk({ ...f.options, work }, f.sdk);
    finalUnits.push(...parseVersionedGeneration((await json(join(f.options.output, 'requests', work.id, 'response.json'))).response, work));
  }
  for (let offset = 0; offset < 20; offset += 5) await dispatchPilotWorkWithMockSdk({ ...f.options, work: newReviewWork(finalUnits.slice(offset, offset + 5), { id: `final-review-${offset}`, createdAt: date }) }, f.sdk);
  assert.equal(f.getCalls(), 9);
  const snapshot = await measuredPilotSnapshot(f.options.output, f.seeds, a.authority);
  assert.equal(snapshot.approvedUnits, 20); assert.equal(snapshot.actualUsd, 9 * 0.0102); assert.equal(snapshot.generationLineage.length, 1);
  const ledger = await json(join(f.options.output, 'ledger.json')); assert.equal(ledger.calls.length, 9); assert.equal(ledger.calls[1].repairOf, f.options.work.id);
  assert.equal((await dispatchPilotWorkWithMockSdk(f.options, f.sdk)).replayed, true); assert.equal(f.getCalls(), 9);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.seeds), /./);
  const revisionFile = join(f.options.output, 'requests', a.work.id, 'repair-revision.json'), revision = await json(revisionFile); revision.units[0].afterSha256 = '0'.repeat(64); await put(revisionFile, revision);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.seeds, a.authority), /revision evidence/);
}));
test('unknown repair never resubmits, retains its full reservation, and cannot be given a new ID', async () => fixture(async f => {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const a = await authorize(f);
  f.setCreate(async () => { throw new Error('unknown network outcome'); });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: a.work }, f.sdk), /outcome is unknown/);
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: a.work }, f.sdk), /no saved response/);
  const ledger = await json(join(f.options.output, 'ledger.json')); assert.equal(ledger.calls[1].status, 'uncertain'); assert.equal(ledger.calls[1].reservedUsd, 0.3);
  assert.equal(ledger.calls[0].actualUsd, 0.0102); assert.equal(f.getCalls(), 2);
  const changed = structuredClone(a.work); changed.id = 'unauthorized-second'; assert.throws(() => checkedVersionedWork(changed));
}));
test('pilot maximum includes old calls and the explicit repair, without preflight beyond the ten-call bound', async () => fixture(async f => {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const a = await authorize(f);
  const file = join(f.options.output, 'ledger.json'), ledger = await json(file);
  // Synthetic settled unrelated requests occupy the existing ten-call budget.
  for (let i = 1; i < 10; i++) ledger.calls.push({ id: `prior-${i}`, stage: 'generation', unitIds: [f.seeds[5 + i].id], status: 'complete', requestHash: 'a'.repeat(64), reservedUsd: 0.3, actualUsd: 0.01 });
  await put(file, ledger); const counts = f.getCounts();
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: a.work }, f.sdk), /ten total/); assert.equal(f.getCounts(), counts); assert.equal(f.getCalls(), 1);
}));
test('second repair authorization cannot silently replace a prior repair or an already reviewed draft', () => {
  const work = { id: 'repair', kind: 'tests-only-repair', unitIds: ['one'] }, evidence = { plan: { repairWorkId: 'repair', sourceRequestId: 'original' } };
  assert.throws(() => assertSingleRepairDispatch({ calls: [{ id: 'other', repairOf: 'original', unitIds: ['two'] }] }, work, evidence), /only the one/);
  assert.throws(() => assertSingleRepairDispatch({ calls: [{ id: 'review-already', unitIds: ['one'] }] }, work, evidence), /already have another/);
});
