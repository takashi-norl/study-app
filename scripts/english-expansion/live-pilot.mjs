import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyIntegration } from './activation.mjs';
import { createAnthropicAdapter, PRICING_POLICY_SHA256, quoteInput } from './anthropic-adapter.mjs';
import { TARGET_ALLOCATION } from './allocation.mjs';
import { reserveExpansionRequest } from './budget.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { checkedVersionedWork, parseVersionedGeneration, parseVersionedReview } from './work-versions.mjs';
import { assertOnlyTestsChanged, assertSingleRepairDispatch, inspectRepairEvidence, assertRepairAwareReview } from './pilot-repair.mjs';
import { assertEditorialAuthorityPresent, assertEditorialAwareReview } from './pilot-editorial.mjs';
import { classifyCandidates } from './registry.mjs';
import { hashContent } from './schema.mjs';
import { initializeStore, persistDraft, persistLedger, persistPhaseOneHandoff, persistRawResponse, persistRepairRevision, persistRequest, persistReviewResult, persistWork, publishReviewedUnit, readJson, readOptionalJson, registerPilotSeeds, withExpansionLock } from './store.mjs';

function checkedWork(work) {
  const expected = checkedVersionedWork(work);
  boundedRequest({ ...work, reservedUsd: 1 }); // Identity, bounds and credential-free params.
  return expected;
}
async function finishSaved(lease, request, work, raw, adapter) {
  if (raw.requestId !== request.id || raw.requestHash !== request.requestHash) throw new Error('Saved raw response is bound to different provider inputs.');
  const ledger = await readJson(join(lease.output, 'ledger.json')), call = ledger.calls.find(row => row.id === request.id);
  if (!call || call.requestHash !== request.requestHash) throw new Error('Raw result has no matching immutable reservation.');
  const responseHash = hashContent(raw.response);
  if (call.status === 'complete' && call.responseHash !== responseHash) throw new Error('Completed provider evidence changed; no reuse or retry.');
  if (call.status !== 'complete') {
    let actualUsd;
    try { actualUsd = adapter.price(raw.response); if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error(); }
    catch { call.status = 'uncertain'; call.errorKind = 'unpriced-saved-response'; await persistLedger(lease, ledger); throw new Error('Raw response is saved; billing is unresolved. No automatic retry.'); }
    Object.assign(call, { status: 'complete', actualUsd, responseHash, completedAt: new Date().toISOString() });
    if (actualUsd > call.reservedUsd + 1e-9) call.accountingHold = 'charge-exceeded-reservation';
    await persistLedger(lease, ledger);
  }
  if (call.accountingHold || call.actualUsd > call.reservedUsd + 1e-9) throw new Error('Charge exceeded its reservation; operator accounting review is required.');
  // Validation failures keep all paid raw data and exact known cost. A new ID is
  // not a retry permission; revision/repair needs a separate reviewed workflow.
  if (work.stage === 'generation') {
    const units = parseVersionedGeneration(raw.response, work);
    if (work.kind === 'tests-only-repair') {
      for (const unit of units) assertOnlyTestsChanged(work.units.find(original => original.id === unit.id), unit);
      await persistRepairRevision(lease, request.id, { schemaVersion: 1, kind: 'tests-only-repair', requestId: request.id,
        sourceRequestId: work.repairPlan.sourceRequestId, planSha256: hashContent(work.repairPlan), rejectionSha256: hashContent(work.rejection),
        responseSha256: responseHash, savedAt: raw.savedAt,
        units: units.map(unit => ({ unitId: unit.id, beforeSha256: hashContent(work.units.find(original => original.id === unit.id)), afterSha256: hashContent(unit) })) });
    }
    for (const unit of units) await persistDraft(lease, unit);
    return { requestId: request.id, stage: work.stage, actualUsd: call.actualUsd, unitIds: units.map(unit => unit.id), state: 'drafts-awaiting-independent-review' };
  }
  const results = parseVersionedReview(raw.response, work, raw.savedAt);
  await persistReviewResult(lease, request.id, results.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })));
  for (const { unit, receipt } of results) if (receipt.approved) await publishReviewedUnit(lease, unit, receipt);
  return { requestId: request.id, stage: work.stage, actualUsd: call.actualUsd, approved: results.filter(row => row.receipt.approved).map(row => row.unit.id), held: results.filter(row => !row.receipt.approved).map(row => row.unit.id), state: 'pilot-cost-and-quality-review-required-before-scaling' };
}
async function pilotAction(options, adapterFactory) {
  const work = checkedWork(options.work);
  return withExpansionLock(options, async lease => {
    const approval = await verifyIntegration(options);
    const gateOptions = { phaseOneOutput: options.phaseOneOutput, runtimeDirectory: options.runtimeDirectory,
      cashPurchases: approval.cashPurchases, historicalCommitments: approval.historicalCommitments, canonicalAudit: approval.canonicalAudit }; // No caller override of 7,500.
    let gate = await inspectPhaseOneGate(lease, gateOptions);
    if (!gate.registry.canonicalAudit || gate.registry.canonicalAudit.canonicalLexemeCount !== 7500) throw new Error('Exactly 7,500 reviewed canonical base lexemes are required.');
    const state = await initializeStore(lease, { phaseOneFingerprint: gate.phaseOneFingerprint, allocationHash: hashContent(TARGET_ALLOCATION) });
    const candidates = classifyCandidates(gate.registry, approval.seeds);
    if (candidates.accepted.length !== approval.seeds.length) throw new Error('Reviewed pilot inventory overlaps base, retained assets or aliases.');
    if (state.pilot.seeds.some(seed => !approval.seeds.some(item => hashContent(item) === hashContent(seed)))) throw new Error('An activated pilot inventory cannot replace previously registered units.');
    const registered = await registerPilotSeeds(lease, approval.seeds);
    for (const id of work.unitIds) {
      const seed = registered.pilot.seeds.find(seed => seed.id === id);
      if (!seed) throw new Error('Work references an unregistered pilot seed.');
      if (work.stage === 'generation' && work.kind !== 'tests-only-repair' && hashContent(seed) !== hashContent(work.seeds.find(row => row.id === id))) throw new Error('Generation work changed its reviewed seed.');
    }
    if (work.stage === 'review') for (const unit of work.units) {
      const draft = await readJson(join(lease.output, 'drafts', unit.id, `${hashContent(unit)}.json`));
      if (draft.contentSha256 !== hashContent(unit) || hashContent(draft.unit) !== hashContent(unit)) throw new Error('Review must use the complete immutable saved draft.');
    }
    let ledger = await readJson(join(lease.output, 'ledger.json'));
    await assertEditorialAuthorityPresent(lease.output, approval.config.pilotEditorial);
    if (ledger.calls.some(call => call.repairOf || call.repairPlanSha256) && !approval.config.pilotRepair) throw new Error('Existing pilot repair authority cannot be omitted from later requests.');
    const prior = ledger.calls.find(call => call.id === work.id);
    if (work.stage === 'review' && approval.config.pilotEditorial) await assertEditorialAwareReview(lease.output, approval.config.pilotRepair, approval.config.pilotEditorial, work);
    const repair = work.kind === 'tests-only-repair' ? await inspectRepairEvidence(lease.output, approval.config.pilotRepair, work, { allowApprovedReplacement: Boolean(prior) }) : null;
    if (repair && !prior) assertSingleRepairDispatch(ledger, work, repair);
    const adapter = adapterFactory(); // No credentials/network constructed before actual completion gate.
    if (prior) {
      const savedWork = await readJson(join(lease.output, 'requests', work.id, 'work.json'));
      if (hashContent(savedWork.work) !== hashContent(work) || savedWork.quote.pricingPolicySha256 !== PRICING_POLICY_SHA256) throw new Error('Saved work or historical pricing policy changed; do not resend.');
      const request = { ...boundedRequest({ ...work, reservedUsd: savedWork.quote.reservedUsd }), ...(repair ? { repairOf: repair.plan.sourceRequestId, repairPlanSha256: repair.planSha256 } : {}) };
      if (request.requestHash !== prior.requestHash || request.reservedUsd !== prior.reservedUsd || request.repairOf !== prior.repairOf || request.repairPlanSha256 !== prior.repairPlanSha256) throw new Error('Existing request differs from saved work.');
      const raw = await readOptionalJson(join(lease.output, 'requests', work.id, 'response.json'));
      if (!raw) throw new Error('Existing request has no saved response. Outcome may be unknown; never resend automatically.');
      return { ...await finishSaved(lease, request, work, raw, adapter), replayed: true };
    }
    if (approval.config.pilotRepair && work.promptVersion !== 'v2') throw new Error('New requests require the reviewed v2 quality prompt; historical work can only replay saved raw.');
    if (work.stage === 'review' && approval.config.pilotRepair && !approval.config.pilotEditorial) await assertRepairAwareReview(lease.output, approval.config.pilotRepair, work, ledger);
    if (ledger.calls.some(call => call.accountingHold)) throw new Error('An accounting hold blocks further spending.');
    if (ledger.calls.length >= 10) throw new Error('Initial pilot is limited to ten total generation/review submissions.');
    if (!repair && ledger.calls.some(call => call.stage === work.stage && call.unitIds.some(id => work.unitIds.includes(id)))) throw new Error('These units already have a request for this stage. Reconcile saved evidence; a new ID is not retry permission.');
    // Read-only preflight follows the gate. Generation remains prohibited until
    // all reserve/request evidence has been fsynced and the gate rechecked.
    const quote = await adapter.quote(work.params), expectedQuote = quoteInput(work.params, quote.countedInputTokens);
    if (hashContent(quote) !== hashContent(expectedQuote)) throw new Error('Provider quote differs from the verified conservative pricing policy.');
    const request = { ...boundedRequest({ ...work, reservedUsd: quote.reservedUsd }), ...(repair ? { repairOf: repair.plan.sourceRequestId, repairPlanSha256: repair.planSha256 } : {}) };
    gate = await inspectPhaseOneGate(lease, gateOptions);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint) throw new Error('Frozen phase-one evidence changed before reservation.');
    const reserved = reserveExpansionRequest({ ...gate.snapshot, expansion: ledger }, request);
    await persistPhaseOneHandoff(lease, options.runtimeDirectory, { phaseTwoOutput: lease.output, phaseOneFingerprint: state.phaseOneFingerprint,
      integrationSha256: approval.configSha256, firstRequestId: request.id, createdAt: state.createdAt });
    await persistWork(lease, work, quote); await persistRequest(lease, request); await persistLedger(lease, reserved.ledger);
    const rechecked = await verifyIntegration(options);
    gate = await inspectPhaseOneGate(lease, gateOptions);
    if (rechecked.configSha256 !== approval.configSha256 || gate.phaseOneFingerprint !== state.phaseOneFingerprint) throw new Error('Reviewed spending configuration changed before submission. Reservation retained unsent.');
    ledger = await readJson(join(lease.output, 'ledger.json')); const call = ledger.calls.find(row => row.id === request.id);
    Object.assign(call, { status: 'requested', sentAt: new Date().toISOString() }); await persistLedger(lease, ledger);
    let response;
    try { response = await adapter.request(request.params); }
    catch { call.status = 'uncertain'; call.errorKind = 'provider-submit-outcome-unknown'; await persistLedger(lease, ledger); throw new Error('Provider outcome is unknown; reservation retained. No automatic retry.'); }
    const raw = await persistRawResponse(lease, request, response);
    return { ...await finishSaved(lease, request, work, raw, adapter), replayed: false };
  });
}
/** One explicit request only: never loops, purchases credits, generates audio or publishes to the app. */
export function dispatchPilotWork(options) { return pilotAction(options, () => createAnthropicAdapter()); }
/** Offline tests still exercise the identical on-disk integration, cost and completion gates. */
export function dispatchPilotWorkWithMockSdk(options, client) {
  if (!client?.testOnly || client.networkEnabled !== false) throw new Error('An explicitly network-disabled mock SDK is required.');
  return pilotAction(options, () => createAnthropicAdapter({ client }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), values = {}, names = { '--out': 'output', '--phase-one': 'phaseOneOutput', '--runtime': 'runtimeDirectory', '--work': 'workFile' };
  try {
    if (!args.includes('--send-reviewed-request')) throw new Error('No request sent. This CLI requires an installed independent integration receipt and --send-reviewed-request for one explicit work file.');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--send-reviewed-request') continue;
      const key = names[args[i]]; if (!key || values[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicated or incomplete CLI argument.');
      values[key] = args[++i];
    }
    if (Object.values(names).some(key => !values[key])) throw new Error('Explicit --out, --phase-one, --runtime and --work paths are required.');
    const work = await readJson(values.workFile);
    const result = await dispatchPilotWork({ ...values, work, sharedLockDirectory: join(values.runtimeDirectory, 'shared-spending.lock') });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    // Do not print SDK headers, keys, content, Zod input values or a stack trace.
    process.stderr.write(`Expansion stopped: ${error?.name === 'ZodError' ? 'Saved work failed schema validation; inspect the private evidence.' : error.message}\n`);
    process.exitCode = 1;
  }
}
