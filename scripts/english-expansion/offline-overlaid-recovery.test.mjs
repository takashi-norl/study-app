import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { seed, generatedContent, response } from './test-fixtures.mjs';
import { generationWorkV2 } from './prompts-v2.mjs';
import { generationWorkV5, parseGeneratedV5 } from './prompts-v5.mjs';
import { parseVersionedGeneration } from './work-versions.mjs';
import { hashContent, unitIdFor, approveUnit } from './schema.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { prepareOverlaidRecovery, recoverOverlaidUnits, planOverlaidRecovery } from './offline-overlaid-recovery.mjs';

const date = '2026-10-24T00:00:00.000Z';
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
function makeRequest(target, index, v5 = false) {
  const work = (v5 ? generationWorkV5 : generationWorkV2)([target], { id: `generation-${index}`, createdAt: date });
  const request = boundedRequest({ ...work, reservedUsd: 0.2 });
  const raw = { schemaVersion: 1, requestId: work.id, requestHash: request.requestHash, response: response({ units: [generatedContent(target)] }), savedAt: date };
  const unit = (v5 ? parseGeneratedV5 : parseVersionedGeneration)(raw.response, work)[0];
  return { work, raw, unit, call: { ...request, status: 'complete', actualUsd: 0.01, responseHash: hashContent(raw.response) } };
}
function fixture() {
  const target = { ...seed('on the same wavelength'), kind: 'phrase', id: unitIdFor('phrase', 'on the same wavelength') };
  const requests = ['apple', 'orange', 'pear', 'lemon', 'melon', 'peach'].map((term, i) => makeRequest(seed(term), i));
  const saved = makeRequest(target, 6, true); requests.push(saved);
  const original = saved.unit, unit = structuredClone(original), before = unit.senses[0].tests[3].choices[3].feedbackJa, after = '発言の明示内容に限った、修正済みの説明です。';
  unit.senses[0].tests[3].choices[3].feedbackJa = after;
  const held = { schemaVersion: 1, sourceRequestId: saved.work.id, workSha256: hashContent(saved.work), rawSha256: hashContent(saved.raw), reviewedBy: 'independent-source-reader', reviewedAt: date,
    verdicts: [{ unitId: unit.id, contentSha256: hashContent(original), approved: false, issues: ['Feedback assumes an unstated motive.'] }] };
  const proposal = { schemaVersion: 1, kind: 'offline-native-tests-recovery', id: 'v5-correction', createdBy: 'content-editor', createdAt: date,
    rows: [{ unitId: unit.id, sourceRequestId: saved.work.id, sourceWorkSha256: hashContent(saved.work), sourceRawSha256: hashContent(saved.raw), beforeContentSha256: hashContent(original),
      sourceReviewFile: 'reviews/original-review.json', sourceReviewSha256: hashContent(held), resolution: 'material-correction', reasonJa: '説明を明示内容に合わせました。',
      changes: [{ path: '/senses/0/tests/3/choices/3/feedbackJa', before, after }], unit, contentSha256: hashContent(unit) }] };
  const review = { schemaVersion: 1, proposalSha256: hashContent(proposal), reviewedBy: 'independent-final-reader', reviewedAt: date,
    verdicts: [{ unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] }] };
  return { operation: 'v5-one-phrase', proposal, review, original, unit, held, requests, saved,
    state: { schemaVersion: 1, pilot: { maxUnits: 20, seeds: [...requests.slice(0, 6).map(item => item.work.seeds[0]), target] } }, ledger: { schemaVersion: 1, calls: requests.map(item => item.call) }, originals: [original] };
}
async function disk(action) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hibi-overlaid-recovery-'))), output = join(base, 'output'), runtimeDirectory = join(base, 'runtime'), phaseOneOutput = join(base, 'phase-one');
  const f = fixture(), options = { id: 'offline-v5-one-phrase-v1', operation: f.operation, output, runtimeDirectory, proposalPath: join(output, 'reviews/proposal.json'), reviewPath: join(output, 'reviews/final.json') };
  try {
    await mkdir(runtimeDirectory, { recursive: true }); await mkdir(phaseOneOutput); await writeFile(join(runtimeDirectory, 'stop-production'), 'test checkpoint');
    const config = { enabled: false, paths: { output, runtimeDirectory, phaseOneOutput, sharedLockDirectory: join(runtimeDirectory, 'shared-spending.lock') } };
    await put(join(runtimeDirectory, 'shared-spending-integration.json'), config);
    f.state.sharedLockDirectory = config.paths.sharedLockDirectory;
    await put(join(output, 'store.json'), f.state); await put(join(output, 'ledger.json'), f.ledger);
    await put(join(output, 'native-recoveries/scale-hold.json'), { schemaVersion: 1, scaleAuthorized: false, automaticallyReleasable: false });
    await put(options.proposalPath, f.proposal); await put(options.reviewPath, f.review); await put(join(output, 'reviews/original-review.json'), f.held);
    for (const item of f.requests) {
      await put(join(output, 'requests', item.work.id, 'work.json'), { work: item.work, quote: {} }); await put(join(output, 'requests', item.work.id, 'response.json'), item.raw);
    }
    await put(join(output, 'drafts', f.unit.id, `${hashContent(f.original)}.json`), { unit: f.original, contentSha256: hashContent(f.original) });
    for (const item of f.requests.slice(0, 5)) {
      await put(join(output, 'approved', `${item.unit.id}.json`), approveUnit(item.unit, { reviewer: 'earlier-reviewer', reviewedAt: date, unitId: item.unit.id, contentSha256: hashContent(item.unit), approved: true, issues: [] }));
    }
    const authorityPath = join(base, 'root-authority.json');
    const authorize = async () => {
      const draft = await prepareOverlaidRecovery(options), authority = { ...draft, approved: true, reviewedBy: '/root', reviewedAt: date };
      await put(authorityPath, authority); return authority;
    };
    await action({ ...f, options, config, authorityPath, authorize, base });
  } finally { await rm(base, { recursive: true, force: true }); }
}

