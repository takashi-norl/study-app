import { validateCommitmentTransition } from './budget.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { approveUnit, canonicalJson, hashContent, validateRelations, validateSeed, validateUnit } from './schema.mjs';
import { assertSharedSpendingFence, withSharedSpendingFence } from '../shared-spending-fence.mjs';

const leases = new WeakSet();
const safeId = id => { if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,159}$/.test(id)) throw new Error('Invalid durable identity.'); return id; };
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export async function readOptionalJson(file) { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function syncDirectory(directory) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function durableJson(file, value, immutable = false) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const encoded = `${canonicalJson(value)}\n`, temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
  try {
    if (immutable) {
      try { await link(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== encoded) throw error; }
      await unlink(temporary);
    } else await rename(temporary, file);
    await syncDirectory(dirname(file));
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function withExpansionLock({ output, sharedLockDirectory }, action) {
  return withSharedSpendingFence({ output, sharedLockDirectory, ownerKind: 'phase-two' }, async lease => {
    leases.add(lease); try { return await action(lease); } finally { leases.delete(lease); }
  });
}
export async function assertLease(lease, output) {
  if (!leases.has(lease) || lease.output !== resolve(output)) throw new Error('A real exclusive lease is required for this store.');
  await assertSharedSpendingFence(lease, 'phase-two');
  const current = await readJson(join(lease.sharedLockDirectory, 'owner.json'));
  if (current.nonce !== lease.nonce || current.output !== lease.output) throw new Error('Shared spending lock changed ownership.');
}
export async function initializeStore(lease, { phaseOneFingerprint, allocationHash }) {
  await assertLease(lease, lease.output);
  if (![phaseOneFingerprint, allocationHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Frozen baseline and allocation hashes are required.');
  const file = join(lease.output, 'store.json'), prior = await readOptionalJson(file);
  if (prior) {
    if (prior.schemaVersion !== 1 || prior.phaseOneFingerprint !== phaseOneFingerprint || prior.allocationHash !== allocationHash || prior.sharedLockDirectory !== lease.sharedLockDirectory || prior.pilot.maxUnits !== 20) throw new Error('Store baseline, allocation or lock differs from its frozen configuration.');
    if (!await readOptionalJson(join(lease.output, 'ledger.json'))) throw new Error('Initialized store is missing its spending ledger; do not recreate it.');
    return prior;
  }
  // Write the empty ledger first. A crash cannot turn an initialized store into a fresh budget.
  const existingLedger = await readOptionalJson(join(lease.output, 'ledger.json'));
  if (existingLedger?.calls?.length) throw new Error('Uninitialized store already has spending records.');
  if (!existingLedger) await durableJson(join(lease.output, 'ledger.json'), { schemaVersion: 1, calls: [] }, true);
  const state = { schemaVersion: 1, phaseOneFingerprint, allocationHash, sharedLockDirectory: lease.sharedLockDirectory, createdAt: new Date().toISOString(), pilot: { maxUnits: 20, seeds: [] } };
  await durableJson(file, state, true); return state;
}
export async function registerPilotSeeds(lease, seeds) {
  await assertLease(lease, lease.output); const state = await readJson(join(lease.output, 'store.json'));
  const byId = new Map(state.pilot.seeds.map(seed => [seed.id, seed]));
  for (const raw of seeds) {
    const seed = validateSeed(raw), previous = byId.get(seed.id);
    if (previous && hashContent(previous) !== hashContent(seed)) throw new Error('Pilot seed changed under the same identity.');
    byId.set(seed.id, seed);
  }
  if (byId.size > 20 || state.pilot.maxUnits !== 20) throw new Error('The first expansion pilot is limited to 20 distinct items.');
  const next = { ...state, pilot: { ...state.pilot, seeds: [...byId.values()] } };
  await durableJson(join(lease.output, 'store.json'), next); return next;
}
export async function persistLedger(lease, ledger) {
  await assertLease(lease, lease.output);
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.calls) || new Set(ledger.calls.map(call => call.id)).size !== ledger.calls.length) throw new Error('Invalid expansion ledger.');
  const previous = await readJson(join(lease.output, 'ledger.json'));
  const transitions = { reserved: ['reserved', 'requested', 'batch_pending'], requested: ['requested', 'uncertain', 'complete', 'batch_pending'], uncertain: ['uncertain', 'complete'], batch_pending: ['batch_pending', 'uncertain', 'complete'], complete: ['complete'] };
  for (const call of ledger.calls) {
    safeId(call.id);
    if (!transitions[call.status] || !/^[a-f0-9]{64}$/.test(call.requestHash) || !Number.isFinite(call.reservedUsd) || call.reservedUsd <= 0 || call.reservedUsd > 500) throw new Error('Invalid request reservation.');
    if (call.status === 'complete' && (!Number.isFinite(call.actualUsd) || call.actualUsd < 0 || !/^[a-f0-9]{64}$/.test(call.responseHash))) throw new Error('Completed spending requires exact cost and response evidence.');
    if (!previous.calls.some(old => old.id === call.id) && call.status !== 'reserved') throw new Error('New calls must begin with a durable reservation.');
  }
  for (const old of previous.calls) {
    const next = ledger.calls.find(call => call.id === old.id);
    if (!next || !transitions[old.status]?.includes(next.status)) throw new Error('Spending history cannot be removed or rolled back.');
    for (const field of ['requestHash', 'reservedUsd', 'stage', 'unitIds', 'params', 'adapterVersion', 'repairOf', 'repairPlanSha256', 'prefixId', 'commitmentId', 'submissionId', 'billing']) if (canonicalJson(old[field]) !== canonicalJson(next[field])) throw new Error('An immutable request reservation changed.');
    if (old.status === 'complete' && (old.actualUsd !== next.actualUsd || old.responseHash !== next.responseHash)) throw new Error('Completed spending evidence is immutable.');
    if (old.accountingHold && old.accountingHold !== next.accountingHold) throw new Error('Accounting holds require a separate explicit reconciliation workflow.');
  }
  validateCommitmentTransition(previous, ledger);
  await durableJson(join(lease.output, 'ledger.json'), ledger);
}
export async function persistRequest(lease, request) {
  await assertLease(lease, lease.output);
  await durableJson(join(lease.output, 'requests', safeId(request.id), 'request.json'), request, true);
}
export async function persistWork(lease, work, quote) {
  await assertLease(lease, lease.output);
  await durableJson(join(lease.output, 'requests', safeId(work.id), 'work.json'), { work, quote }, true);
}
export async function persistPhaseOneHandoff(lease, runtimeDirectory, record) {
  await assertLease(lease, lease.output);
  if (lease.sharedLockDirectory !== join(resolve(runtimeDirectory), 'shared-spending.lock') || record.phaseTwoOutput !== lease.output || !/^[a-f0-9]{64}$/.test(record.phaseOneFingerprint) || !/^[a-f0-9]{64}$/.test(record.integrationSha256)) throw new Error('Invalid shared-budget handoff evidence.');
  const file = join(runtimeDirectory, 'phase-two-handoff.json'), previous = await readOptionalJson(file);
  if (previous) {
    if (previous.schemaVersion !== 1 || previous.phaseTwoOutput !== record.phaseTwoOutput || previous.phaseOneFingerprint !== record.phaseOneFingerprint) throw new Error('Existing handoff belongs to a different frozen budget/catalog.');
    return previous;
  }
  await durableJson(file, { schemaVersion: 1, ...record }, true); return record;
}
export async function persistReviewResult(lease, requestId, result) {
  await assertLease(lease, lease.output);
  await durableJson(join(lease.output, 'requests', safeId(requestId), 'review-result.json'), result, true);
}
export async function persistRepairRevision(lease, requestId, revision) {
  await assertLease(lease, lease.output);
  await durableJson(join(lease.output, 'requests', safeId(requestId), 'repair-revision.json'), revision, true);
  return revision;
}
export async function persistEditorialEvidence(lease, authority, record) {
  await assertLease(lease, lease.output);
  const directory = join(lease.output, 'editorial-overlays', safeId(record.id));
  await durableJson(join(directory, 'authority.json'), authority, true);
  await durableJson(join(directory, 'revision.json'), record, true);
  await durableJson(join(lease.output, 'editorial-overlays', 'active.json'), record, true);
}
export async function persistRawResponse(lease, request, response) {
  await assertLease(lease, lease.output);
  const file = join(lease.output, 'requests', safeId(request.id), 'response.json');
  const existing = await readOptionalJson(file);
  if (existing) {
    if (existing.requestHash !== request.requestHash || hashContent(existing.response) !== hashContent(response)) throw new Error('Immutable provider response differs from saved evidence.');
    return existing;
  }
  const record = { schemaVersion: 1, requestId: request.id, requestHash: request.requestHash, response, savedAt: new Date().toISOString() };
  await durableJson(file, record, true); return record;
}
export async function persistDraft(lease, raw) {
  await assertLease(lease, lease.output); const unit = validateUnit(raw), state = await readJson(join(lease.output, 'store.json'));
  const seed = state.pilot.seeds.find(seed => seed.id === unit.id);
  if (!seed || Object.keys(seed).some(key => canonicalJson(seed[key]) !== canonicalJson(unit[key]))) throw new Error('Draft differs from its registered pilot seed.');
  const contentSha256 = hashContent(unit);
  await durableJson(join(lease.output, 'drafts', safeId(unit.id), `${contentSha256}.json`), { unit, contentSha256 }, true);
  return { unit, contentSha256 };
}
export async function publishReviewedUnit(lease, raw, receipt, knownBaseSenseIds = []) {
  await assertLease(lease, lease.output); const approved = approveUnit(raw, receipt), hash = hashContent(approved.unit);
  const draft = await readJson(join(lease.output, 'drafts', safeId(approved.unit.id), `${hash}.json`));
  if (hashContent(draft.unit) !== hash || draft.contentSha256 !== hash) throw new Error('Published unit is not bound to a durable draft.');
  const approvedDirectory = join(lease.output, 'approved'); let existing = [];
  try { existing = await Promise.all((await readdir(approvedDirectory)).filter(name => name.endsWith('.json')).map(name => readJson(join(approvedDirectory, name)))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const known = new Set([...knownBaseSenseIds, ...existing.flatMap(item => item.unit.senses.map(sense => sense.id))]);
  validateRelations([approved.unit], known);
  await durableJson(join(lease.output, 'reviews', safeId(approved.unit.id), `${hash}.json`), receipt, true);
  // "Published" here means eligible in this private approved-assets directory, not public web visibility.
  await durableJson(join(approvedDirectory, `${safeId(approved.unit.id)}.json`), approved, true);
  return approved;
}
