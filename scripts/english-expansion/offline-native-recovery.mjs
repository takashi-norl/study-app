import { lstat, realpath, mkdir, open, readFile, link, unlink, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { approveUnit, canonicalJson, hashContent, validateUnit } from './schema.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { assertOnlyTestsChanged } from './pilot-repair.mjs';
import { checkedVersionedWork, parseVersionedGeneration } from './work-versions.mjs';
import { readJson, readOptionalJson, withExpansionLock } from './store.mjs';

const text = z.string().trim().min(1), sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const leafPath = /^\/senses\/[0-5]\/tests\/[0-3]\/(?:prompt|explanationJa|correctIndex|choices\/[0-3]\/(?:text|meaningJa|feedbackJa)|alternatives(?:\/[0-3]\/(?:text|meaningJa|noteJa))?)$/;
const change = z.object({ path: z.string().regex(leafPath), before: z.unknown(), after: z.unknown() }).strict();
export const nativeRecoveryProposalSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('offline-native-tests-recovery'), id,
  createdBy: text, createdAt: z.string().datetime(), rows: z.array(z.object({ unitId: id, sourceRequestId: id,
    sourceWorkSha256: sha, sourceRawSha256: sha, beforeContentSha256: sha,
    sourceReviewFile: z.string().regex(/^reviews\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/), sourceReviewSha256: sha,
    resolution: z.enum(['material-correction', 'review-adjudication']), reasonJa: text.max(2000),
    changes: z.array(change).max(160), unit: z.unknown(), contentSha256: sha }).strict()).min(1).max(20) }).strict();
export const nativeRecoveryReviewSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: sha, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(z.object({ unitId: id, contentSha256: sha, approved: z.literal(true), issues: z.array(text).length(0) }).strict()).min(1).max(20) }).strict();
export const nativeRecoveryRootSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: sha, reviewSha256: sha,
  reviewedBy: z.literal('/root'), reviewedAt: z.string().datetime(), approved: z.literal(true), issues: z.array(text).length(0) }).strict();
const originalReviewSchema = z.object({ schemaVersion: z.literal(1), sourceRequestId: id, workSha256: sha, rawSha256: sha,
  reviewedBy: text, reviewedAt: z.string().datetime(), verdicts: z.array(z.object({ unitId: id, contentSha256: sha,
    approved: z.boolean(), issues: z.array(text).max(20) }).strict()).min(1).max(5) }).strict();
const unique = values => new Set(values).size === values.length;

/** Applies only already-existing test leaves; complete card comparison prevents undocumented edits. */
export function applyNativeRecoveryChanges(original, row) {
  const next = structuredClone(original);
  if (!unique(row.changes.map(item => item.path))) throw Error('Duplicate editorial path.');
  for (const edit of row.changes) {
    if (!leafPath.test(edit.path) || hashContent(edit.before) === hashContent(edit.after)) throw Error('Recovery must name an actual test change.');
    const parts = edit.path.slice(1).split('/'), leaf = parts.pop(); let target = next;
    for (const key of parts) { if (!target || !Object.hasOwn(target, key)) throw Error('Recovery path is missing.'); target = target[key]; }
    if (!target || !Object.hasOwn(target, leaf) || hashContent(target[leaf]) !== hashContent(edit.before)) throw Error('Recovery before value changed.');
    if (leaf === 'correctIndex') {
      if (![edit.before, edit.after].every(value => Number.isInteger(value) && value >= 0 && value < 4)) throw Error('Invalid correct answer index.');
    } else if (leaf === 'alternatives') {
      if (![edit.before, edit.after].every(Array.isArray)) throw Error('Alternatives replacement must bind both complete arrays.');
    } else if (![edit.before, edit.after].every(value => typeof value === 'string' && value.trim())) throw Error('Only nonempty existing text leaves can be replaced.');
    target[leaf] = structuredClone(edit.after);
  }
  const unit = validateUnit(next); assertOnlyTestsChanged(original, unit);
  if (hashContent(unit) !== row.contentSha256 || hashContent(row.unit) !== row.contentSha256) throw Error('The full final unit differs from its exact documented changes.');
  if (row.resolution === 'review-adjudication' ? row.changes.length || row.beforeContentSha256 !== row.contentSha256
    : !row.changes.length || row.beforeContentSha256 === row.contentSha256) throw Error('Adjudication and material correction must remain distinct.');
  return unit;
}

