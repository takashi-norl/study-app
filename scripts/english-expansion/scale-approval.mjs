import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPO_ROOT, sha256File, verifyIntegration } from './activation.mjs';
import { BATCH_POLICY_SHA256 } from './batch-provider.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { checkedVersionedWork, parseVersionedGeneration, parseVersionedReview } from './work-versions.mjs';
import { assertOnlyTestsChanged, inspectRepairEvidence } from './pilot-repair.mjs';
import { approveUnit, hashContent } from './schema.mjs';
import { readJson, readOptionalJson } from './store.mjs';

export const SCALE_POLICY = Object.freeze({ schemaVersion: 1, scope: 'reviewed-text-batch-expansion',
  maxAdditionalUnits: 12480, maxRequestsPerWave: 40, maxUnitsPerRequest: 5,
  oneOutstandingWave: true, reviewBeforeGeneration: true, textOnly: true,
  noAutomaticRetry: true, maxCycles: 1440, pollSeconds: 60,
  forecastSafetyMultiplier: 1.5, minimumReviewReserveUsdPerRequest: 0.09,
  minPilotApprovedUnits: 18, maxScaleHeldFraction: 0.10 });
export const SCALE_POLICY_SHA256 = hashContent(SCALE_POLICY);
export function scaleFiles() {
  return ['batch-provider', 'scale-store', 'scale-approval', 'scale-worker'].map(name => ({
    id: `scripts/english-expansion/${name}.mjs`, path: join(REPO_ROOT, 'scripts/english-expansion', `${name}.mjs`),
  }));
}

/** Stable after scale requests are appended: only the exact twenty pilot IDs enter this snapshot. */
export async function measuredPilotSnapshot(output, reviewedSeeds, repairAuthority) {
  const store = await readJson(join(output, 'store.json')), ledger = await readJson(join(output, 'ledger.json'));
  const seeds = store?.pilot?.seeds;
  if (store.pilot?.maxUnits !== 20 || !Array.isArray(seeds) || seeds.length !== 20 || new Set(seeds.map(seed => seed.id)).size !== 20
    || hashContent(seeds) !== hashContent(reviewedSeeds)) throw new Error('Scaling requires all twenty exact reviewed pilot seeds.');
  const ids = new Set(seeds.map(seed => seed.id)), calls = ledger.calls.filter(call => call.unitIds?.some(id => ids.has(id)));
  if (!calls.length || calls.length > 10 || calls.some(call => call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd)
    || call.actualUsd < 0 || call.actualUsd > call.reservedUsd + 1e-9 || call.unitIds.some(id => !ids.has(id)))) throw new Error('All pilot spending must be known, settled and within its reservation.');
  const reviewedIds = calls.filter(call => call.stage === 'review').flatMap(call => call.unitIds);
  if (reviewedIds.length !== 20 || new Set(reviewedIds).size !== 20) throw new Error('Every pilot item requires exactly one final independent review outcome.');
  const generated = new Map(), verdicts = new Map(), generationLineage = [], repairCalls = calls.filter(call => call.repairOf || call.repairPlanSha256);
  if (repairCalls.length > 1) throw new Error('Pilot has more than one authorized repair.');
  for (const call of calls.filter(call => call.stage === 'generation').concat(calls.filter(call => call.stage === 'review'))) {
    const raw = await readJson(join(output, 'requests', call.id, 'response.json'));
    if (raw.requestId !== call.id || raw.requestHash !== call.requestHash || hashContent(raw.response) !== call.responseHash) throw new Error('Pilot cost lacks its exact saved provider response.');
    const { work } = await readJson(join(output, 'requests', call.id, 'work.json'));
    checkedVersionedWork(work);
    if (work.id !== call.id || work.stage !== call.stage || hashContent(work.unitIds) !== hashContent(call.unitIds)
      || boundedRequest({ ...work, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw new Error('Pilot content work differs from saved request inputs.');
    if (call.stage === 'generation') {
      const parsed = parseVersionedGeneration(raw.response, work);
      if (work.kind === 'tests-only-repair') {
        const evidence = await inspectRepairEvidence(output, repairAuthority, work, { allowApprovedReplacement: true });
        if (call.repairOf !== evidence.plan.sourceRequestId || call.repairPlanSha256 !== evidence.planSha256 || repairCalls.length !== 1) throw new Error('Repair cost lacks its exact source lineage.');
        const revision = { schemaVersion: 1, kind: 'tests-only-repair', requestId: work.id,
          sourceRequestId: evidence.plan.sourceRequestId, planSha256: evidence.planSha256, rejectionSha256: hashContent(evidence.rejection),
          responseSha256: hashContent(raw.response), savedAt: raw.savedAt,
          units: parsed.map(unit => ({ unitId: unit.id, beforeSha256: hashContent(work.units.find(original => original.id === unit.id)), afterSha256: hashContent(unit) })) };
        if (hashContent(await readJson(join(output, 'requests', call.id, 'repair-revision.json'))) !== hashContent(revision)) throw new Error('Repair revision evidence changed.');
        for (const unit of parsed) {
          const original = work.units.find(row => row.id === unit.id);
          if (hashContent(generated.get(unit.id)) !== hashContent(original)) throw new Error('Repair replaces a different or missing original draft.');
          assertOnlyTestsChanged(original, unit); generated.set(unit.id, unit);
        }
        generationLineage.push(revision);
      } else {
        if (call.repairOf || call.repairPlanSha256) throw new Error('Ordinary generation cannot claim repair permission.');
        for (const unit of parsed) { if (generated.has(unit.id)) throw new Error('Duplicate generation has no authorized repair chain.'); generated.set(unit.id, unit); }
      }
    } else {
      if (call.repairOf || call.repairPlanSha256) throw new Error('Review cannot claim generation repair permission.');
      const decoded = parseVersionedReview(raw.response, work, raw.savedAt);
      for (const { unit, receipt } of decoded) {
        if (hashContent(generated.get(unit.id)) !== hashContent(unit)) throw new Error('Pilot reviewed a different generated draft.');
        verdicts.set(unit.id, receipt);
      }
      const saved = await readJson(join(output, 'requests', call.id, 'review-result.json'));
      if (hashContent(saved) !== hashContent(decoded.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })))) throw new Error('Pilot independent review evidence changed.');
    }
  }
  if (generated.size !== 20 || (repairAuthority && generationLineage.length !== 1)) throw new Error('Every pilot item needs a final generated draft and any required repair.');
  const units = []; let approvedUnits = 0;
  for (const seed of seeds) {
    const unit = generated.get(seed.id), review = verdicts.get(seed.id), approved = await readOptionalJson(join(output, 'approved', `${seed.id}.json`));
    if (!unit || !review || Object.keys(seed).some(key => hashContent(unit[key]) !== hashContent(seed[key]))) throw new Error('Pilot draft or reviewed inventory changed.');
    if (review.approved) {
      if (!approved || hashContent(approveUnit(unit, review)) !== hashContent(approved)) throw new Error('Pilot approval differs from exact reviewed draft.');
      approvedUnits++;
    } else if (approved) throw new Error('A held pilot card must not be published.');
    units.push({ id: seed.id, contentSha256: hashContent(unit), reviewSha256: hashContent(review), approved: review.approved, issues: review.issues });
  }
  if (approvedUnits < SCALE_POLICY.minPilotApprovedUnits) throw new Error('Fewer than eighteen pilot cards passed independent review; resolve quality before scaling.');
  const actualUsd = Math.round(calls.reduce((sum, call) => sum + call.actualUsd, 0) * 1e9) / 1e9;
  if (!(actualUsd > 0)) throw new Error('A measured nonzero pilot cost is required; forecasts cannot substitute for actual usage.');
  return { schemaVersion: 1, phaseOneFingerprint: store.phaseOneFingerprint, seedsSha256: hashContent(seeds),
    units, generationLineage, callsSha256: hashContent(calls), actualUsd, reviewedUnits: 20, approvedUnits, heldUnits: 20 - approvedUnits };
}

