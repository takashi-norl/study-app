import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBudgetSnapshot, loadRegistry } from './loaders.mjs';
import { classifyCandidates } from './registry.mjs';
import { hashContent, normalizeForm, validateSeed } from './schema.mjs';
import { TARGET_ALLOCATION } from './allocation.mjs';
import { isPublicCandidate } from '../vocabulary-batch/catalog-policy.mjs';
import { applyCanonicalAudit } from './canonical-families.mjs';
import { reserveExpansionRequest } from './budget.mjs';
import { assertLease, initializeStore, persistLedger, persistRawResponse, persistRequest, readJson, readOptionalJson, registerPilotSeeds, withExpansionLock } from './store.mjs';

const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export function assertProductionDispatchReady() {
  throw Object.assign(new Error('Live expansion dispatch is disabled until the phase-one launch path honors the shared spending fence and a reviewed provider adapter is installed.'), { code: 'LIVE_EXPANSION_NOT_INTEGRATED' });
}

async function catalogFingerprint(output) {
  const files = [];
  for (const grade of (await readdir(join(output, 'approved'), { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const name of (await readdir(join(output, 'approved', grade.name))).filter(name => name.endsWith('.json')).sort()) files.push([`${grade.name}/${name}`, hashContent(await readJson(join(output, 'approved', grade.name, name)))]);
  }
  return hashContent({ files, frozen: await readJson(join(output, 'frozen-100.json')) });
}

/** Real filesystem evidence, not caller-provided true lifecycle flags. No writes to phase one. */
export async function inspectPhaseOneGate(lease, { phaseOneOutput, runtimeDirectory, cashPurchases = [], historicalCommitments, mockExpectedBaseTarget = 7500, canonicalAudit }) {
  await assertLease(lease, lease.output);
  if (!Number.isInteger(mockExpectedBaseTarget) || mockExpectedBaseTarget < 1 || mockExpectedBaseTarget > 7500) throw new Error('Invalid mocked base target.');
  if (!await exists(join(runtimeDirectory, 'stop-production'))) throw new Error('Phase-one stop checkpoint is required.');
  for (const lock of [join(runtimeDirectory, 'production.lock'), join(phaseOneOutput, '.text-build-lock'), join(phaseOneOutput, 'audio', 'batch.lock')]) {
    if (await exists(lock)) throw new Error('Phase one is still running or owns a work lock.');
  }
  const [snapshot, rawRegistry, manifest, audioReport, contentHash] = await Promise.all([
    loadBudgetSnapshot({ phaseOneOutput, expansionLedgerPath: join(lease.output, 'ledger.json'), allowNewExpansion: true, cashPurchases, historicalCommitments }),
    loadRegistry({ phaseOneOutput }), readJson(join(phaseOneOutput, 'manifest.json')), readJson(join(phaseOneOutput, 'audio', 'last-report.json')), catalogFingerprint(phaseOneOutput),
  ]);
  const registry = canonicalAudit ? applyCanonicalAudit(rawRegistry, canonicalAudit.proposal, canonicalAudit.review) : rawRegistry;
  if (snapshot.phaseOneText.calls.some(call => call.status !== 'complete')) throw new Error('Phase-one text requests must be fully settled.');
  if (snapshot.phaseOneAudioReservations.some(record => !['ready', 'known-quota-rejection'].includes(record.outcome))) throw new Error('Phase-one audio requests must be fully settled.');
  const approvedForms = new Set([...registry.units.values()].filter(unit => ['base-approved', 'frozen'].includes(unit.source)).map(unit => unit.lemma));
  const activeWords = Array.isArray(manifest.words) ? manifest.words.filter(isPublicCandidate) : [];
  const activeForms = new Set(activeWords.map(word => normalizeForm(word.word ?? word.lemma ?? '')));
  const completedCount = registry.canonicalAudit?.canonicalLexemeCount ?? approvedForms.size;
  const approvedIds = new Set([...registry.units.values()].filter(unit => ['base-approved', 'frozen'].includes(unit.source)).map(unit => unit.id));
  if (completedCount !== mockExpectedBaseTarget || activeWords.length !== approvedIds.size || new Set(activeWords.map(word => word.id)).size !== approvedIds.size || activeWords.some(word => !approvedIds.has(word.id) || !['approved', 'preserved'].includes(word.status)) || [...activeForms].some(form => !approvedForms.has(form))) throw new Error('Phase-one approved catalog is not complete; held inventory is not completion.');
  const heldWords = manifest.words.filter(word => word.inventoryHold);
  if (heldWords.some(word => ['approved', 'preserved'].includes(word.status))) throw new Error('Held inventory must not appear in the approved base catalog.');
  // Audio reports cover all paid approved assets, including retained non-base content.
  // Do not discard those reservations or demand another recording to reach the base target.
  const approvedNew = manifest.words.filter(word => word.status === 'approved').length;
  if (audioReport.total !== approvedNew || audioReport.ready + audioReport.existing !== approvedNew || audioReport.missing !== 0 || audioReport.failed !== 0 || audioReport.stopped || snapshot.phaseOneAudioReservations.filter(record => record.outcome === 'ready').length < audioReport.ready) throw new Error('Phase-one audio has not drained to a complete final report.');
  const phaseOneFingerprint = hashContent({ manifest, ledger: snapshot.phaseOneText, audioReservations: snapshot.phaseOneAudioReservations, contentHash, ...(historicalCommitments ? { historicalCommitments } : {}), ...(registry.canonicalAudit ? { canonicalAudit: registry.canonicalAudit } : {}) });
  // Quarantined seeds remain reserved lexical identities. They are not completed assets,
  // and cannot silently become phase-two candidates without an explicit review workflow.
  for (const word of heldWords) {
    const lemma = normalizeForm(word.word ?? word.lemma ?? ''), id = word.id;
    if (!id || !lemma) throw new Error('Held inventory is missing its lexical identity.');
    const aliases = [...(word.aliases ?? []), ...Object.values(word.verbForms ?? {}).flat()].map(normalizeForm);
    registry.units.set(id, { id, lemma, aliases, source: 'quarantined' });
    for (const form of [lemma, ...aliases]) { const owners = registry.forms.get(form) ?? new Set(); owners.add(id); registry.forms.set(form, owners); }
  }
  return { snapshot: { ...snapshot, lifecycle: { phaseOneStopped: true, phaseOneSettled: true, exclusiveSharedLockHeld: true } }, registry, phaseOneFingerprint };
}

export function boundedRequest({ id, stage, unitIds, params, reservedUsd }) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,159}$/.test(id) || !['generation', 'review'].includes(stage) || !Array.isArray(unitIds) || unitIds.length < 1 || unitIds.length > 5 || new Set(unitIds).size !== unitIds.length || unitIds.some(id => typeof id !== 'string' || !/^en-(word|phrase)-[a-f0-9]{24}$/.test(id))) throw new Error('A request must have a stable identity, stage and 1–5 unique unit IDs.');
  if (!params || typeof params !== 'object' || Array.isArray(params) || !Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > 20000 || typeof params.model !== 'string' || !params.model) throw new Error('Bounded provider model/output parameters required.');
  const allowed = new Set(['model', 'max_tokens', 'system', 'messages', 'output_config', 'thinking', 'tools', 'tool_choice', 'service_tier', 'inference_geo']);
  if (Object.keys(params).some(key => !allowed.has(key)) || JSON.stringify(params).length > 2_000_000) throw new Error('Provider parameters must not include credentials, headers or unbounded payloads.');
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0 || reservedUsd > 500) throw new Error('A positive worst-case spending ceiling is required.');
  const requestHash = hashContent({ adapterVersion: 1, stage, unitIds, params });
  return { id, stage, unitIds, params, reservedUsd, requestHash, adapterVersion: 1 };
}

