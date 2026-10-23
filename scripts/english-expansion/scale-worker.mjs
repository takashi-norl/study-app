import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessSharedBudget, reserveExpansionRequest } from './budget.mjs';
import { BATCH_POLICY_SHA256, createBatchAdapter, quoteBatchInput, validateBatchRequests } from './batch-provider.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { checkedVersionedWork, newGenerationWork as generationWork, newReviewWork as reviewWork, parseVersionedGeneration as parseGenerated, parseVersionedReview as parseReviewed } from './work-versions.mjs';
import { hashContent } from './schema.mjs';
import { forecastFromPilot, SCALE_POLICY, verifyScaleApproval } from './scale-approval.mjs';
import { importScaleInventory, initializeScaleState, registerScaleWave, safeScaleId, saveScaleApproval, saveScaleDraft, scaleJson, scaleNames } from './scale-store.mjs';
import { persistLedger, persistRequest, persistReviewResult, persistWork, readJson, readOptionalJson, withExpansionLock } from './store.mjs';

const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const wavePath = (id, suffix) => `scale/waves/${safeScaleId(id)}/${suffix}`;
const compactError = error => error?.name === 'ZodError' ? 'schema-validation-failed' : 'saved-content-validation-failed';
const providerId = id => { if (!/^msgbatch_[a-zA-Z0-9]+$/.test(id ?? '')) throw new Error('Saved provider batch identity is missing; submission outcome is unknown.'); return id; };
const chunks = (items, size = 5) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

function checkedWork(work) {
  if (work?.kind) throw new Error('Batch scaling cannot authorize pilot repairs.');
  const expected = checkedVersionedWork(work);
  safeScaleId(work.id); return expected;
}
async function savedWave(lease, state, id) {
  const plan = await readJson(join(lease.output, wavePath(id, 'plan.json')));
  if (plan.schemaVersion !== 1 || plan.id !== id || plan.approvalSha256 !== state.approvalSha256 || plan.batchPolicySha256 !== BATCH_POLICY_SHA256
    || !['generation', 'review'].includes(plan.stage) || !Array.isArray(plan.requests) || !plan.requests.length || plan.requests.length > 40
    || new Set(plan.requests.map(row => row.id)).size !== plan.requests.length) throw new Error('Invalid saved wave evidence.');
  return plan;
}
async function savedRequest(lease, plan, row) {
  const { work, quote } = await readJson(join(lease.output, 'requests', safeScaleId(row.id), 'work.json'));
  checkedWork(work);
  const request = await readJson(join(lease.output, 'requests', row.id, 'request.json'));
  // Quote timestamps are policy-bound; no historical reservation is repriced on replay.
  if (quote.batchPolicySha256 !== BATCH_POLICY_SHA256 || hashContent(work) !== row.workSha256 || work.stage !== plan.stage
    || hashContent(boundedRequest({ ...work, reservedUsd: quote.reservedUsd })) !== hashContent(request)
    || request.requestHash !== row.requestHash || quote.paramsSha256 !== hashContent(work.params)) throw new Error('Saved request differs from its immutable wave or quote.');
  return { work, quote, request };
}
async function progress(lease, state, ledger) {
  const generated = new Set(), reviewed = new Set(), approved = new Set(), held = new Set(), drafts = new Map(), open = [];
  const knownRequests = new Set();
  for (const id of state.waves) {
    const plan = await savedWave(lease, state, id);
    const complete = await readOptionalJson(join(lease.output, wavePath(id, 'complete.json')));
    if (!complete) open.push(plan);
    const resultHashes = [];
    for (const row of plan.requests) {
      if (knownRequests.has(row.id)) throw new Error('A request is registered in multiple waves.'); knownRequests.add(row.id);
      const call = ledger.calls.find(item => item.id === row.id);
      if (!call || call.submissionId !== plan.id || call.requestHash !== row.requestHash || call.stage !== plan.stage || hashContent(call.unitIds) !== hashContent(row.unitIds)) throw new Error('Wave and spending reservation disagree; reconcile interrupted checkpoint.');
      const attempted = call.stage === 'generation' ? generated : reviewed;
      for (const unitId of call.unitIds) { if (attempted.has(unitId)) throw new Error('Duplicate paid stage detected; automatic retry is prohibited.'); attempted.add(unitId); }
      const outcome = await readOptionalJson(join(lease.output, `scale/outcomes/${row.id}.json`));
      if (complete && (!outcome || call.status !== 'complete' || call.providerBatchId !== complete.providerBatchId)) throw new Error('Completed wave lacks settled requests and parsed outcomes.');
      if (!outcome) continue;
      if (outcome.requestId !== row.id || call.status !== 'complete' || outcome.responseSha256 !== call.responseHash) throw new Error('Content outcome has no exact settled provider evidence.');
      for (const item of outcome.drafts ?? []) drafts.set(item.id, item);
      for (const unitId of outcome.approved ?? []) approved.add(unitId);
      for (const unitId of outcome.held ?? []) held.add(unitId);
      resultHashes.push({ id: row.id, sha256: call.responseHash });
    }
    if (complete && (complete.planSha256 !== hashContent(plan) || hashContent(complete.resultHashes) !== hashContent(resultHashes))) throw new Error('Completed wave proof changed.');
  }
  if (ledger.calls.some(call => call.billing === 'batch-50-percent' && !knownRequests.has(call.id)) || open.length > 1) throw new Error('Unindexed or concurrent batch liability; stop before further spending.');
  return { generated, reviewed, approved, held, drafts, open };
}