/** Pure validation. This first version deliberately rejects repaired/paid-reviewed/overlaid sources. */
export function planNativeRecovery({ proposal: rawProposal, review: rawReview, rootApproval: rawRoot, state, ledger, evidence }) {
  const proposal = nativeRecoveryProposalSchema.parse(rawProposal), review = nativeRecoveryReviewSchema.parse(rawReview), rootApproval = nativeRecoveryRootSchema.parse(rawRoot);
  const proposalSha256 = hashContent(proposal), reviewSha256 = hashContent(review);
  if (!unique(proposal.rows.map(row => row.unitId)) || !unique(review.verdicts.map(row => row.unitId)) || review.verdicts.length !== proposal.rows.length
    || review.proposalSha256 !== proposalSha256 || rootApproval.proposalSha256 !== proposalSha256 || rootApproval.reviewSha256 !== reviewSha256
    || review.reviewedBy === proposal.createdBy) throw Error('Exact independent full-card review and root approval are required.');
  if (state?.schemaVersion !== 1 || state.pilot?.maxUnits !== 20 || !Array.isArray(state.pilot.seeds) || state.pilot.seeds.length > 20
    || ledger?.schemaVersion !== 1 || !Array.isArray(ledger.calls) || !unique(ledger.calls.map(call => call.id))
    || ledger.calls.some(call => call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd) || call.actualUsd < 0
      || !sha.safeParse(call.requestHash).success || !sha.safeParse(call.responseHash).success
      || !Number.isFinite(call.reservedUsd) || call.reservedUsd <= 0 || call.actualUsd > call.reservedUsd + 1e-9)) throw Error('Offline recovery requires all paid outcomes settled with their costs retained.');
  const rows = proposal.rows.map(row => {
    const saved = evidence.get(row.unitId), call = ledger.calls.find(item => item.id === row.sourceRequestId);
    if (!saved || !call || call.stage !== 'generation' || call.repairOf || call.repairPlanSha256 || !call.unitIds?.includes(row.unitId)) throw Error('Exact original generation evidence is required; later-stage recovery is unsupported.');
    if (ledger.calls.some(item => item.id !== call.id && item.unitIds?.includes(row.unitId))) throw Error('A later repair or paid review exists; recovering an earlier generation would discard its lineage.');
    const { work } = saved.work;
    checkedVersionedWork(work);
    if (work.kind || work.stage !== 'generation' || work.id !== call.id || hashContent(work.unitIds) !== hashContent(call.unitIds)
      || hashContent(work) !== row.sourceWorkSha256 || hashContent(saved.raw) !== row.sourceRawSha256
      || saved.raw.requestId !== call.id || saved.raw.requestHash !== call.requestHash || hashContent(saved.raw.response) !== call.responseHash
      || boundedRequest({ ...work, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw Error('Saved work, raw and paid ledger do not describe the same request.');
    const generated = parseVersionedGeneration(saved.raw.response, work), original = generated.find(unit => unit.id === row.unitId);
    if (!original || hashContent(original) !== row.beforeContentSha256 || saved.draft?.contentSha256 !== row.beforeContentSha256
      || hashContent(saved.draft.unit) !== row.beforeContentSha256) throw Error('Source must be the exact durable paid-generation draft.');
    const seed = state.pilot.seeds.find(item => item.id === row.unitId);
    if (!seed || Object.keys(seed).some(key => hashContent(seed[key]) !== hashContent(original[key]))) throw Error('Registered reviewed seed changed.');
    const priorReview = originalReviewSchema.parse(saved.sourceReview), priorVerdicts = priorReview.verdicts.filter(item => item.unitId === row.unitId);
    if (hashContent(priorReview) !== row.sourceReviewSha256 || priorReview.sourceRequestId !== call.id || priorReview.workSha256 !== row.sourceWorkSha256
      || priorReview.rawSha256 !== row.sourceRawSha256 || priorReview.reviewedBy === original.provenance.author
      || priorVerdicts.length !== 1 || priorVerdicts[0].contentSha256 !== row.beforeContentSha256 || priorVerdicts[0].approved || !priorVerdicts[0].issues.length) throw Error('The exact independent held verdict must be preserved as recovery evidence.');
    const unit = applyNativeRecoveryChanges(original, row), verdict = review.verdicts.find(item => item.unitId === row.unitId);
    if (!verdict || verdict.contentSha256 !== row.contentSha256 || review.reviewedBy === unit.provenance.author) throw Error('Final independent review must bind the complete corrected unit.');
    const receipt = { reviewer: review.reviewedBy, reviewedAt: review.reviewedAt, unitId: unit.id, contentSha256: row.contentSha256, approved: true, issues: [] };
    const approved = { ...approveUnit(unit, receipt), provenance: { method: 'offline-native-independent-editorial-review',
      proposalId: proposal.id, proposalSha256, reviewSha256, rootApprovalSha256: hashContent(rootApproval),
      sourceRequestId: call.id, sourceRequestHash: call.requestHash, sourceWorkSha256: row.sourceWorkSha256,
      sourceRawSha256: row.sourceRawSha256, sourceContentSha256: row.beforeContentSha256, sourceReviewSha256: row.sourceReviewSha256,
      originalVerdict: priorVerdicts[0], originalReviewer: priorReview.reviewedBy, sourceCallSha256: hashContent(call), sourceActualUsd: call.actualUsd,
      resolution: row.resolution, reasonJa: row.reasonJa, changes: row.changes, editorialAuthor: proposal.createdBy,
      generatedAuthor: unit.provenance.author, textOnly: true, paidCalls: 0, scaleAuthorized: false } };
    return { row, unit, receipt, approved, approvedSha256: hashContent(approved) };
  });
  return { proposal, review, rootApproval, proposalSha256, reviewSha256, rows };
}

const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function contained(output, file) {
  const target = isAbsolute(file) ? file : join(output, file), actual = await realpath(target), rel = relative(output, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || actual !== resolve(target)) throw Error('Recovery evidence escaped its exact private location.');
  return actual;
}
async function immutable(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(file)) !== resolve(dirname(file))) throw Error('Recovery output directory cannot be a symbolic link.');
  if (await exists(file) && (await lstat(file)).isSymbolicLink()) throw Error('Immutable recovery output cannot be a symbolic link.');
  const prior = await readOptionalJson(file);
  if (prior) { if (hashContent(prior) !== hashContent(value)) throw Error('Immutable recovery output already differs.'); return; }
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(canonicalJson(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file); } finally { await unlink(temporary); }
  const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
async function stopped(options) {
  if (!await exists(join(options.runtimeDirectory, 'stop-production'))) throw Error('Explicit production stop checkpoint required.');
  if (await exists(join(options.runtimeDirectory, 'production.lock'))) throw Error('Production worker is still active.');
  const config = await readJson(join(options.runtimeDirectory, 'shared-spending-integration.json'));
  if (config.enabled !== false || config.paths?.output !== options.output || config.paths?.runtimeDirectory !== options.runtimeDirectory) throw Error('Paid expansion must remain explicitly disabled at its exact directories.');
  return config;
}

export async function recoverNativeUnits(options) {
  for (const key of ['output', 'runtimeDirectory', 'proposalPath', 'reviewPath', 'rootApprovalPath']) if (!isAbsolute(options[key] ?? '')) throw Error('Absolute explicit private paths are required.');
  if (await realpath(options.output) !== resolve(options.output) || await realpath(options.runtimeDirectory) !== resolve(options.runtimeDirectory)) throw Error('Private root directories cannot be symbolic links.');
  const config = await stopped(options), sharedLockDirectory = join(options.runtimeDirectory, 'shared-spending.lock');
  return withExpansionLock({ output: options.output, sharedLockDirectory }, async lease => {
    if (hashContent(await stopped(options)) !== hashContent(config)) throw Error('Disabled configuration changed.');
    const [proposal, review, rootApproval, state, ledger] = await Promise.all([
      contained(options.output, options.proposalPath).then(readJson), contained(options.output, options.reviewPath).then(readJson), contained(options.output, options.rootApprovalPath).then(readJson),
      contained(options.output, 'store.json').then(readJson), contained(options.output, 'ledger.json').then(readJson),
    ]);
    if (state.sharedLockDirectory !== sharedLockDirectory) throw Error('Recovery must acquire the exact shared lock bound to this store.');
    const parsed = nativeRecoveryProposalSchema.parse(proposal), evidence = new Map();
    for (const row of parsed.rows) {
      const base = `requests/${row.sourceRequestId}`;
      evidence.set(row.unitId, { work: await readJson(await contained(options.output, `${base}/work.json`)), raw: await readJson(await contained(options.output, `${base}/response.json`)),
        draft: await readJson(await contained(options.output, `drafts/${row.unitId}/${row.beforeContentSha256}.json`)), sourceReview: await readJson(await contained(options.output, row.sourceReviewFile)) });
    }
    const plan = planNativeRecovery({ proposal, review, rootApproval, state, ledger, evidence });
    // A settled flag alone is not evidence for an unrelated call's known result.
    for (const call of ledger.calls) {
      id.parse(call.id);
      const raw = await readJson(await contained(options.output, `requests/${call.id}/response.json`));
      if (raw.requestId !== call.id || raw.requestHash !== call.requestHash || hashContent(raw.response) !== call.responseHash) throw Error('Every settled call must retain its exact paid response.');
    }
    const directory = join(options.output, 'native-recoveries', plan.proposal.id), oldIntent = await readOptionalJson(join(directory, 'intent.json'));
    const intent = { schemaVersion: 1, kind: 'offline-native-tests-recovery', proposalSha256: plan.proposalSha256, reviewSha256: plan.reviewSha256,
      rootApprovalSha256: hashContent(plan.rootApproval), storeSha256: hashContent(state), ledgerSha256: hashContent(ledger), disabledConfigSha256: hashContent(config),
      rows: plan.rows.map(item => ({ unitId: item.unit.id, contentSha256: hashContent(item.unit), approvedSha256: item.approvedSha256 })), paidCalls: 0, scaleAuthorized: false };
    if (oldIntent && hashContent(oldIntent) !== hashContent(intent)) throw Error('An interrupted or completed recovery has different evidence.');
    const completedReceipt = await readOptionalJson(join(directory, 'receipt.json'));
    if (completedReceipt && (!oldIntent || hashContent(completedReceipt) !== hashContent({ ...intent, completed: true }))) throw Error('Completed recovery receipt differs from its exact intent.');
    if (oldIntent) for (const [name, expected] of [['authority.json', { proposal, review, rootApproval }], ['source-evidence.json', Object.fromEntries(evidence)]]) {
      const actual = await readJson(join(directory, name));
      if (hashContent(actual) !== hashContent(expected)) throw Error('Recovery evidence changed after its immutable intent.');
    }
    for (const item of plan.rows) {
      const previous = await readOptionalJson(join(options.output, 'approved', `${item.unit.id}.json`));
      if (previous && (!oldIntent || hashContent(previous) !== item.approvedSha256)) throw Error('An approved different revision cannot be replaced.');
      if (completedReceipt && !previous) throw Error('A completed approved recovery is missing; operator inspection required.');
      const drafts = await readdir(join(options.output, 'drafts', item.unit.id));
      if (drafts.some(name => name.endsWith('.json') && name !== `${item.row.beforeContentSha256}.json` && !(oldIntent && name === `${item.row.contentSha256}.json`))) throw Error('Another draft revision exists; do not recover an obsolete source.');
    }
    const hold = { schemaVersion: 1, reason: 'offline-native-recovery-requires-new-measured-quality-policy', automaticallyReleasable: false, scaleAuthorized: false };
    const oldHold = await readOptionalJson(join(options.output, 'native-recoveries', 'scale-hold.json'));
    if (oldHold && hashContent(oldHold) !== hashContent(hold)) throw Error('Existing recovery scale hold differs.');
    if (options.write) {
      if (hashContent(await stopped(options)) !== hashContent(config) || hashContent(await readJson(join(options.output, 'ledger.json'))) !== hashContent(ledger)
        || hashContent(await readJson(join(options.output, 'store.json'))) !== hashContent(state)) throw Error('Stopped baseline changed before recovery.');
      // Durable authority and a permanent scale hold precede every new draft/approval.
      await immutable(join(directory, 'authority.json'), { proposal, review, rootApproval });
      await immutable(join(directory, 'source-evidence.json'), Object.fromEntries(evidence));
      await immutable(join(directory, 'intent.json'), intent);
      await immutable(join(options.output, 'native-recoveries', 'scale-hold.json'), hold);
      for (const item of plan.rows) {
        await immutable(join(options.output, 'drafts', item.unit.id, `${item.row.contentSha256}.json`), { unit: item.unit, contentSha256: item.row.contentSha256 });
        await immutable(join(options.output, 'reviews', item.unit.id, `${item.row.contentSha256}.json`), item.receipt);
        await immutable(join(options.output, 'approved', `${item.unit.id}.json`), item.approved);
      }
      await immutable(join(directory, 'receipt.json'), { ...intent, completed: true });
    }
    return { mode: options.write ? 'written-private-only' : 'dry-run', proposalId: plan.proposal.id, approvedUnits: plan.rows.length,
      replayed: Boolean(oldIntent), paidCalls: 0, scaleAuthorized: false, proposalSha256: plan.proposalSha256, reviewSha256: plan.reviewSha256 };
  });
}
