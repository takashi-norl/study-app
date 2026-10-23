import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, readFile, mkdir, open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { approveUnit, canonicalJson, hashContent } from './schema.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { inspectEditorialOverlay } from './pilot-editorial.mjs';
import { applyNativeRecoveryChanges, nativeRecoveryProposalSchema, nativeRecoveryReviewSchema } from './offline-native-recovery.mjs';
import { checkedVersionedWork, parseVersionedGeneration, parseVersionedReview } from './work-versions.mjs';
import { checkedWorkV5, parseGeneratedV5 } from './prompts-v5.mjs';
import { readJson, readOptionalJson, withExpansionLock, persistDraft, publishReviewedUnit } from './store.mjs';

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const unique = values => new Set(values).size === values.length;
const same = (a, b, message) => { if (hashContent(a) !== hashContent(b)) throw Error(message); };
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const bindingSchema = z.object({ file: z.string().min(1), byteSha256: sha, contentSha256: sha.nullable() }).strict();
export const overlaidRecoveryAuthoritySchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('offline-reviewed-recovery-authority'), id,
  operation: z.enum(['first-five-overlay', 'v5-one-phrase']), approved: z.boolean(), reviewedBy: z.literal('/root').nullable(), reviewedAt: z.string().datetime().nullable(),
  output: z.string().min(1), runtimeDirectory: z.string().min(1), proposalPath: z.string().min(1), reviewPath: z.string().min(1),
  proposalSha256: sha, reviewSha256: sha, planSha256: sha,
  sources: z.array(bindingSchema).min(1), code: z.array(bindingSchema).min(1), existingApproved: z.array(bindingSchema).min(5),
  paidCallCount: z.literal(7), paidCalls: z.literal(0), publicPublication: z.literal(false), scaleAuthorized: z.literal(false) }).strict();