async function acceptSavedSubmission(lease, plan, ledger) {
  const raw = await readOptionalJson(join(lease.output, wavePath(plan.id, 'create-response.json')));
  if (!raw) throw new Error('Prior batch submission has no saved response. Outcome is unknown or unsent; never resubmit automatically.');
  if (raw.planSha256 !== hashContent(plan)) throw new Error('Saved submission belongs to another wave.');
  const id = providerId(raw.response?.id);
  const receipt = { providerBatchId: id, planSha256: hashContent(plan), responseSha256: hashContent(raw.response) };
  await scaleJson(lease, wavePath(plan.id, 'accepted.json'), receipt);
  for (const row of plan.requests) {
    const call = ledger.calls.find(item => item.id === row.id);
    if (call.providerBatchId && call.providerBatchId !== id) throw new Error('Provider batch ID changed.');
    if (!['complete', 'batch_pending'].includes(call.status)) {
      // An explicit saved create response proves acceptance. Unknown calls without
      // this immutable evidence remain reserved forever; no paid replay occurs.
      if (call.status !== 'requested') throw new Error('Unexpected submission checkpoint requires operator reconciliation.');
      Object.assign(call, { status: 'batch_pending', providerBatchId: id });
    }
  }
  await persistLedger(lease, ledger); return receipt;
}

async function interpretSavedResult(lease, state, plan, row, raw, call) {
  const outcomePath = `scale/outcomes/${row.id}.json`, existing = await readOptionalJson(join(lease.output, outcomePath));
  if (existing) {
    if (existing.responseSha256 !== call.responseHash) throw new Error('Saved content outcome differs from paid result.');
    return existing;
  }
  const { work } = await savedRequest(lease, plan, row);
  let outcome = { schemaVersion: 1, requestId: row.id, responseSha256: call.responseHash, stage: work.stage, drafts: [], approved: [], held: [] };
  if (raw.result.result.type !== 'succeeded') outcome = { ...outcome, state: 'terminal-provider-result-no-retry', held: work.unitIds, providerResult: raw.result.result.type };
  else {
    let decoded;
    try { decoded = work.stage === 'generation' ? parseGenerated(raw.result.result.message, work) : parseReviewed(raw.result.result.message, work, raw.savedAt); }
    catch (error) { outcome = { ...outcome, state: compactError(error), held: work.unitIds }; }
    if (decoded && work.stage === 'generation') {
      for (const unit of decoded) { await saveScaleDraft(lease, state, unit); outcome.drafts.push({ id: unit.id, contentSha256: hashContent(unit) }); }
      outcome.state = 'drafts-awaiting-independent-review';
    } else if (decoded) {
      await persistReviewResult(lease, row.id, decoded.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })));
      for (const { unit, receipt } of decoded) {
        if (receipt.approved) { await saveScaleApproval(lease, unit, receipt); outcome.approved.push(unit.id); }
        else outcome.held.push(unit.id);
      }
      outcome.state = 'independently-reviewed';
    }
  }
  await scaleJson(lease, outcomePath, outcome); return outcome;
}