async function reconcileSavedResponse(lease, request, saved, provider) {
  if (saved.requestId !== request.id || saved.requestHash !== request.requestHash) throw new Error('Saved provider response is bound to different inputs.');
  const ledger = await readJson(join(lease.output, 'ledger.json')), call = ledger.calls.find(call => call.id === request.id);
  if (!call) throw new Error('Saved response has no matching reservation.');
  if (call.status === 'complete' && call.responseHash !== hashContent(saved.response)) throw new Error('Completed response evidence has changed; do not decode or resend.');
  if (call.status !== 'complete') {
    let actualUsd;
    try { actualUsd = provider.price(saved.response); if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new Error(); }
    catch { call.status = 'uncertain'; call.errorKind = 'unpriced-saved-response'; await persistLedger(lease, ledger); throw new Error('Raw response is saved but billing is unresolved. No retry.'); }
    Object.assign(call, { status: 'complete', actualUsd, completedAt: new Date().toISOString(), responseHash: hashContent(saved.response) });
    if (actualUsd > call.reservedUsd + 1e-9) call.accountingHold = 'charge-exceeded-reservation';
    await persistLedger(lease, ledger);
  }
  if (call.actualUsd > call.reservedUsd + 1e-9) throw new Error('Actual cost exceeded its reservation; preserved for operator accounting review.');
  // Decoding is deliberately after durable response capture and cost reconciliation.
  const decoded = provider.decode(saved.response);
  return { requestId: request.id, status: 'complete', actualUsd: call.actualUsd, decoded, replayed: true };
}