/** Never creates/enables receipts. A root review of observed pilot quality and cost is mandatory. */
export async function verifyScaleApproval(options) {
  const integration = await verifyIntegration(options);
  let receipt;
  try { receipt = await readJson(join(options.runtimeDirectory, 'shared-spending-scale.json')); }
  catch { throw new Error('Batch scaling remains disabled: measured-pilot approval receipt is missing.'); }
  if (receipt.schemaVersion !== 1 || receipt.enabled !== true || receipt.scope !== SCALE_POLICY.scope || receipt.reviewedBy !== '/root'
    || !Number.isFinite(Date.parse(receipt.reviewedAt)) || receipt.approved !== true || !Array.isArray(receipt.issues) || receipt.issues.length
    || receipt.integrationSha256 !== integration.configSha256 || receipt.policySha256 !== SCALE_POLICY_SHA256
    || receipt.batchPolicySha256 !== BATCH_POLICY_SHA256 || !Number.isInteger(receipt.maxAdditionalUnits)
    || receipt.maxAdditionalUnits < 1 || receipt.maxAdditionalUnits > SCALE_POLICY.maxAdditionalUnits
    || receipt.budgetBoundedTarget !== true || receipt.textOnly !== true) throw new Error('Scale approval exceeds its policy or lacks independent measured-pilot acceptance.');
  const files = scaleFiles();
  if (!Array.isArray(receipt.files) || receipt.files.length !== files.length || new Set(receipt.files.map(file => file.id)).size !== files.length) throw new Error('All batch spending modules require exact review hashes.');
  for (const file of files) if (await realpath(file.path) !== resolve(file.path) || receipt.files.find(row => row.id === file.id)?.sha256 !== await sha256File(file.path)) throw new Error('Batch module changed; scale approval is stale.');
  const pilot = await measuredPilotSnapshot(options.output, integration.seeds, integration.config.pilotRepair);
  if (receipt.pilotSnapshotSha256 !== hashContent(pilot) || receipt.measuredPilotUsd !== pilot.actualUsd || receipt.pilotApprovedUnits !== pilot.approvedUnits) throw new Error('Measured pilot evidence differs from the root quality/cost review.');
  return { ...integration, receipt, approvalSha256: hashContent(receipt), pilot };
}

export function forecastFromPilot(pilot, remainingUsd) {
  if (!(pilot?.actualUsd > 0) || !Number.isInteger(pilot.approvedUnits) || pilot.approvedUnits < 18 || pilot.approvedUnits > 20 || !Number.isFinite(remainingUsd)) throw new Error('A measured pilot with eighteen or more approvals and remaining budget is required.');
  const estimatedUsdPerApprovedUnit = pilot.actualUsd / pilot.approvedUnits * 0.5 * SCALE_POLICY.forecastSafetyMultiplier;
  return { estimatedUsdPerApprovedUnit, estimatedAffordableUnits: Math.max(0, Math.floor(remainingUsd / estimatedUsdPerApprovedUnit)),
    isGuarantee: false, note: 'Same-model Batch discount estimate with 50% headroom; independent review rejection, longer phrases and future pricing can reduce coverage.' };
}