/** Collection only repeats read operations; it never calls create or resends content. */
async function collectWave(lease, state, plan, adapter) {
  let ledger = await readJson(join(lease.output, 'ledger.json'));
  const accepted = await acceptSavedSubmission(lease, plan, ledger);
  let ended = await readOptionalJson(join(lease.output, wavePath(plan.id, 'ended.json')));
  if (!ended) {
    const status = await adapter.retrieve(accepted.providerBatchId);
    if (status.id !== accepted.providerBatchId || !['in_progress', 'canceling', 'ended'].includes(status.processing_status)) throw new Error('Provider returned an unknown batch status; retain all reservations.');
    if (status.processing_status !== 'ended') return { state: 'batch-processing', waveId: plan.id, providerBatchId: status.id, stage: plan.stage };
    // Preserve terminal metadata before any result interpretation or zero-bill decision.
    ended = { providerBatchId: status.id, status, savedAt: new Date().toISOString() };
    await scaleJson(lease, wavePath(plan.id, 'ended.json'), ended);
  }
  if (ended.providerBatchId !== accepted.providerBatchId || ended.status.processing_status !== 'ended') throw new Error('Saved terminal status changed.');
  const expected = new Set(plan.requests.map(row => row.id)), saved = new Map();
  for (const row of plan.requests) {
    const prior = await readOptionalJson(join(lease.output, wavePath(plan.id, `results/${row.id}.json`)));
    if (prior) saved.set(row.id, prior);
  }
  const streamIndex = await readOptionalJson(join(lease.output, wavePath(plan.id, 'results-index.json')));
  if (!streamIndex) {
    const seen = new Set();
    try {
      for await (const result of await adapter.results(accepted.providerBatchId)) {
        if (!expected.has(result.custom_id) || seen.has(result.custom_id)) throw new Error('Unexpected or duplicate batch result identity.');
        seen.add(result.custom_id);
        const prior = saved.get(result.custom_id);
        if (prior && hashContent(prior.result) !== hashContent(result)) throw new Error('Immutable provider result changed.');
        const raw = prior ?? { schemaVersion: 1, providerBatchId: accepted.providerBatchId, result, savedAt: ended.savedAt };
        await scaleJson(lease, wavePath(plan.id, `results/${result.custom_id}.json`), raw); saved.set(result.custom_id, raw);
      }
    } catch { throw new Error('Result download is incomplete or inconsistent; saved raw is retained. Retry collection only, never submission.'); }
    if (seen.size !== expected.size) throw new Error('Ended batch omitted expected results; retain reservations and retry collection only.');
    await scaleJson(lease, wavePath(plan.id, 'results-index.json'), { providerBatchId: accepted.providerBatchId,
      rows: plan.requests.map(row => ({ id: row.id, sha256: hashContent(saved.get(row.id).result) })) });
  } else if (streamIndex.providerBatchId !== accepted.providerBatchId || saved.size !== expected.size
    || hashContent(streamIndex.rows) !== hashContent(plan.requests.map(row => ({ id: row.id, sha256: hashContent(saved.get(row.id).result) })))) {
    throw new Error('Completed result-stream evidence is missing or changed.');
  }
  ledger = await readJson(join(lease.output, 'ledger.json'));
  for (const row of plan.requests) {
    const raw = saved.get(row.id), call = ledger.calls.find(item => item.id === row.id);
    if (!raw || raw.providerBatchId !== accepted.providerBatchId || raw.result.custom_id !== row.id) throw new Error('Missing exact per-request saved result.');
    const responseHash = hashContent(raw.result);
    if (call.status === 'complete') { if (call.responseHash !== responseHash) throw new Error('Settled batch response changed.'); continue; }
    let actualUsd;
    try { actualUsd = adapter.price(raw.result); if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error(); }
    catch { call.accountingHold = 'unpriced-saved-batch-response'; await persistLedger(lease, ledger); throw new Error('Raw batch results are saved, but billing needs explicit review. No retry.'); }
    Object.assign(call, { status: 'complete', actualUsd, responseHash, completedAt: ended.savedAt });
    if (actualUsd > call.reservedUsd + 1e-9) call.accountingHold = 'charge-exceeded-reservation';
  }
  await persistLedger(lease, ledger);
  if (ledger.calls.some(call => call.accountingHold)) throw new Error('Accounting hold blocks interpretation and new spending.');
  for (const row of plan.requests) await interpretSavedResult(lease, state, plan, row, saved.get(row.id), ledger.calls.find(item => item.id === row.id));
  await scaleJson(lease, wavePath(plan.id, 'complete.json'), { planSha256: hashContent(plan), providerBatchId: accepted.providerBatchId, resultHashes: plan.requests.map(row => ({ id: row.id, sha256: hashContent(saved.get(row.id).result) })) });
  return { state: 'batch-collected', waveId: plan.id, stage: plan.stage, requests: plan.requests.length };
}