async function exactPath(file) {
  if (!isAbsolute(file) || await realpath(file) !== resolve(file)) throw Error('Evidence must use exact absolute paths without symbolic links.');
  return file;
}
async function inside(output, file) {
  const path = await exactPath(isAbsolute(file) ? file : join(output, file)), rel = relative(output, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('Evidence escaped its private store.');
  return path;
}
async function binding(file) {
  await exactPath(file); const bytes = await readFile(file);
  let contentSha256 = null;
  if (file.endsWith('.json')) contentSha256 = hashContent(JSON.parse(bytes.toString('utf8')));
  return { file, byteSha256: bytesHash(bytes), contentSha256 };
}
async function walk(directory) {
  if (!await exists(directory)) return [];
  await exactPath(directory); const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symbolic links are not recovery evidence.');
    if (entry.isDirectory()) result.push(...await walk(file)); else if (entry.isFile()) result.push(file); else throw Error('Unexpected evidence file type.');
  }
  return result;
}
async function immutable(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await exactPath(dirname(file));
  if (await exists(file)) { await exactPath(file); same(await readJson(file), value, 'Immutable recovery evidence differs.'); return; }
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(canonicalJson(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file); } finally { await unlink(temporary); }
  const dir = await open(dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}

/** Pure final-card gate shared by the two explicitly bounded recovery paths. */
export function planOverlaidRecovery({ operation, proposal, review: inputReview, state, ledger, originals, providerVerdicts = [] }) {
  const review = nativeRecoveryReviewSchema.parse(inputReview);
  if (operation === 'v5-one-phrase') nativeRecoveryProposalSchema.parse(proposal);
  else if (operation !== 'first-five-overlay' || proposal.kind !== 'offline-overlaid-native-tests-proposal' || proposal.schemaVersion !== 1) throw Error('Unsupported recovery operation.');
  id.parse(proposal.id);
  const expected = operation === 'first-five-overlay' ? ['conundrum', 'elucidate', 'intractable', 'reciprocate', 'repercussion'] : ['on the same wavelength'];
  same(proposal.rows.map(row => row.unit.lemma).sort(), expected, 'This operation has an exact lexical scope.');
  if (!unique(proposal.rows.map(row => row.unitId)) || !unique(review.verdicts.map(row => row.unitId)) || review.verdicts.length !== proposal.rows.length
    || review.proposalSha256 !== hashContent(proposal) || review.reviewedBy === proposal.createdBy) throw Error('Independent full-card approval must match every exact row.');
  if (state?.pilot?.maxUnits !== 20 || !Array.isArray(state.pilot.seeds) || state.pilot.seeds.length > 20 || ledger?.schemaVersion !== 1 || ledger.calls?.length !== 7
    || !unique(ledger.calls.map(call => call.id)) || ledger.calls.some(call => call.status !== 'complete' || call.accountingHold
      || !Number.isFinite(call.actualUsd) || call.actualUsd < 0 || !Number.isFinite(call.reservedUsd) || call.reservedUsd <= 0 || call.actualUsd > call.reservedUsd + 1e-9
      || !sha.safeParse(call.requestHash).success || !sha.safeParse(call.responseHash).success)) throw Error('Exactly seven settled paid calls with retained costs are required.');
  const rows = proposal.rows.map(row => {
    const original = originals.find(unit => unit.id === row.unitId), seed = state.pilot.seeds.find(item => item.id === row.unitId);
    if (!original || !seed || hashContent(original) !== row.beforeContentSha256 || Object.keys(seed).some(key => hashContent(seed[key]) !== hashContent(original[key]))) throw Error('Current full draft or registered seed changed.');
    const paths = row.changes.map(item => item.path).sort();
    const allowed = operation === 'v5-one-phrase' ? ['/senses/0/tests/3/choices/3/feedbackJa']
      : row.unit.lemma === 'reciprocate' ? ['/senses/0/tests/3/choices/0/feedbackJa', '/senses/0/tests/3/explanationJa', '/senses/0/tests/3/prompt'] : [];
    same(paths, allowed, 'Only the exact reviewed feedback/prompt corrections are allowed.');
    const unit = applyNativeRecoveryChanges(original, row), verdict = review.verdicts.find(item => item.unitId === unit.id);
    if (!verdict || verdict.contentSha256 !== hashContent(unit) || review.reviewedBy === unit.provenance.author) throw Error('Final full-card review is stale or not independent.');
    const receipt = { reviewer: review.reviewedBy, reviewedAt: review.reviewedAt, unitId: unit.id, contentSha256: hashContent(unit), approved: true, issues: [] };
    return { unit, receipt, approved: approveUnit(unit, receipt), beforeContentSha256: row.beforeContentSha256, changes: row.changes, reasonJa: row.reasonJa };
  });
  return { schemaVersion: 1, operation, proposalSha256: hashContent(proposal), reviewSha256: hashContent(review), rows, providerVerdicts,
    paidHistory: ledger.calls, paidCalls: 0, publicPublication: false, scaleAuthorized: false };
}

async function stopped(options) {
  for (const field of ['output', 'runtimeDirectory', 'proposalPath', 'reviewPath']) await exactPath(options[field]);
  if (!await exists(join(options.runtimeDirectory, 'stop-production'))) throw Error('Explicit production stop checkpoint required.');
  const config = await readJson(join(options.runtimeDirectory, 'shared-spending-integration.json'));
  if (config.enabled !== false || config.paths?.output !== options.output || config.paths?.runtimeDirectory !== options.runtimeDirectory
    || config.paths?.sharedLockDirectory !== join(options.runtimeDirectory, 'shared-spending.lock')) throw Error('Integration must stay disabled at the exact shared store.');
  await exactPath(config.paths.phaseOneOutput);
  for (const path of [join(options.runtimeDirectory, 'production.lock'), join(config.paths.phaseOneOutput, '.text-build-lock'), join(config.paths.phaseOneOutput, 'audio', 'batch.lock')]) {
    if (await exists(path)) throw Error('A production worker remains active.');
  }
  return config;
}
async function inspect(options, oldIntent = null) {
  const config = await stopped(options), output = options.output, sourcePaths = new Set();
  const read = async file => { const path = await inside(output, file); sourcePaths.add(path); return readJson(path); };
  const [proposal, review, state, ledger, hold] = await Promise.all([read(options.proposalPath), read(options.reviewPath), read('store.json'), read('ledger.json'), read('native-recoveries/scale-hold.json')]);
  if (state.sharedLockDirectory !== config.paths.sharedLockDirectory || hold.scaleAuthorized !== false || hold.automaticallyReleasable !== false) throw Error('Exact shared lock and permanent scale hold are required.');
  const requests = new Map();
  if (!Array.isArray(ledger.calls) || ledger.calls.length !== 7) throw Error('Exactly seven settled paid calls are required.');
  for (const call of ledger.calls) {
    id.parse(call.id); const work = (await read(`requests/${call.id}/work.json`)).work, raw = await read(`requests/${call.id}/response.json`);
    if (work.id !== call.id || raw.requestId !== call.id || raw.requestHash !== call.requestHash || hashContent(raw.response) !== call.responseHash
      || boundedRequest({ ...work, reservedUsd: call.reservedUsd }).requestHash !== call.requestHash) throw Error('Every paid outcome must retain its exact work, raw response and cost binding.');
    requests.set(call.id, { work, raw, call });
  }
  // Bind complete request histories, including saved failures, review results and revisions.
  for (const path of await walk(join(output, 'requests'))) sourcePaths.add(path);
  for (const path of await walk(join(output, 'editorial-overlays'))) sourcePaths.add(path);
  let originals, providerVerdicts = [], allowedDrafts = new Map();
  const allowDraft = unit => { const names = allowedDrafts.get(unit.id) ?? new Set(); names.add(`${hashContent(unit)}.json`); allowedDrafts.set(unit.id, names); };
  if (options.operation === 'first-five-overlay') {
    const checked = await inspectEditorialOverlay(output, config.pilotRepair, config.pilotEditorial, { requirePersisted: true });
    originals = checked.units; checked.units.forEach(allowDraft); checked.originalUnits.forEach(allowDraft);
    const bindings = proposal.sourceBindings;
    if (!bindings?.paidLineage || bindings.paidLineage.length !== 3 || bindings.storeSnapshotSha256 !== hashContent(state)
      || bindings.ledgerSnapshotSha256 !== hashContent({ ...ledger, calls: ledger.calls.slice(0, 6) })) throw Error('Historical six-call proposal baseline no longer matches the preserved ledger prefix.');
    const verifyRefs = async value => {
      if (!value || typeof value !== 'object') return;
      if (value.file) { const path = await inside(output, value.file); sourcePaths.add(path); const actual = await binding(path);
        if (actual.byteSha256 !== value.byteSha256 || actual.contentSha256 !== value.contentSha256) throw Error('Exact source file binding changed.'); return; }
      for (const child of Object.values(value)) await verifyRefs(child);
    };
    await verifyRefs(bindings);
    for (const lineage of bindings.paidLineage) {
      const saved = requests.get(lineage.requestId);
      if (!saved || hashContent(saved.call) !== lineage.callSha256 || saved.call.actualUsd !== lineage.actualUsd || hashContent(saved.work) !== lineage.workSha256) throw Error('Original paid lineage changed.');
    }
    const generated = requests.get(bindings.paidLineage[0].requestId);
    parseVersionedGeneration(generated.raw.response, generated.work).forEach(allowDraft);
    const final = requests.get(proposal.rows[0].sourceFinalPaidReviewRequestId);
    if (!final || final.work.stage !== 'review') throw Error('Final paid review evidence is required.');
    checkedVersionedWork(final.work); same(final.work.units, originals, 'Paid review must inspect the exact current editorial cards.');
    const parsed = parseVersionedReview(final.raw.response, final.work, final.raw.savedAt);
    const savedResult = await read(`requests/${final.call.id}/review-result.json`);
    same(savedResult, parsed.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })), 'Saved paid-review results changed.');
    providerVerdicts = parsed.map(item => item.receipt);
    if (providerVerdicts.some(item => item.approved || !item.issues.length)) throw Error('Expected original held provider verdicts must remain intact.');
    const adjudication = await read(bindings.adjudication.file);
    // The historical adjudication decoder used work.createdAt; the persisted result used raw.savedAt.
    // Bind each exact historical representation without discarding either timestamp.
    same(adjudication.providerVerdicts.map(({ lemma, ...receipt }) => receipt), parseVersionedReview(final.raw.response, final.work).map(item => item.receipt), 'Adjudication must preserve every original paid verdict.');
    for (const row of proposal.rows) {
      await verifyRefs(row.sourceDraft); const seed = state.pilot.seeds.find(item => item.id === row.unitId);
      if (row.seedSha256 !== hashContent(seed) || row.currentOverlayId !== checked.record.id || row.sourceFinalPaidReviewRequestId !== final.call.id
        || row.sourceFinalPaidReviewWorkSha256 !== hashContent(final.work) || row.sourceFinalPaidReviewRawSha256 !== hashContent(final.raw)
        || row.sourceReviewFile !== bindings.adjudication.file || row.sourceReviewSha256 !== hashContent(adjudication)
        || row.sourceDraft.file !== `drafts/${row.unitId}/${row.beforeContentSha256}.json`) throw Error('A row differs from its current overlay and final-review evidence.');
    }
    const permitted = new Set(bindings.paidLineage.map(item => item.requestId));
    if (ledger.calls.some(call => !permitted.has(call.id) && call.unitIds?.some(unitId => proposal.rows.some(row => row.unitId === unitId)))) throw Error('A newer paid revision exists for a recovery target.');
  } else if (options.operation === 'v5-one-phrase') {
    nativeRecoveryProposalSchema.parse(proposal); if (proposal.rows.length !== 1) throw Error('Only one v5 feedback correction is authorized.');
    const row = proposal.rows[0], saved = requests.get(row.sourceRequestId);
    if (!saved || saved.call.stage !== 'generation' || saved.call.repairOf || saved.work.promptVersion !== 'v5') throw Error('Exact original v5 generation required.');
    checkedWorkV5(saved.work); originals = parseGeneratedV5(saved.raw.response, saved.work); originals.forEach(allowDraft);
    if (hashContent(saved.work) !== row.sourceWorkSha256 || hashContent(saved.raw) !== row.sourceRawSha256) throw Error('V5 original work/raw hash changed.');
    const held = await read(row.sourceReviewFile);
    if (hashContent(held) !== row.sourceReviewSha256 || held.sourceRequestId !== row.sourceRequestId || held.workSha256 !== row.sourceWorkSha256 || held.rawSha256 !== row.sourceRawSha256
      || held.verdicts?.length !== 1 || held.verdicts[0].unitId !== row.unitId || held.verdicts[0].contentSha256 !== row.beforeContentSha256 || held.verdicts[0].approved !== false || !held.verdicts[0].issues?.length
      || held.reviewedBy === originals[0].provenance.author) throw Error('Preserve the exact independent held v5 verdict.');
    providerVerdicts = [{ ...held.verdicts[0], reviewer: held.reviewedBy, reviewedAt: held.reviewedAt }];
    if (ledger.calls.some(call => call.id !== row.sourceRequestId && call.unitIds?.includes(row.unitId))) throw Error('A later paid v5 request cannot be discarded.');
  } else throw Error('Unknown recovery operation.');
  const plan = planOverlaidRecovery({ ...options, proposal, review, state, ledger, originals, providerVerdicts });
  for (const row of plan.rows) {
    const directory = join(output, 'drafts', row.unit.id), allowed = allowedDrafts.get(row.unit.id);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (oldIntent && name === `${hashContent(row.unit)}.json` && !allowed.has(name)) { same(await readJson(await inside(output, path)), { unit: row.unit, contentSha256: hashContent(row.unit) }, 'Interrupted draft differs.'); continue; }
      if (!allowed.has(name)) throw Error('An unrecognized draft revision exists; obsolete recovery is prohibited.');
      sourcePaths.add(await inside(output, path));
    }
    const draft = await read(`drafts/${row.unit.id}/${row.beforeContentSha256}.json`);
    same(draft, { unit: originals.find(unit => unit.id === row.unit.id), contentSha256: row.beforeContentSha256 }, 'Current durable draft changed.');
  }
  const existingApproved = [];
  for (const path of await walk(join(output, 'approved'))) {
    const item = plan.rows.find(row => path === join(output, 'approved', `${row.unit.id}.json`));
    if (item) { if (!oldIntent) throw Error('A target already has an approved revision.'); same(await readJson(path), item.approved, 'Approved target differs from interrupted recovery.'); }
    else existingApproved.push(await binding(path));
  }
  if (existingApproved.length < 5) throw Error('The existing five approved assets must remain present.');
  const configPath = join(options.runtimeDirectory, 'shared-spending-integration.json'); sourcePaths.add(configPath);
  const sources = await Promise.all([...sourcePaths].sort().map(binding));
  const codePaths = (await walk(join(root, 'scripts/english-expansion'))).filter(path => path.endsWith('.mjs'));
  codePaths.push(join(root, 'scripts/shared-spending-fence.mjs'));
  const code = await Promise.all(codePaths.sort().map(binding));
  return { plan, sources, code, existingApproved, proposal, review };
}