test('only exact test corrections pass; meanings, examples, seed and provenance remain unchanged', () => {
  const f = fixture(), plan = planOverlaidRecovery(f);
  assert.equal(plan.rows.length, 1); assert.equal(plan.paidCalls, 0); assert.equal(plan.scaleAuthorized, false);
  for (const mutation of [x => { x.proposal.rows[0].unit.senses[0].meaningJa = 'Hidden meaning edit'; }, x => { x.proposal.rows[0].unit.senses[0].examples[0].text = 'Hidden spoken edit'; },
    x => { x.proposal.rows[0].unit.provenance.author = 'Different author'; }, x => { x.proposal.rows[0].changes[0].path = '/senses/0/tests/3/prompt'; },
    x => { x.state.pilot.seeds.at(-1).aliases.push('changed-seed'); }]) {
    const g = fixture(); mutation(g); g.proposal.rows[0].contentSha256 = hashContent(g.proposal.rows[0].unit); g.review.proposalSha256 = hashContent(g.proposal); g.review.verdicts[0].contentSha256 = g.proposal.rows[0].contentSha256;
    assert.throws(() => planOverlaidRecovery(g));
  }
});
test('self approval, omitted verdict, held verdict, stale hash and unsettled calls reject', () => {
  for (const mutate of [f => { f.review.reviewedBy = f.proposal.createdBy; }, f => { f.review.reviewedBy = f.unit.provenance.author; }, f => { f.review.verdicts = []; },
    f => { f.review.verdicts[0].approved = false; }, f => { f.review.verdicts[0].contentSha256 = '0'.repeat(64); }, f => { f.ledger.calls[0].status = 'uncertain'; },
    f => { f.ledger.calls[0].accountingHold = 'billing-unknown'; }, f => { f.ledger.calls[0].actualUsd = 0.3; }, f => { f.ledger.calls.pop(); }]) {
    const f = fixture(); mutate(f); assert.throws(() => planOverlaidRecovery(f));
  }
});
test('first-five pure gate admits four unchanged cards and exactly reciprocate three reviewed leaves', () => {
  const terms = ['conundrum', 'elucidate', 'intractable', 'reciprocate', 'repercussion'], generated = terms.map((term, i) => makeRequest(seed(term), i));
  const f = fixture(); f.operation = 'first-five-overlay'; f.originals = generated.map(item => item.unit); f.state.pilot.seeds = generated.map(item => item.work.seeds[0]);
  f.proposal = { schemaVersion: 1, id: 'first-five', kind: 'offline-overlaid-native-tests-proposal', createdBy: 'content-editor', rows: generated.map(({ unit: original }) => {
    const unit = structuredClone(original), changes = [];
    if (unit.lemma === 'reciprocate') for (const [path, target, key] of [
      ['/senses/0/tests/3/prompt', unit.senses[0].tests[3], 'prompt'], ['/senses/0/tests/3/explanationJa', unit.senses[0].tests[3], 'explanationJa'],
      ['/senses/0/tests/3/choices/0/feedbackJa', unit.senses[0].tests[3].choices[0], 'feedbackJa']]) {
      const before = target[key], after = `${before} 条件を明確化しました。`; target[key] = after; changes.push({ path, before, after });
    }
    return { unitId: unit.id, beforeContentSha256: hashContent(original), contentSha256: hashContent(unit), unit, changes, resolution: changes.length ? 'material-correction' : 'review-adjudication' };
  }) };
  f.review.proposalSha256 = hashContent(f.proposal); f.review.verdicts = f.proposal.rows.map(row => ({ unitId: row.unitId, contentSha256: row.contentSha256, approved: true, issues: [] }));
  assert.equal(planOverlaidRecovery(f).rows.length, 5);
  f.proposal.rows[0].changes = f.proposal.rows[3].changes; f.review.proposalSha256 = hashContent(f.proposal); assert.throws(() => planOverlaidRecovery(f), /exact reviewed/);
});
test('false preparation is nonexecutable; dry run preserves all paid evidence; real writes use private store and replay idempotently', async () => disk(async f => {
  const draft = await prepareOverlaidRecovery(f.options); assert.equal(draft.approved, false); assert.equal(draft.paidCallCount, 7);
  await put(f.authorityPath, draft); await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /root application authority/);
  await f.authorize(); const ledgerBefore = await readFile(join(f.options.output, 'ledger.json')); const sourceBefore = await readFile(join(f.options.output, 'requests/generation-6/response.json'));
  assert.equal((await recoverOverlaidUnits({ authorityPath: f.authorityPath })).mode, 'dry-run');
  await assert.rejects(readFile(join(f.options.output, 'approved', `${f.unit.id}.json`)), /ENOENT/);
  const result = await recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }); assert.equal(result.paidCalls, 0); assert.equal(result.replayed, false);
  const repeated = await recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }); assert.equal(repeated.replayed, true);
  assert.deepEqual(await readFile(join(f.options.output, 'ledger.json')), ledgerBefore); assert.deepEqual(await readFile(join(f.options.output, 'requests/generation-6/response.json')), sourceBefore);
  const approved = JSON.parse(await readFile(join(f.options.output, 'approved', `${f.unit.id}.json`))); assert.deepEqual(approved, approveUnit(f.unit, { reviewer: f.review.reviewedBy, reviewedAt: date, unitId: f.unit.id, contentSha256: hashContent(f.unit), approved: true, issues: [] }));
}));
test('interrupted exact intent drains remaining writes, but a completed receipt with a missing asset refuses repair', async () => disk(async f => {
  await f.authorize(); await recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true });
  const operation = join(f.options.output, 'offline-reviewed-recoveries', f.options.id), asset = join(f.options.output, 'approved', `${f.unit.id}.json`);
  await rm(asset); await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /missing an approved asset/);
  await rm(join(operation, 'receipt.json')); assert.equal((await recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true })).replayed, true);
  const evidence = JSON.parse(await readFile(join(operation, 'evidence.json'))); evidence.plan.paidHistory[0].actualUsd = 0;
  await put(join(operation, 'evidence.json'), evidence); await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /provenance evidence changed/);
}));
test('stale config, ledger, held review, raw bytes and original approved bytes fail before any new approval', async () => {
  for (const name of ['config', 'ledger', 'review', 'raw', 'approved']) await disk(async f => {
    await f.authorize(); const paths = { config: join(f.options.runtimeDirectory, 'shared-spending-integration.json'), ledger: join(f.options.output, 'ledger.json'), review: join(f.options.output, 'reviews/original-review.json'), raw: join(f.options.output, 'requests/generation-6/response.json'), approved: join(f.options.output, 'approved', `${f.requests[0].unit.id}.json`) };
    const path = paths[name]; await writeFile(path, (await readFile(path, 'utf8')) + '\n');
    await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /baseline changed/);
    await assert.rejects(readFile(join(f.options.output, 'approved', `${f.unit.id}.json`)), /ENOENT/);
  });
});
test('active worker, shared lock, enabled integration, missing stop, and changed scale hold prohibit prepare', async () => {
  for (const type of ['worker', 'shared', 'enabled', 'stop', 'hold']) await disk(async f => {
    if (type === 'worker') await mkdir(join(f.options.runtimeDirectory, 'production.lock'));
    if (type === 'shared') await mkdir(join(f.options.runtimeDirectory, 'shared-spending.lock'));
    if (type === 'enabled') { f.config.enabled = true; await put(join(f.options.runtimeDirectory, 'shared-spending-integration.json'), f.config); }
    if (type === 'stop') await rm(join(f.options.runtimeDirectory, 'stop-production'));
    if (type === 'hold') await put(join(f.options.output, 'native-recoveries/scale-hold.json'), { scaleAuthorized: true, automaticallyReleasable: true });
    await assert.rejects(prepareOverlaidRecovery(f.options));
  });
});
test('a later paid revision, unknown draft or preexisting target approval cannot be silently adopted', async () => {
  for (const type of ['later', 'draft', 'approved']) await disk(async f => {
    if (type === 'later') { f.ledger.calls[0].unitIds = [f.unit.id]; await put(join(f.options.output, 'ledger.json'), f.ledger); }
    if (type === 'draft') await put(join(f.options.output, 'drafts', f.unit.id, `${'f'.repeat(64)}.json`), { unit: f.unit });
    if (type === 'approved') await put(join(f.options.output, 'approved', `${f.unit.id}.json`), { unit: f.unit });
    await assert.rejects(prepareOverlaidRecovery(f.options));
  });
});
test('symlinked source paths and post-intent conflicting approved revisions fail closed', async () => disk(async f => {
  await f.authorize(); await recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true });
  const target = join(f.options.output, 'approved', `${f.unit.id}.json`); const old = JSON.parse(await readFile(target)); old.unit.senses[0].meaningJa = 'Conflicting revision'; await put(target, old);
  await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /Approved target differs/);
  await rm(target); const source = join(f.options.output, 'reviews/original-review.json'); await rm(source); const outside = join(f.base, 'outside.json'); await put(outside, f.held); await symlink(outside, source);
  await assert.rejects(recoverOverlaidUnits({ authorityPath: f.authorityPath, write: true }), /symbolic links/);
}));
