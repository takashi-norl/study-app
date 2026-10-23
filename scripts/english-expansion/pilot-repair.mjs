import { join } from 'node:path';
import { z } from 'zod';
import { boundedRequest } from './dispatcher.mjs';
import { hashContent } from './schema.mjs';
import { readJson, readOptionalJson } from './store.mjs';
import { checkedVersionedWork, parseVersionedGeneration } from './work-versions.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/), text = z.string().trim().min(1);
const contentRow = z.object({ unitId: text, contentSha256: hash }).strict();
export const repairPlanSchema = z.object({ schemaVersion: z.literal(1), id, kind: z.literal('pilot-tests-only-repair'), createdBy: text, createdAt: z.string().datetime(),
  sourceRequestId: id, sourceRequestHash: hash, workSha256: hash, rawSha256: hash, rejectionSha256: hash,
  unitContentHashes: z.array(contentRow).min(1).max(5), repairWorkId: id, promptVersion: z.literal('v2'),
  allowedModes: z.array(z.enum(['meaning', 'word', 'context', 'usage'])).length(4), maxRepairRequests: z.literal(1), preserveNonTestFields: z.literal(true) }).strict();
const rejectionSchema = z.object({ schemaVersion: z.literal(1), sourceRequestId: id, workSha256: hash, rawSha256: hash, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(contentRow.extend({ approved: z.literal(false), issues: z.array(text).min(1).max(12) }).strict()).min(1).max(5) }).strict();
const approvalSchema = z.object({ schemaVersion: z.literal(1), sourceSha256: hash, reviewedBy: z.literal('/root'), reviewedAt: z.string().datetime(), approved: z.literal(true), issues: z.array(text).length(0) }).strict();
export function validateRepairAuthority(authority) {
  const plan = repairPlanSchema.parse(authority?.plan), rejection = rejectionSchema.parse(authority?.rejection), review = approvalSchema.parse(authority?.review);
  if (plan.repairWorkId === plan.sourceRequestId || new Set(plan.allowedModes).size !== 4 || new Set(plan.unitContentHashes.map(row => row.unitId)).size !== plan.unitContentHashes.length
    || review.sourceSha256 !== hashContent(plan) || plan.rejectionSha256 !== hashContent(rejection)
    || rejection.sourceRequestId !== plan.sourceRequestId || rejection.workSha256 !== plan.workSha256 || rejection.rawSha256 !== plan.rawSha256
    || rejection.verdicts.length !== plan.unitContentHashes.length || new Set(rejection.verdicts.map(row => row.unitId)).size !== rejection.verdicts.length
    || rejection.verdicts.some(row => plan.unitContentHashes.find(item => item.unitId === row.unitId)?.contentSha256 !== row.contentSha256)) throw new Error('Tests-only repair lacks exact independent rejection and root-bounded authorization.');
  return { plan, rejection, review, planSha256: hashContent(plan) };
}
export async function inspectRepairEvidence(output, authority, repairWork, { allowApprovedReplacement = false } = {}) {
  const checked = validateRepairAuthority(authority), { plan, rejection } = checked;
  const originalWork = (await readJson(join(output, 'requests', plan.sourceRequestId, 'work.json'))).work;
  checkedVersionedWork(originalWork);
  const raw = await readJson(join(output, 'requests', plan.sourceRequestId, 'response.json'));
  const ledger = await readJson(join(output, 'ledger.json')), call = ledger.calls.find(row => row.id === plan.sourceRequestId);
  if (!call || call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd) || call.actualUsd < 0 || call.actualUsd > call.reservedUsd + 1e-9 || call.stage !== 'generation' || originalWork.kind === 'tests-only-repair'
    || originalWork.id !== plan.sourceRequestId || hashContent(originalWork) !== plan.workSha256 || hashContent(raw) !== plan.rawSha256
    || raw.requestId !== plan.sourceRequestId || raw.requestHash !== plan.sourceRequestHash || call.requestHash !== plan.sourceRequestHash
    || hashContent(raw.response) !== call.responseHash || boundedRequest({ ...originalWork, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw new Error('Repair can only reuse an exact known, paid generation result; unknown outcomes cannot be repaired/retried.');
  const units = parseVersionedGeneration(raw.response, originalWork);
  if (hashContent(units.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit) }))) !== hashContent(plan.unitContentHashes)
    || units.some(unit => rejection.reviewedBy === unit.provenance.author)) throw new Error('Repair plan or independent rejection differs from exact original full cards.');
  for (const unit of units) {
    const draft = await readJson(join(output, 'drafts', unit.id, `${hashContent(unit)}.json`));
    if (draft.contentSha256 !== hashContent(unit) || hashContent(draft.unit) !== hashContent(unit)) throw new Error('Repair requires the immutable original saved draft.');
    if (!allowApprovedReplacement && await readOptionalJson(join(output, 'approved', `${unit.id}.json`))) throw new Error('Repair cannot replace already approved pilot content.');
  }
  if (repairWork && (repairWork.kind !== 'tests-only-repair' || repairWork.id !== plan.repairWorkId || hashContent(repairWork.repairPlan) !== hashContent(plan)
    || hashContent(repairWork.rejection) !== hashContent(rejection) || hashContent(repairWork.units) !== hashContent(units))) throw new Error('Repair work differs from its exact authorized source.');
  return { ...checked, units, originalWork, raw, call };
}
export function assertSingleRepairDispatch(ledger, work, evidence) {
  if (work.id !== evidence.plan.repairWorkId || work.kind !== 'tests-only-repair') throw new Error('Explicit tests-only repair work required.');
  const targetIds = new Set(work.unitIds);
  for (const call of ledger.calls) {
    if (call.id === work.id) continue; // Same ID may only replay an already saved result.
    if (call.repairOf || call.repairPlanSha256) throw new Error('Pilot permits only the one explicitly authorized repair request.');
    if (call.unitIds?.some(unitId => targetIds.has(unitId)) && call.id !== evidence.plan.sourceRequestId) throw new Error('These pilot cards already have another generation/review request; do not replace or retry them.');
  }
}
export function assertOnlyTestsChanged(original, repaired) {
  const withoutTests = unit => ({ ...unit, senses: unit.senses.map(({ tests: _tests, ...sense }) => sense) });
  if (hashContent(withoutTests(original)) !== hashContent(withoutTests(repaired))) throw new Error('Repair changed protected seed, meaning, example, relation or provenance fields.');
}

