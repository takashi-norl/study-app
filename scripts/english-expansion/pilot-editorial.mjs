import { join } from 'node:path';
import { z } from 'zod';
import { boundedRequest } from './dispatcher.mjs';
import { assertOnlyTestsChanged, inspectRepairEvidence, validateRepairAuthority } from './pilot-repair.mjs';
import { hashContent, validateUnit } from './schema.mjs';
import { assertLease, persistDraft, persistEditorialEvidence, readJson, readOptionalJson } from './store.mjs';
import { checkedVersionedWork, parseVersionedGeneration } from './work-versions.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1), id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const row = z.object({ unitId: id, contentSha256: hash }).strict();
const path = z.string().regex(/^\/senses\/[0-5]\/tests\/[0-3]\/(?:prompt|explanationJa|correctIndex|choices\/[0-3]\/(?:text|meaningJa|feedbackJa)|alternatives\/[0-7]\/(?:text|meaningJa|noteJa))$/);
const value = z.union([text, z.number().int().min(0).max(3)]);
export const editorialProposalSchema = z.object({ schemaVersion: z.literal(1), id, kind: z.literal('pilot-tests-only-editorial-overlay'), createdBy: text, createdAt: z.string().datetime(),
  sourceRequestId: id, sourceWorkSha256: hash, sourceRawSha256: hash, sourceRevisionSha256: hash, sourceReviewSha256: hash,
  sourceContentHashes: z.array(row).min(1).max(5), patches: z.array(z.object({ unitId: id, beforeContentSha256: hash, afterContentSha256: hash,
    changes: z.array(z.object({ path, before: value, after: value }).strict()).min(1).max(40) }).strict()).min(1).max(5) }).strict();