async function importInbox(lease, state, approval, registry) {
  const names = await scaleNames(lease.output, 'scale/inbox');
  for (const name of names.filter(name => name.endsWith('.review.json'))) {
    const id = safeScaleId(name.slice(0, -'.review.json'.length));
    const source = await readJson(join(lease.output, 'scale/inbox', `${id}.source.json`));
    if (source.id !== id) throw new Error('Inventory filename and source ID differ.');
    const review = await readJson(join(lease.output, 'scale/inbox', name));
    state = await importScaleInventory(lease, state, { source, review }, registry, approval.seeds, approval.receipt.maxAdditionalUnits);
  }
  return state;
}
async function nextWorks(lease, state, seen) {
  const ready = [...seen.drafts.values()].filter(row => !seen.reviewed.has(row.id));
  const stage = ready.length ? 'review' : 'generation';
  if (stage === 'generation' && seen.held.size / Math.max(20, seen.generated.size) > SCALE_POLICY.maxScaleHeldFraction) return { stage, qualityHold: true, works: [] };
  const rows = ready.length ? await Promise.all(ready.slice(0, 200).map(async row => {
    const saved = await readJson(join(lease.output, 'drafts', row.id, `${row.contentSha256}.json`));
    if (saved.contentSha256 !== row.contentSha256 || hashContent(saved.unit) !== row.contentSha256) throw new Error('Exact draft changed before review.');
    return saved.unit;
  })) : state.seeds.filter(seed => !seen.generated.has(seed.id)).slice(0, 200);
  const works = chunks(rows).map(group => {
    const id = `scale-${stage}-${hashContent({ promptVersion: 'v2', stage, group }).slice(0, 32)}`;
    return stage === 'generation' ? generationWork(group, { id, createdAt: state.createdAt }) : reviewWork(group, { id, createdAt: state.createdAt });
  });
  return { stage, qualityHold: false, works };
}