/** A rejected original draft cannot bypass its required repair through another review ID. */
export async function assertRepairAwareReview(output, authority, work, ledger) {
  const { plan, planSha256 } = validateRepairAuthority(authority);
  if (!work.units.some(unit => plan.unitContentHashes.some(row => row.unitId === unit.id))) return;
  const call = ledger.calls.find(row => row.id === plan.repairWorkId);
  if (!call || call.status !== 'complete' || call.accountingHold || call.repairOf !== plan.sourceRequestId || call.repairPlanSha256 !== planSha256) throw new Error('Final review must wait for the exact authorized repair result.');
  const savedWork = (await readJson(join(output, 'requests', call.id, 'work.json'))).work;
  const raw = await readJson(join(output, 'requests', call.id, 'response.json'));
  await inspectRepairEvidence(output, authority, savedWork, { allowApprovedReplacement: true });
  if (raw.requestId !== call.id || raw.requestHash !== call.requestHash || hashContent(raw.response) !== call.responseHash
    || boundedRequest({ ...savedWork, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw new Error('Repair result differs from its immutable request.');
  const repaired = new Map(parseVersionedGeneration(raw.response, savedWork).map(unit => [unit.id, unit]));
  for (const unit of work.units) if (repaired.has(unit.id) && hashContent(repaired.get(unit.id)) !== hashContent(unit)) throw new Error('Final review must use the repaired card, never the rejected original.');
}
