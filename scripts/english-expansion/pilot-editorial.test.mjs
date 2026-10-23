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

import { applyEditorialPatches, applyEditorialOverlay, validateEditorialAuthority, inspectEditorialOverlay } from './pilot-editorial.mjs';
import { runEditorialOverlay } from './pilot-editorial-cli.mjs';
import { withExpansionLock } from './store.mjs';

async function editorialFixture(f) {
  await dispatchPilotWorkWithMockSdk(f.options, f.sdk); const repair = await authorize(f);
  await dispatchPilotWorkWithMockSdk({ ...f.options, work: repair.work }, f.sdk);
  const raw = await json(join(f.options.output, 'requests', repair.work.id, 'response.json'));
  const revision = await json(join(f.options.output, 'requests', repair.work.id, 'repair-revision.json'));
  const units = parseVersionedGeneration(raw.response, repair.work);
  const sourceReview = { schemaVersion: 1, sourceRequestId: repair.work.id, workSha256: hashContent(repair.work), rawSha256: hashContent(raw), reviewedBy: 'independent-source-editor', reviewedAt: date,
    verdicts: units.map((unit, i) => ({ unitId: unit.id, contentSha256: hashContent(unit), approved: i === 0, issues: i === 0 ? [] : ['The test explanation overstates the rule.'] })) };
  const finalUnits = units.map((unit, i) => {
    const changed = structuredClone(unit); if (i) changed.senses[0].tests[3].choices[1].feedbackJa = 'この場面では、示された意図と一致しません。'; return changed;
  });
  const proposal = { schemaVersion: 1, id: 'editorial-one', kind: 'pilot-tests-only-editorial-overlay', createdBy: '/root', createdAt: date,
    sourceRequestId: repair.work.id, sourceWorkSha256: hashContent(repair.work), sourceRawSha256: hashContent(raw), sourceRevisionSha256: hashContent(revision), sourceReviewSha256: hashContent(sourceReview),
    sourceContentHashes: units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit) })),
    patches: units.slice(1).map((unit, i) => ({ unitId: unit.id, beforeContentSha256: hashContent(unit), afterContentSha256: hashContent(finalUnits[i + 1]), changes: [{ path: '/senses/0/tests/3/choices/1/feedbackJa', before: unit.senses[0].tests[3].choices[1].feedbackJa, after: finalUnits[i + 1].senses[0].tests[3].choices[1].feedbackJa }] })) };
  const review = { schemaVersion: 1, proposalSha256: hashContent(proposal), reviewedBy: 'independent-patch-editor', reviewedAt: date,
    verdicts: proposal.patches.map(patch => ({ unitId: patch.unitId, afterContentSha256: patch.afterContentSha256, approved: true, issues: [] })) };
  const authority = { proposal, sourceReview, review, rootApproval: { schemaVersion: 1, proposalSha256: hashContent(proposal), reviewSha256: hashContent(review), reviewedBy: '/root', reviewedAt: date, approved: true, issues: [] } };
  f.config.pilotEditorial = authority; await put(f.configPath, f.config);
  return { repair, units, finalUnits, authority, raw, revision };
}
function rebind(authority) {
  authority.proposal.sourceReviewSha256 = hashContent(authority.sourceReview);
  authority.review.proposalSha256 = hashContent(authority.proposal);
  authority.rootApproval.proposalSha256 = hashContent(authority.proposal);
  authority.rootApproval.reviewSha256 = hashContent(authority.review);
  return authority;
}
test('editorial schema permits only exact existing tests leaves and requires independent complete held-card approvals', async () => fixture(async f => {
  const e = await editorialFixture(f);
  assert.equal(validateEditorialAuthority(e.authority, e.repair.authority).proposalSha256, hashContent(e.authority.proposal));
  assert.deepEqual(applyEditorialPatches(e.units, e.authority, e.repair.authority).units, e.finalUnits);
  const mutations = [
    a => { a.proposal.patches[0].changes[0].path = '/senses/0/examples/0/text'; },
    a => { a.proposal.patches[0].changes[0].path = '/senses/0/tests/3/choices/1/__proto__'; },
    a => { a.proposal.patches[0].changes[0].before = 'Not the original'; },
    a => { a.proposal.patches[0].changes[0].after = 'Different than reviewed'; },
    a => { a.proposal.patches[0].changes[0].path = '/senses/0/tests/3/alternatives/7/text'; },
    a => { a.proposal.patches[0].changes.push(a.proposal.patches[0].changes[0]); },
    a => { a.review.reviewedBy = a.proposal.createdBy; },
    a => { a.review.verdicts.pop(); },
    a => { a.proposal.patches.pop(); a.review.verdicts.pop(); },
    a => { a.sourceReview.verdicts[1].approved = true; a.sourceReview.verdicts[1].issues = []; },
    a => { a.rootApproval.reviewedBy = 'not-root'; },
    a => { a.proposal.sourceContentHashes.reverse(); },
  ];
  for (const mutate of mutations) { const a = structuredClone(e.authority); mutate(a); rebind(a); assert.throws(() => applyEditorialPatches(e.units, a, e.repair.authority)); }
}));
test('offline overlay is immutable and idempotent; raw, repair revision, paid ledger, meanings and examples are unchanged', async () => fixture(async f => {
  const e = await editorialFixture(f), files = ['ledger.json', `requests/${f.options.work.id}/response.json`, `requests/${e.repair.work.id}/response.json`, `requests/${e.repair.work.id}/repair-revision.json`];
  const before = await Promise.all(files.map(file => readFile(join(f.options.output, file))));
  const dry = await runEditorialOverlay(f.options); assert.equal(dry.units.length, 5);
  await assert.rejects(inspectEditorialOverlay(f.options.output, e.repair.authority, e.authority), /not been durably/);
  const applied = await runEditorialOverlay({ ...f.options, write: true });
  assert.deepEqual(await runEditorialOverlay({ ...f.options, write: true }), applied); assert.equal(f.getCalls(), 2);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(f.options.output, file)))), before);
  for (let i = 0; i < 5; i++) { assertOnlyTestsChanged(e.units[i], e.finalUnits[i]); assert.deepEqual(e.units[i].senses[0].examples, e.finalUnits[i].senses[0].examples); }
  assert.equal(hashContent(e.units[0]), hashContent(e.finalUnits[0]));
  const altered = structuredClone(e.authority); altered.proposal.id = 'second-overlay'; rebind(altered);
  await assert.rejects(withExpansionLock(f.options, lease => applyEditorialOverlay(lease, e.repair.authority, altered)), /omitted or replaced/);
}));
test('review and measured snapshot bind exact editorial cards while all nine paid calls remain counted', async () => fixture(async f => {
  const e = await editorialFixture(f);
  const oldReview = newReviewWork(e.units, { id: 'final-review-0', createdAt: date });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: oldReview }, f.sdk), /not been durably/);
  await runEditorialOverlay({ ...f.options, write: true });
  await assert.rejects(dispatchPilotWorkWithMockSdk({ ...f.options, work: oldReview }, f.sdk), /exact editorial final/);
  assert.equal(f.getCalls(), 2);
  const all = [...e.finalUnits];
  for (let offset = 5; offset < 20; offset += 5) {
    const work = newGenerationWork(f.seeds.slice(offset, offset + 5), { id: `generation-v2-${offset}`, createdAt: date });
    await dispatchPilotWorkWithMockSdk({ ...f.options, work }, f.sdk);
    all.push(...parseVersionedGeneration((await json(join(f.options.output, 'requests', work.id, 'response.json'))).response, work));
  }
  for (let offset = 0; offset < 20; offset += 5) await dispatchPilotWorkWithMockSdk({ ...f.options, work: newReviewWork(all.slice(offset, offset + 5), { id: `final-review-${offset}`, createdAt: date }) }, f.sdk);
  const snapshot = await measuredPilotSnapshot(f.options.output, f.seeds, e.repair.authority, e.authority);
  assert.equal(snapshot.approvedUnits, 20); assert.equal(snapshot.actualUsd, 9 * 0.0102); assert.equal(f.getCalls(), 9);
  assert.equal(snapshot.editorialLineage.sourceRequestId, e.repair.work.id); assert.equal(snapshot.generationLineage.length, 1);
  assert.deepEqual(await runEditorialOverlay({ ...f.options, write: true }), snapshot.editorialLineage);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.seeds, e.repair.authority), /cannot be omitted/);
  const finalFile = join(f.options.output, 'drafts', e.finalUnits[1].id, `${hashContent(e.finalUnits[1])}.json`), final = await json(finalFile);
  final.unit.senses[0].tests[0].explanationJa += ' Changed after approval.'; await put(finalFile, final);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.seeds, e.repair.authority, e.authority), /final draft/);
}));
test('unknown source and unsettled unrelated work stop offline application without altering paid artifacts', async () => fixture(async f => {
  const e = await editorialFixture(f), ledgerPath = join(f.options.output, 'ledger.json'), ledger = await json(ledgerPath);
  ledger.calls[1].status = 'uncertain'; await put(ledgerPath, ledger);
  await assert.rejects(runEditorialOverlay({ ...f.options, write: true }), /settled known/);
  ledger.calls[1].status = 'complete'; ledger.calls.push({ id: 'unknown', status: 'uncertain' }); await put(ledgerPath, ledger);
  await assert.rejects(runEditorialOverlay({ ...f.options, write: true }), /settled request boundary/); assert.equal(f.getCalls(), 2);
}));
test('overlay cannot be introduced after final paid review and integration code remains hash bound', async () => fixture(async f => {
  const e = await editorialFixture(f);
  delete f.config.pilotEditorial; await put(f.configPath, f.config);
  await dispatchPilotWorkWithMockSdk({ ...f.options, work: newReviewWork(e.units, { id: 'premature-final', createdAt: date }) }, f.sdk);
  f.config.pilotEditorial = e.authority; await put(f.configPath, f.config);
  await assert.rejects(runEditorialOverlay({ ...f.options, write: true }), /already reviewed or approved/);
  f.config.files.find(file => file.id.endsWith('pilot-editorial.mjs')).sha256 = '0'.repeat(64); await put(f.configPath, f.config);
  await assert.rejects(runEditorialOverlay(f.options), /approval is stale/);
}));
