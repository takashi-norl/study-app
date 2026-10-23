import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generationWorkV2 } from './prompts-v2.mjs';
import { generationWorkV3 } from './prompts-v3.mjs';
import { parseVersionedGeneration } from './work-versions.mjs';
import { hashContent } from './schema.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { measuredPilotSnapshot } from './scale-approval.mjs';
import { seed, generatedContent, response } from './test-fixtures.mjs';
import { planNativeRecovery, recoverNativeUnits } from './offline-native-recovery.mjs';

const date = '2026-10-24T00:00:00.000Z', put = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
function fixture({ adjudication = false, v3 = false } = {}) {
  const target = seed('resilient'), work = (v3 ? generationWorkV3 : generationWorkV2)([target], { id: 'generation-one', createdAt: date });
  const request = boundedRequest({ ...work, reservedUsd: 0.3 }), raw = { schemaVersion: 1, requestId: work.id, requestHash: request.requestHash, response: response({ units: [generatedContent(target)] }), savedAt: date };
  const [original] = parseVersionedGeneration(raw.response, work), unit = structuredClone(original);
  const changes = [];
  if (!adjudication) {
    const before = unit.senses[0].tests[3].choices[1].feedbackJa, after = 'この場面では、困難から回復するという意味を表していません。';
    unit.senses[0].tests[3].choices[1].feedbackJa = after;
    changes.push({ path: '/senses/0/tests/3/choices/1/feedbackJa', before, after });
  }
  const sourceReview = { schemaVersion: 1, sourceRequestId: work.id, workSha256: hashContent(work), rawSha256: hashContent(raw), reviewedBy: 'independent-original-reader', reviewedAt: date,
    verdicts: [{ unitId: original.id, contentSha256: hashContent(original), approved: false, issues: ['Original reviewer identified an ambiguous feedback claim.'] }] };
  const proposal = { schemaVersion: 1, kind: 'offline-native-tests-recovery', id: 'recovery-one', createdBy: 'native-editor', createdAt: date, rows: [{ unitId: unit.id,
    sourceRequestId: work.id, sourceWorkSha256: hashContent(work), sourceRawSha256: hashContent(raw), beforeContentSha256: hashContent(original), sourceReviewFile: 'reviews/source-review.json', sourceReviewSha256: hashContent(sourceReview),
    resolution: adjudication ? 'review-adjudication' : 'material-correction', reasonJa: adjudication ? '原判定の誤りを独立に確認しました。' : '誤答の説明を文脈に即して修正しました。', changes, unit, contentSha256: hashContent(unit) }] };
  const review = { schemaVersion: 1, proposalSha256: hashContent(proposal), reviewedBy: 'independent-final-reader', reviewedAt: date, verdicts: [{ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] }] };
  const rootApproval = { schemaVersion: 1, proposalSha256: hashContent(proposal), reviewSha256: hashContent(review), reviewedBy: '/root', reviewedAt: date, approved: true, issues: [] };
  const state = { schemaVersion: 1, pilot: { maxUnits: 20, seeds: [target] } }, ledger = { schemaVersion: 1, calls: [{ ...request, status: 'complete', actualUsd: 0.02, responseHash: hashContent(raw.response) }] };
  const evidence = new Map([[unit.id, { work: { work, quote: {} }, raw, draft: { unit: original, contentSha256: hashContent(original) }, sourceReview }]]);
  return { proposal, review, rootApproval, state, ledger, evidence, original, unit, work, raw };
}
function rebind(f) { f.review.proposalSha256 = hashContent(f.proposal); f.rootApproval.proposalSha256 = hashContent(f.proposal); f.rootApproval.reviewSha256 = hashContent(f.review); }
async function diskFixture(action, settings) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-native-recovery-'))), output = join(root, 'output'), runtimeDirectory = join(root, 'runtime');
  const f = fixture(settings), options = { output, runtimeDirectory, proposalPath: join(output, 'reviews/proposal.json'), reviewPath: join(output, 'reviews/final-review.json'), rootApprovalPath: join(output, 'reviews/root.json') };
  try {
    await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), 'test-only');
    const config = { enabled: false, paths: { output, runtimeDirectory } };
    await put(join(runtimeDirectory, 'shared-spending-integration.json'), config);
    f.state.sharedLockDirectory = join(runtimeDirectory, 'shared-spending.lock');
    await put(join(output, 'store.json'), f.state); await put(join(output, 'ledger.json'), f.ledger);
    await put(options.proposalPath, f.proposal); await put(options.reviewPath, f.review); await put(options.rootApprovalPath, f.rootApproval);
    const saved = f.evidence.get(f.unit.id);
    await put(join(output, 'requests', f.work.id, 'work.json'), saved.work); await put(join(output, 'requests', f.work.id, 'response.json'), f.raw);
    await put(join(output, 'drafts', f.unit.id, `${hashContent(f.original)}.json`), saved.draft); await put(join(output, 'reviews/source-review.json'), saved.sourceReview);
    await action({ ...f, options, root, config });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('v2 and v3 source cards receive an independently bound tests-only revision; costs and original verdict are retained', () => {
  for (const v3 of [false, true]) {
    const f = fixture({ v3 }), before = hashContent(f), plan = planNativeRecovery(f), row = plan.rows[0];
    assert.equal(row.approved.provenance.sourceActualUsd, 0.02); assert.equal(row.approved.provenance.originalVerdict.approved, false);
    assert.equal(row.approved.provenance.scaleAuthorized, false); assert.equal(row.approved.provenance.paidCalls, 0);
    assert.deepEqual(row.unit.senses[0].examples, f.original.senses[0].examples); assert.equal(row.unit.senses[0].tests.length, 4);
    assert.equal(hashContent(f), before);
  }
});
test('formal review adjudication retains the exact original card and is distinct from material correction', () => {
  const f = fixture({ adjudication: true }); assert.deepEqual(planNativeRecovery(f).rows[0].unit, f.original);
  f.proposal.rows[0].resolution = 'material-correction'; rebind(f); assert.throws(() => planNativeRecovery(f), /remain distinct/);
  const g = fixture(); g.proposal.rows[0].resolution = 'review-adjudication'; rebind(g); assert.throws(() => planNativeRecovery(g), /remain distinct/);
});
test('self approval, stale full-card review, missing root acceptance and duplicate identities fail closed', () => {
  for (const mutate of [f => { f.review.reviewedBy = f.proposal.createdBy; rebind(f); }, f => { f.review.verdicts[0].contentSha256 = '0'.repeat(64); rebind(f); },
    f => { f.rootApproval.approved = false; }, f => { f.rootApproval.reviewSha256 = '0'.repeat(64); },
    f => { f.proposal.rows.push(f.proposal.rows[0]); rebind(f); }, f => { f.review.reviewedBy = f.original.provenance.author; rebind(f); }]) {
    const f = fixture(); mutate(f); assert.throws(() => planNativeRecovery(f));
  }
});
test('unknown, reserved, active and over-budget outcomes never become free editorial retries', () => {
  for (const status of ['reserved', 'requested', 'uncertain', 'batch_pending']) { const f = fixture(); f.ledger.calls[0].status = status; assert.throws(() => planNativeRecovery(f), /paid outcomes settled/); }
  for (const patch of [{ actualUsd: null }, { actualUsd: 1 }, { accountingHold: 'unknown-billing' }]) { const f = fixture(); Object.assign(f.ledger.calls[0], patch); assert.throws(() => planNativeRecovery(f)); }
  const f = fixture(); f.ledger.calls.push({ ...f.ledger.calls[0], id: 'later-paid-review', stage: 'review' }); assert.throws(() => planNativeRecovery(f), /later repair or paid review/);
});
test('work, raw, draft, held source review and original registered seed hashes are all mandatory', () => {
  for (const mutate of [f => { f.raw.response.usage.output_tokens++; }, f => { f.work.params.output_config.effort = 'low'; },
    f => { f.evidence.get(f.unit.id).draft.contentSha256 = '0'.repeat(64); }, f => { f.evidence.get(f.unit.id).sourceReview.verdicts[0].approved = true; },
    f => { f.state.pilot.seeds[0].aliases.push('something-else'); }, f => { f.proposal.rows[0].sourceRawSha256 = '0'.repeat(64); rebind(f); }]) {
    const f = fixture(); mutate(f); assert.throws(() => planNativeRecovery(f));
  }
});
test('all exact before/after changes must reproduce the complete card; examples, meanings, seed and provenance cannot change', () => {
  for (const path of ['/lemma', '/senses/0/examples/0/text', '/senses/0/meaningJa', '/provenance/author', '/senses/0/tests/0/choices/4/text', '/__proto__/polluted']) {
    const f = fixture(); f.proposal.rows[0].changes[0].path = path; rebind(f); assert.throws(() => planNativeRecovery(f));
  }
  for (const mutate of [f => { f.proposal.rows[0].changes[0].before = 'not the source'; },
    f => { f.proposal.rows[0].unit.senses[0].examples[0].text = 'Changed spoken sentence.'; f.proposal.rows[0].contentSha256 = hashContent(f.proposal.rows[0].unit); },
    f => { f.proposal.rows[0].changes.push(f.proposal.rows[0].changes[0]); }]) { const f = fixture(); mutate(f); rebind(f); assert.throws(() => planNativeRecovery(f)); }
});
test('exact alternatives array removal is allowed, while malformed replacements and hidden changes are rejected', () => {
  const f = fixture(), original = f.original, question = original.senses[0].tests[2];
  question.alternatives.push({ text: 'flexible', meaningJa: '柔軟な', noteJa: '比較する文脈を明示する。' });
  // Rebuild source raw with the same authored alternative so the test remains bound to paid evidence.
  const payload = generatedContent(f.state.pilot.seeds[0]); payload.tests[2].alternatives = question.alternatives;
  f.raw.response = response({ units: [payload] }); f.ledger.calls[0].responseHash = hashContent(f.raw.response);
  const row = f.proposal.rows[0], saved = f.evidence.get(f.unit.id);
  row.beforeContentSha256 = hashContent(original); row.sourceRawSha256 = hashContent(f.raw); saved.draft.contentSha256 = row.beforeContentSha256;
  saved.sourceReview.rawSha256 = row.sourceRawSha256; saved.sourceReview.verdicts[0].contentSha256 = row.beforeContentSha256; row.sourceReviewSha256 = hashContent(saved.sourceReview);
  row.changes.push({ path: '/senses/0/tests/2/alternatives', before: question.alternatives, after: [] }); rebind(f);
  assert.equal(planNativeRecovery(f).rows[0].unit.senses[0].tests[2].alternatives.length, 0);
  row.changes[1].after = 'not an array'; rebind(f); assert.throws(() => planNativeRecovery(f), /complete arrays/);
});
test('dry-run writes no approved data; exact write is idempotent and retains original raw, draft, ledger and disabled config', async () => diskFixture(async f => {
  const originals = [join(f.options.output, 'ledger.json'), join(f.options.output, 'requests', f.work.id, 'response.json'), join(f.options.output, 'drafts', f.unit.id, `${hashContent(f.original)}.json`), join(f.options.runtimeDirectory, 'shared-spending-integration.json')];
  const before = await Promise.all(originals.map(file => readFile(file, 'utf8')));
  assert.equal((await recoverNativeUnits(f.options)).mode, 'dry-run');
  await assert.rejects(readFile(join(f.options.output, 'approved', `${f.unit.id}.json`)), /ENOENT/);
  const written = await recoverNativeUnits({ ...f.options, write: true }); assert.equal(written.paidCalls, 0); assert.equal(written.replayed, false);
  const again = await recoverNativeUnits({ ...f.options, write: true }); assert.equal(again.replayed, true);
  assert.deepEqual(await Promise.all(originals.map(file => readFile(file, 'utf8'))), before);
  await assert.rejects(measuredPilotSnapshot(f.options.output, f.state.pilot.seeds), /does not authorize scale/);
}));
test('live worker lock, absent stop and enabled spending prevent offline publication', async () => {
  for (const blocked of ['shared', 'production', 'no-stop', 'enabled']) await diskFixture(async f => {
    if (blocked === 'shared') await mkdir(join(f.options.runtimeDirectory, 'shared-spending.lock'));
    if (blocked === 'production') await writeFile(join(f.options.runtimeDirectory, 'production.lock'), 'active');
    if (blocked === 'no-stop') await rm(join(f.options.runtimeDirectory, 'stop-production'));
    if (blocked === 'enabled') await put(join(f.options.runtimeDirectory, 'shared-spending-integration.json'), { ...f.config, enabled: true });
    await assert.rejects(recoverNativeUnits({ ...f.options, write: true }));
    await assert.rejects(readFile(join(f.options.output, 'approved', `${f.unit.id}.json`)), /ENOENT/);
  });
});
test('a different runtime cannot bypass the shared lock fixed by the store', async () => diskFixture(async f => {
  const actualLock = join(f.root, 'original-runtime', 'shared-spending.lock');
  await mkdir(actualLock, { recursive: true });
  await put(join(f.options.output, 'store.json'), { ...f.state, sharedLockDirectory: actualLock });
  await assert.rejects(recoverNativeUnits({ ...f.options, write: true }), /exact shared lock bound to this store/);
  await assert.rejects(readFile(join(f.options.output, 'approved', `${f.unit.id}.json`)), /ENOENT/);
}));
test('another approved revision, later draft, changed authority and evidence symlink are never overwritten', async () => {
  for (const blocked of ['approved', 'draft', 'authority', 'symlink']) await diskFixture(async f => {
    if (blocked === 'approved') await put(join(f.options.output, 'approved', `${f.unit.id}.json`), { unrelated: true });
    if (blocked === 'draft') await put(join(f.options.output, 'drafts', f.unit.id, `${'0'.repeat(64)}.json`), { unrelated: true });
    if (blocked === 'authority') { await recoverNativeUnits({ ...f.options, write: true }); f.proposal.rows[0].reasonJa += 'changed'; await put(f.options.proposalPath, f.proposal); }
    if (blocked === 'symlink') { const outside = join(f.root, 'outside.json'); await put(outside, f.proposal); await rm(f.options.proposalPath); await symlink(outside, f.options.proposalPath); }
    await assert.rejects(recoverNativeUnits({ ...f.options, write: true }));
  });
});
test('an exact interrupted intent can finish locally, but a missing completed approval cannot be silently recreated', async () => diskFixture(async f => {
  await recoverNativeUnits({ ...f.options, write: true });
  const receipt = join(f.options.output, 'native-recoveries', f.proposal.id, 'receipt.json'), approved = join(f.options.output, 'approved', `${f.unit.id}.json`);
  // Simulate a crash after authority/intent/draft, before approval and final receipt.
  await rm(receipt); await rm(approved);
  assert.equal((await recoverNativeUnits({ ...f.options, write: true })).replayed, true);
  await rm(approved);
  await assert.rejects(recoverNativeUnits({ ...f.options, write: true }), /completed approved recovery is missing/);
}));
test('tampered saved recovery evidence and unrelated paid calls without raw cannot pass even dry-run', async () => {
  await diskFixture(async f => {
    await recoverNativeUnits({ ...f.options, write: true });
    await put(join(f.options.output, 'native-recoveries', f.proposal.id, 'source-evidence.json'), {});
    await assert.rejects(recoverNativeUnits(f.options), /evidence changed/);
  });
  await diskFixture(async f => {
    f.ledger.calls.push({ ...f.ledger.calls[0], id: 'unrelated-paid-call', unitIds: [seed('otherword').id] });
    await put(join(f.options.output, 'ledger.json'), f.ledger);
    await assert.rejects(recoverNativeUnits(f.options), /ENOENT/);
  });
});