async function submitWave(lease, options, approval, gate, state, works, adapter) {
  let ledger = await readJson(join(lease.output, 'ledger.json'));
  const selected = [];
  for (const work of works.slice(0, 40)) {
    checkedWork(work);
    if (ledger.calls.some(call => call.id === work.id || call.stage === work.stage && call.unitIds?.some(id => work.unitIds.includes(id)))) throw new Error('Existing stage request cannot be retried under another batch identity.');
    const quote = await adapter.quote(work.params), expected = quoteBatchInput(work.params, quote.countedInputTokens);
    if (hashContent(quote) !== hashContent(expected)) throw new Error('Batch quote differs from the verified price policy.');
    const request = boundedRequest({ ...work, reservedUsd: quote.reservedUsd });
    const report = assessSharedBudget({ ...gate.snapshot, expansion: ledger });
    // Leave enough for the full 50k-input / 8k-output review ceilings. This is
    // planning headroom, not a fabricated paid request. Only one wave can run.
    const reviewCushion = work.stage === 'generation' ? (selected.length + 1) * SCALE_POLICY.minimumReviewReserveUsdPerRequest : 0;
    if (report.remainingUsd + 1e-9 < quote.reservedUsd + reviewCushion) break;
    const compact = { id: request.id, stage: request.stage, unitIds: request.unitIds, requestHash: request.requestHash,
      reservedUsd: request.reservedUsd, adapterVersion: request.adapterVersion, billing: 'batch-50-percent' };
    ledger = reserveExpansionRequest({ ...gate.snapshot, expansion: ledger }, compact).ledger;
    selected.push({ work, quote, request });
  }
  if (!selected.length) return { state: 'budget-exhausted-before-next-bounded-request' };
  const waveId = `wave-${hashContent(selected.map(row => row.request.requestHash)).slice(0, 32)}`;
  for (const row of selected) ledger.calls.find(call => call.id === row.request.id).submissionId = waveId;
  const plan = { schemaVersion: 1, id: waveId, stage: selected[0].work.stage, approvalSha256: approval.approvalSha256, batchPolicySha256: BATCH_POLICY_SHA256,
    requests: selected.map(({ work, request }) => ({ id: request.id, unitIds: request.unitIds, requestHash: request.requestHash, workSha256: hashContent(work) })) };
  for (const row of selected) { await persistWork(lease, row.work, row.quote); await persistRequest(lease, row.request); }
  state = await registerScaleWave(lease, state, plan); await persistLedger(lease, ledger);
  const again = await verifyScaleApproval(options), checkedGate = await inspectPhaseOneGate(lease, gateOptions(options, again));
  if (again.approvalSha256 !== approval.approvalSha256 || checkedGate.phaseOneFingerprint !== state.phaseOneFingerprint
    || await exists(join(options.runtimeDirectory, 'stop-scale'))) throw new Error('Configuration or stop checkpoint changed; unsent reservations retained for explicit reconciliation.');
  const requests = validateBatchRequests(selected.map(({ request }) => ({ custom_id: request.id, params: request.params })));
  await scaleJson(lease, wavePath(waveId, 'submitting.json'), { planSha256: hashContent(plan), at: new Date().toISOString() });
  for (const row of selected) Object.assign(ledger.calls.find(call => call.id === row.request.id), { status: 'requested', sentAt: new Date().toISOString() });
  await persistLedger(lease, ledger);
  let response;
  try { response = await adapter.create(requests); }
  catch {
    for (const row of selected) Object.assign(ledger.calls.find(call => call.id === row.request.id), { status: 'uncertain', errorKind: 'batch-submit-outcome-unknown' });
    await persistLedger(lease, ledger); throw new Error('Batch submission outcome is unknown. Entire wave reserved; no automatic retry.');
  }
  await scaleJson(lease, wavePath(waveId, 'create-response.json'), { planSha256: hashContent(plan), response, savedAt: new Date().toISOString() });
  const accepted = await acceptSavedSubmission(lease, plan, ledger);
  return { state: 'batch-submitted', waveId, providerBatchId: accepted.providerBatchId, stage: plan.stage,
    requests: selected.length, units: selected.reduce((sum, row) => sum + row.work.unitIds.length, 0), reservedUsd: selected.reduce((sum, row) => sum + row.quote.reservedUsd, 0) };
}
const gateOptions = (options, approval) => ({ phaseOneOutput: options.phaseOneOutput, runtimeDirectory: options.runtimeDirectory,
  cashPurchases: approval.cashPurchases, historicalCommitments: approval.historicalCommitments, canonicalAudit: approval.canonicalAudit });