function authorityFrom(options, inspected) {
  return overlaidRecoveryAuthoritySchema.parse({ schemaVersion: 1, kind: 'offline-reviewed-recovery-authority', id: options.id, operation: options.operation,
    approved: false, reviewedBy: null, reviewedAt: null, output: options.output, runtimeDirectory: options.runtimeDirectory, proposalPath: options.proposalPath, reviewPath: options.reviewPath,
    proposalSha256: hashContent(inspected.proposal), reviewSha256: hashContent(inspected.review), planSha256: hashContent(inspected.plan),
    sources: inspected.sources, code: inspected.code, existingApproved: inspected.existingApproved, paidCallCount: 7, paidCalls: 0, publicPublication: false, scaleAuthorized: false });
}
async function locked(options, action) {
  await stopped(options);
  return withExpansionLock({ output: options.output, sharedLockDirectory: join(options.runtimeDirectory, 'shared-spending.lock') }, action);
}
/** Read-only preparation: returned authority is deliberately non-executable. Caller may save it outside the store. */
export async function prepareOverlaidRecovery(options) {
  id.parse(options.id);
  return locked(options, async () => authorityFrom(options, await inspect(options)));
}

export async function recoverOverlaidUnits({ authorityPath, write = false }) {
  await exactPath(authorityPath); const authority = overlaidRecoveryAuthoritySchema.parse(await readJson(authorityPath));
  if (!authority.approved || authority.reviewedBy !== '/root' || !authority.reviewedAt) throw Error('Exact root application authority is required; preparation drafts cannot execute.');
  return locked(authority, async lease => {
    const directory = join(authority.output, 'offline-reviewed-recoveries', authority.id), intentPath = join(directory, 'intent.json');
    if (await exists(directory)) await exactPath(directory);
    const oldIntent = await readOptionalJson(intentPath), inspected = await inspect(authority, oldIntent);
    const expected = authorityFrom(authority, inspected);
    same({ ...authority, approved: false, reviewedBy: null, reviewedAt: null }, expected, 'Exact root authority baseline changed (source, code, ledger, hold or approved assets).');
    const intent = { schemaVersion: 1, kind: 'offline-reviewed-recovery', authoritySha256: hashContent(authority), planSha256: hashContent(inspected.plan),
      units: inspected.plan.rows.map(row => ({ unitId: row.unit.id, contentSha256: hashContent(row.unit), approvedSha256: hashContent(row.approved) })), paidCalls: 0, publicPublication: false, scaleAuthorized: false };
    if (oldIntent) same(oldIntent, intent, 'Interrupted recovery has different authority or content.');
    const receipt = await readOptionalJson(join(directory, 'receipt.json'));
    if (receipt) { if (!oldIntent) throw Error('Completed receipt lacks its durable intent.'); same(receipt, { ...intent, completed: true }, 'Completed receipt changed.'); }
    const evidence = { authority, proposal: inspected.proposal, review: inspected.review, plan: inspected.plan };
    if (oldIntent) same(await readJson(join(directory, 'evidence.json')), evidence, 'Durable provenance evidence changed.');
    for (const row of inspected.plan.rows) {
      const reviewed = await readOptionalJson(join(authority.output, 'reviews', row.unit.id, `${hashContent(row.unit)}.json`));
      if (reviewed && (!oldIntent || hashContent(reviewed) !== hashContent(row.receipt))) throw Error('Existing full-card review conflicts with this operation.');
      if (receipt && !await exists(join(authority.output, 'approved', `${row.unit.id}.json`))) throw Error('Completed recovery is missing an approved asset.');
    }
    if (write) {
      // Recheck immediately before the first mutation. Neither ledger nor source files is ever written.
      same(authorityFrom(authority, await inspect(authority, oldIntent)), expected, 'Stopped baseline changed before durable intent.');
      await immutable(join(directory, 'evidence.json'), evidence);
      await immutable(intentPath, intent);
      for (const row of inspected.plan.rows) {
        const draftPath = join(authority.output, 'drafts', row.unit.id, `${hashContent(row.unit)}.json`);
        if (!await exists(draftPath)) await persistDraft(lease, row.unit);
        else same(await readJson(draftPath), { unit: row.unit, contentSha256: hashContent(row.unit) }, 'Existing final draft changed.');
        await publishReviewedUnit(lease, row.unit, row.receipt);
      }
      // Verify unchanged source bytes and existing approvals, allowing only exact planned new assets.
      same(authorityFrom(authority, await inspect(authority, intent)), expected, 'Preserved evidence changed during offline recovery.');
      await immutable(join(directory, 'receipt.json'), { ...intent, completed: true });
    }
    return { operationId: authority.id, operation: authority.operation, mode: write ? 'written-private-only' : 'dry-run', units: intent.units,
      replayed: Boolean(oldIntent), paidCalls: 0, publicPublication: false, scaleAuthorized: false };
  });
}