const sourceReviewSchema = z.object({ schemaVersion: z.literal(1), sourceRequestId: id, workSha256: hash, rawSha256: hash, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(row.extend({ approved: z.boolean(), issues: z.array(text).max(20) }).strict()).min(1).max(5) }).strict();
const reviewSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: hash, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(z.object({ unitId: id, afterContentSha256: hash, approved: z.literal(true), issues: z.array(text).length(0) }).strict()).min(1).max(5) }).strict();
const rootSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: hash, reviewSha256: hash, reviewedBy: z.literal('/root'), reviewedAt: z.string().datetime(), approved: z.literal(true), issues: z.array(text).length(0) }).strict();
export function validateEditorialAuthority(authority, repairAuthority) {
  const proposal = editorialProposalSchema.parse(authority?.proposal), sourceReview = sourceReviewSchema.parse(authority?.sourceReview), review = reviewSchema.parse(authority?.review), rootApproval = rootSchema.parse(authority?.rootApproval);
  const repair = validateRepairAuthority(repairAuthority), proposalSha256 = hashContent(proposal);
  const sources = new Map(proposal.sourceContentHashes.map(item => [item.unitId, item.contentSha256])), patches = new Map(proposal.patches.map(item => [item.unitId, item]));
  if (proposal.sourceRequestId !== repair.plan.repairWorkId || proposal.sourceContentHashes.length !== repair.plan.unitContentHashes.length
    || repair.plan.unitContentHashes.some(item => !sources.has(item.unitId)) || sources.size !== proposal.sourceContentHashes.length || patches.size !== proposal.patches.length
    || proposal.sourceReviewSha256 !== hashContent(sourceReview) || sourceReview.sourceRequestId !== proposal.sourceRequestId || sourceReview.workSha256 !== proposal.sourceWorkSha256 || sourceReview.rawSha256 !== proposal.sourceRawSha256
    || sourceReview.verdicts.length !== sources.size || new Set(sourceReview.verdicts.map(item => item.unitId)).size !== sources.size
    || sourceReview.verdicts.some(item => sources.get(item.unitId) !== item.contentSha256 || (item.approved ? item.issues.length !== 0 || patches.has(item.unitId) : !item.issues.length || !patches.has(item.unitId)))
    || proposal.patches.some(item => sources.get(item.unitId) !== item.beforeContentSha256 || item.beforeContentSha256 === item.afterContentSha256 || new Set(item.changes.map(change => change.path)).size !== item.changes.length)
    || review.reviewedBy === proposal.createdBy || review.proposalSha256 !== proposalSha256 || review.verdicts.length !== patches.size || new Set(review.verdicts.map(item => item.unitId)).size !== patches.size
    || review.verdicts.some(item => patches.get(item.unitId)?.afterContentSha256 !== item.afterContentSha256)
    || rootApproval.proposalSha256 !== proposalSha256 || rootApproval.reviewSha256 !== hashContent(review)) throw new Error('Editorial overlay requires exact held-source evidence, independent patch approval and root-bound authority.');
  return { proposal, sourceReview, review, rootApproval, proposalSha256 };
}
export function applyEditorialPatches(units, authority, repairAuthority) {
  const checked = validateEditorialAuthority(authority, repairAuthority), { proposal, sourceReview, review } = checked;
  if (hashContent(units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit) }))) !== hashContent(proposal.sourceContentHashes)
    || units.some(unit => sourceReview.reviewedBy === unit.provenance.author || review.reviewedBy === unit.provenance.author)) throw new Error('Editorial source cards differ or their approval is not independent.');
  const finalUnits = units.map(unit => {
    const patch = proposal.patches.find(item => item.unitId === unit.id); if (!patch) return unit;
    const changed = structuredClone(unit);
    for (const change of patch.changes) {
      const parts = change.path.slice(1).split('/'), leaf = parts.pop(); let target = changed;
      for (const key of parts) { if (!target || !Object.hasOwn(target, key)) throw new Error('Editorial path must name an existing tests leaf.'); target = target[key]; }
      if (!target || !Object.hasOwn(target, leaf) || hashContent(target[leaf]) !== hashContent(change.before) || typeof change.before !== typeof change.after || hashContent(change.before) === hashContent(change.after)
        || (leaf === 'correctIndex' ? typeof change.after !== 'number' : typeof change.after !== 'string')) throw new Error('Editorial before value, leaf type or change differs from the approved patch.');
      target[leaf] = change.after;
    }
    const validated = validateUnit(changed); assertOnlyTestsChanged(unit, validated);
    if (hashContent(validated) !== patch.afterContentSha256) throw new Error('Editorial final full-card hash differs from independent approval.');
    return validated;
  });
  return { ...checked, units: finalUnits };
}
export const editorialMarkerPath = output => join(output, 'editorial-overlays', 'active.json');
export async function assertEditorialAuthorityPresent(output, authority) {
  const active = await readOptionalJson(editorialMarkerPath(output));
  if (active && (!authority || active.authoritySha256 !== hashContent(authority))) throw new Error('A recorded editorial overlay cannot be omitted or replaced.');
  return active;
}
export async function inspectEditorialOverlay(output, repairAuthority, authority, { requirePersisted = true } = {}) {
  const checked = validateEditorialAuthority(authority, repairAuthority), { proposal } = checked;
  const ledger = await readJson(join(output, 'ledger.json')), call = ledger.calls.find(item => item.id === proposal.sourceRequestId);
  if (!call || call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd) || call.actualUsd < 0 || call.actualUsd > call.reservedUsd + 1e-9) throw new Error('Editorial source must be a settled known repair result.');
  const work = (await readJson(join(output, 'requests', call.id, 'work.json'))).work;
  checkedVersionedWork(work);
  const raw = await readJson(join(output, 'requests', call.id, 'response.json'));
  const repaired = await inspectRepairEvidence(output, repairAuthority, work, { allowApprovedReplacement: true });
  if (work.kind !== 'tests-only-repair' || call.repairOf !== repaired.plan.sourceRequestId || call.repairPlanSha256 !== repaired.planSha256
    || hashContent(work) !== proposal.sourceWorkSha256 || hashContent(raw) !== proposal.sourceRawSha256 || raw.requestId !== call.id || raw.requestHash !== call.requestHash
    || hashContent(raw.response) !== call.responseHash || boundedRequest({ ...work, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw new Error('Editorial source work, raw result or spending lineage changed.');
  const units = parseVersionedGeneration(raw.response, work), revision = await readJson(join(output, 'requests', call.id, 'repair-revision.json'));
  const expectedRevision = { schemaVersion: 1, kind: 'tests-only-repair', requestId: work.id, sourceRequestId: repaired.plan.sourceRequestId, planSha256: repaired.planSha256,
    rejectionSha256: hashContent(repaired.rejection), responseSha256: hashContent(raw.response), savedAt: raw.savedAt,
    units: units.map(unit => ({ unitId: unit.id, beforeSha256: hashContent(work.units.find(original => original.id === unit.id)), afterSha256: hashContent(unit) })) };
  if (hashContent(revision) !== proposal.sourceRevisionSha256 || hashContent(revision) !== hashContent(expectedRevision)) throw new Error('Editorial repair revision evidence changed.');
  for (const unit of units) {
    const draft = await readJson(join(output, 'drafts', unit.id, `${hashContent(unit)}.json`));
    if (draft.contentSha256 !== hashContent(unit) || hashContent(draft.unit) !== hashContent(unit)) throw new Error('Editorial source requires its immutable repaired draft.');
  }
  const result = applyEditorialPatches(units, authority, repairAuthority);
  const record = { schemaVersion: 1, kind: proposal.kind, id: proposal.id, authoritySha256: hashContent(authority), sourceRequestId: proposal.sourceRequestId,
    sourceRawSha256: proposal.sourceRawSha256, sourceRevisionSha256: proposal.sourceRevisionSha256, sourceReviewSha256: proposal.sourceReviewSha256,
    units: result.units.map(unit => ({ unitId: unit.id, beforeContentSha256: hashContent(units.find(original => original.id === unit.id)), afterContentSha256: hashContent(unit) })) };
  const active = await assertEditorialAuthorityPresent(output, authority);
  if (active && hashContent(active) !== hashContent(record)) throw new Error('Recorded editorial revision differs from exact final cards.');
  if (requirePersisted) {
    if (!active) throw new Error('Editorial overlay has not been durably applied.');
    const directory = join(output, 'editorial-overlays', proposal.id);
    if (hashContent(await readJson(join(directory, 'authority.json'))) !== hashContent(authority) || hashContent(await readJson(join(directory, 'revision.json'))) !== hashContent(record)) throw new Error('Editorial immutable authority or revision changed.');
    for (const unit of result.units) {
      const draft = await readJson(join(output, 'drafts', unit.id, `${hashContent(unit)}.json`));
      if (draft.contentSha256 !== hashContent(unit) || hashContent(draft.unit) !== hashContent(unit)) throw new Error('Editorial final draft differs from its approved hash.');
    }
  }
  return { ...result, record, originalUnits: units, ledger };
}
export async function applyEditorialOverlay(lease, repairAuthority, authority) {
  await assertLease(lease, lease.output);
  const result = await inspectEditorialOverlay(lease.output, repairAuthority, authority, { requirePersisted: false });
  if (result.ledger.calls.some(call => call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd))) throw new Error('Apply editorial changes only at a settled request boundary.');
  const active = await readOptionalJson(editorialMarkerPath(lease.output));
  if (!active) for (const unit of result.units) {
    if (result.ledger.calls.some(call => call.stage === 'review' && call.unitIds?.includes(unit.id)) || await readOptionalJson(join(lease.output, 'approved', `${unit.id}.json`))) throw new Error('Editorial overlay cannot replace an already reviewed or approved card.');
  }
  // Evidence and one immutable active intent precede drafts. A crash may resume
  // this exact overlay only; it never authorizes another paid call or revision.
  await persistEditorialEvidence(lease, authority, result.record);
  for (const unit of result.units) await persistDraft(lease, unit);
  return result.record;
}
export async function assertEditorialAwareReview(output, repairAuthority, authority, work) {
  const result = await inspectEditorialOverlay(output, repairAuthority, authority), expected = new Map(result.units.map(unit => [unit.id, unit]));
  for (const unit of work.units) if (expected.has(unit.id) && hashContent(expected.get(unit.id)) !== hashContent(unit)) throw new Error('Final review must use the exact editorial final card.');
}