async function cycle(options, adapterFactory) {
  return withExpansionLock(options, async lease => {
    const approval = await verifyScaleApproval(options), gate = await inspectPhaseOneGate(lease, gateOptions(options, approval));
    if (gate.registry.canonicalAudit?.canonicalLexemeCount !== 7500) throw new Error('Reviewed 7,500-family base is required.');
    let state = await initializeScaleState(lease, { approvalSha256: approval.approvalSha256, phaseOneFingerprint: gate.phaseOneFingerprint });
    const ledger = await readJson(join(lease.output, 'ledger.json')), report = assessSharedBudget({ ...gate.snapshot, expansion: ledger });
    if (state.phaseOneFingerprint !== gate.phaseOneFingerprint || ledger.calls.some(call => call.accountingHold)) throw new Error('Frozen base changed or accounting is held.');
    const seen = await progress(lease, state, ledger);
    // Collection remains possible after a stop request; it cannot purchase anything.
    // Unknown create outcomes stop here before a second adapter.create can occur.
    if (seen.open.length) return collectWave(lease, state, seen.open[0], adapterFactory());
    if (!report.canCommitExpansion) throw new Error('Shared budget/lifecycle is blocked; no new wave can be submitted.');
    if (await exists(join(options.runtimeDirectory, 'stop-scale'))) return { state: 'stopped-at-checkpoint' };
    state = await importInbox(lease, state, approval, gate.registry);
    const next = await nextWorks(lease, state, seen);
    let result;
    if (next.qualityHold) result = { state: 'quality-hold-above-ten-percent', held: seen.held.size };
    else if (!next.works.length) result = { state: state.seeds.length >= approval.receipt.maxAdditionalUnits ? 'inventory-complete-with-any-held-items-reported' : 'reviewed-inventory-needed',
      registered: state.seeds.length, approved: seen.approved.size, held: seen.held.size };
    else result = await submitWave(lease, options, approval, gate, state, next.works, adapterFactory());
    const summary = { ...result, additionalApproved: seen.approved.size, inventory: state.seeds.length, held: seen.held.size,
      budgetBeforeAction: { committedUsd: report.committedUsd, remainingUsd: report.remainingUsd, combinedAllInJpy: report.yen.combinedAllInJpy }, forecast: forecastFromPilot(approval.pilot, report.remainingUsd) };
    await scaleJson(lease, 'scale/last-report.json', summary, false); return summary;
  });
}
export const dispatchScaleCycle = options => cycle(options, () => createBatchAdapter());
export function dispatchScaleCycleWithMockSdk(options, client) {
  if (!client?.testOnly || client.networkEnabled !== false) throw new Error('A network-disabled mock SDK is required.');
  return cycle(options, () => createBatchAdapter({ client }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), values = {}, names = { '--out': 'output', '--phase-one': 'phaseOneOutput', '--runtime': 'runtimeDirectory', '--cycles': 'cycles' };
    if (!args.includes('--run-reviewed-scale')) throw new Error('Scaling remains disabled without --run-reviewed-scale and installed measured-pilot approval.');
    for (let i = 0; i < args.length; i++) { if (args[i] === '--run-reviewed-scale') continue; const key = names[args[i]]; if (!key || values[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or duplicate CLI argument.'); values[key] = args[++i]; }
    if (!values.output || !values.phaseOneOutput || !values.runtimeDirectory) throw new Error('Explicit private output, phase-one and runtime paths are required.');
    const limit = values.cycles === undefined ? 1 : Number(values.cycles);
    if (!Number.isInteger(limit) || limit < 1 || limit > SCALE_POLICY.maxCycles) throw new Error('Cycle bound must be 1–1440.');
    const options = { ...values, sharedLockDirectory: join(values.runtimeDirectory, 'shared-spending.lock') };
    for (let i = 0; i < limit; i++) {
      const result = await dispatchScaleCycle(options); process.stdout.write(JSON.stringify(result) + '\n');
      if (['stopped-at-checkpoint', 'quality-hold-above-ten-percent', 'budget-exhausted-before-next-bounded-request', 'inventory-complete-with-any-held-items-reported', 'reviewed-inventory-needed'].includes(result.state)) break;
      if (i + 1 === limit) { process.stdout.write(JSON.stringify({ state: 'cycle-limit-reached', cycles: limit }) + '\n'); break; }
      if (await exists(join(values.runtimeDirectory, 'stop-scale'))) break;
      await new Promise(resolve => setTimeout(resolve, SCALE_POLICY.pollSeconds * 1000));
      if (await exists(join(values.runtimeDirectory, 'stop-scale'))) break;
    }
  } catch (error) { process.stderr.write(`Batch expansion stopped: ${error?.name === 'ZodError' ? 'Private saved content failed schema validation.' : error.message}\n`); process.exitCode = 1; }
}