/** Mock-only dispatcher foundation. It contains no SDK, HTTP call or credential loader. */
export async function dispatchWithMockProvider(options) {
  if (options.provider?.mode !== 'mock' || typeof options.provider.request !== 'function' || typeof options.provider.price !== 'function' || typeof options.provider.decode !== 'function') assertProductionDispatchReady();
  const request = boundedRequest(options.request);
  return withExpansionLock(options, async lease => {
    let gate = await inspectPhaseOneGate(lease, options);
    const state = await initializeStore(lease, { phaseOneFingerprint: gate.phaseOneFingerprint, allocationHash: hashContent(TARGET_ALLOCATION) });
    let ledger = await readJson(join(lease.output, 'ledger.json'));
    const previous = ledger.calls.find(call => call.id === request.id);
    if (previous) {
      if (previous.requestHash !== request.requestHash || previous.reservedUsd !== request.reservedUsd) throw new Error('Request identity already exists with different inputs or reservation.');
      const saved = await readOptionalJson(join(lease.output, 'requests', request.id, 'response.json'));
      if (saved) return reconcileSavedResponse(lease, request, saved, options.provider);
      throw new Error(previous.status === 'reserved' ? 'Saved reservation was not sent; explicit operator resume is required.' : 'Prior request outcome is unknown or its raw response is missing. Never resend automatically.');
    }
    if (ledger.calls.some(call => call.requestHash === request.requestHash)) throw new Error('Same provider inputs already have a paid request identity; use saved results.');
    if (ledger.calls.some(call => call.accountingHold)) throw new Error('An accounting hold requires explicit operator reconciliation before further spending.');
    if (ledger.calls.length >= TARGET_ALLOCATION.pilot.maxPaidRequests) throw new Error('First-pilot request limit reached; review actual cost and quality before expanding.');
    const seeds = (options.seeds ?? []).map(validateSeed);
    const known = new Map(state.pilot.seeds.map(seed => [seed.id, seed]));
    const newSeeds = seeds.filter(seed => !known.has(seed.id));
    const classification = classifyCandidates(gate.registry, [...state.pilot.seeds, ...newSeeds]);
    const acceptedIds = new Set(classification.accepted.map(seed => seed.id));
    if (newSeeds.some(seed => !acceptedIds.has(seed.id))) throw new Error('Pilot candidates overlap the base or pilot catalog. Link or review them instead.');
    const registered = await registerPilotSeeds(lease, seeds);
    if (request.unitIds.some(id => !registered.pilot.seeds.some(seed => seed.id === id))) throw new Error('Request targets an unregistered pilot unit.');
    // Re-read base evidence before reserving. The mock harness still exercises the real gate.
    gate = await inspectPhaseOneGate(lease, options);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint) throw new Error('Frozen phase-one evidence changed before reservation.');
    const reservation = reserveExpansionRequest({ ...gate.snapshot, expansion: ledger }, request);
    await persistRequest(lease, request);
    await persistLedger(lease, reservation.ledger);
    gate = await inspectPhaseOneGate(lease, options);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint) throw new Error('Frozen phase-one evidence changed before dispatch.');
    ledger = await readJson(join(lease.output, 'ledger.json'));
    const call = ledger.calls.find(call => call.id === request.id);
    Object.assign(call, { status: 'requested', sentAt: new Date().toISOString() });
    await persistLedger(lease, ledger); // Must reach durable storage before the provider boundary.
    let response;
    try { response = await options.provider.request(request.params); }
    catch { call.status = 'uncertain'; call.errorKind = 'provider-submit-outcome-unknown'; await persistLedger(lease, ledger); throw new Error('Provider outcome is unknown. Reservation retained; no automatic retry.'); }
    const saved = await persistRawResponse(lease, request, response);
    const result = await reconcileSavedResponse(lease, request, saved, options.provider);
    return { ...result, replayed: false };
  });
}
