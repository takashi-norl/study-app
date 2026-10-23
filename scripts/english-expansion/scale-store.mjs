import { randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, rename, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertLease, readJson, readOptionalJson } from './store.mjs';
import { approveUnit, canonicalJson, hashContent, validateSeed, validateUnit } from './schema.mjs';
import { classifyCandidates, createRegistry } from './registry.mjs';

export const safeScaleId = id => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? '')) throw new Error('Unsafe scale identity.'); return id; };
export async function scaleJson(lease, relative, value, immutable = true) {
  await assertLease(lease, lease.output);
  if (!relative || relative.split('/').some(part => !part || part === '..' || part === '.') || relative.startsWith('/')) throw new Error('Unsafe scale evidence path.');
  const file = join(lease.output, relative); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${canonicalJson(value)}\n`, temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    if (immutable) {
      try { await link(temp, file); } catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw new Error('Immutable scale evidence changed.'); }
      await unlink(temp);
    } else await rename(temp, file);
    const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { try { await unlink(temp); } catch { /* original error */ } throw error; }
  return value;
}
export async function scaleNames(output, relative) {
  try { return (await readdir(join(output, relative))).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function loadScaleState(lease, approvalSha256) {
  await assertLease(lease, lease.output);
  const state = await readOptionalJson(join(lease.output, 'scale/state.json'));
  if (!state) {
    if ((await scaleNames(lease.output, 'scale/waves')).length || (await scaleNames(lease.output, 'scale/inventory')).length) throw new Error('Scale state is missing but durable history exists.');
    return null;
  }
  if (state.schemaVersion !== 1 || state.approvalSha256 !== approvalSha256 || !Array.isArray(state.sources) || !Array.isArray(state.seeds) || !Array.isArray(state.waves)
    || new Set(state.seeds.map(seed => seed.id)).size !== state.seeds.length || new Set(state.sources).size !== state.sources.length || new Set(state.waves).size !== state.waves.length) throw new Error('Scale state or approval identity changed.');
  const sources = await scaleNames(lease.output, 'scale/inventory'), waves = await scaleNames(lease.output, 'scale/waves');
  if (hashContent(sources) !== hashContent([...state.sources].sort()) || hashContent(waves) !== hashContent([...state.waves].sort())) throw new Error('Scale state omits immutable source or wave evidence; reconcile the interrupted checkpoint.');
  const expected = [];
  for (const id of state.sources) {
    const record = await readJson(join(lease.output, 'scale/inventory', safeScaleId(id), 'receipt.json'));
    if (record.sourceSha256 !== hashContent(record.source) || record.reviewSha256 !== hashContent(record.review)) throw new Error('Saved scale inventory evidence changed.');
    expected.push(...validateScaleInventory(record.source, record.review));
  }
  if (hashContent(expected) !== hashContent(state.seeds)) throw new Error('Scale inventory differs from its exact independent review.');
  return state;
}
export async function initializeScaleState(lease, { approvalSha256, phaseOneFingerprint }) {
  const old = await loadScaleState(lease, approvalSha256); if (old) { if (old.phaseOneFingerprint !== phaseOneFingerprint) throw new Error('Scale baseline changed.'); return old; }
  const pilot = await readJson(join(lease.output, 'store.json'));
  if (pilot.phaseOneFingerprint !== phaseOneFingerprint || !await readOptionalJson(join(lease.output, 'ledger.json'))) throw new Error('Complete pilot spending history is required.');
  const state = { schemaVersion: 1, approvalSha256, phaseOneFingerprint, createdAt: new Date().toISOString(), sources: [], seeds: [], waves: [] };
  await scaleJson(lease, 'scale/state.json', state); return state;
}
export function validateScaleInventory(source, review) {
  safeScaleId(source?.id);
  if (source.schemaVersion !== 1 || typeof source.createdBy !== 'string' || !source.createdBy.trim() || !Array.isArray(source.seeds) || !source.seeds.length || source.seeds.length > 1000) throw new Error('A reviewed inventory source must contain 1–1,000 seeds.');
  const seeds = source.seeds.map(validateSeed);
  if (review?.schemaVersion !== 1 || review.sourceSha256 !== hashContent(source) || typeof review.reviewedBy !== 'string' || !review.reviewedBy.trim()
    || review.reviewedBy.trim().toLowerCase() === source.createdBy.trim().toLowerCase() || !Number.isFinite(Date.parse(review.reviewedAt))
    || !Array.isArray(review.verdicts) || review.verdicts.length !== seeds.length || new Set(review.verdicts.map(row => row.id)).size !== seeds.length
    || review.verdicts.some(row => !seeds.some(seed => seed.id === row.id) || row.approved !== true || !Array.isArray(row.issues) || row.issues.length)) throw new Error('Every inventory seed needs exact-source independent approval.');
  return seeds;
}
export function appendOwnRegistry(registry, seeds) {
  const own = createRegistry({ ownInventory: seeds }), next = { ...registry, units: new Map(registry.units), forms: new Map([...registry.forms].map(([form, ids]) => [form, new Set(ids)])) };
  for (const [id, unit] of own.units) next.units.set(id, unit);
  for (const [form, ids] of own.forms) next.forms.set(form, new Set([...(next.forms.get(form) ?? []), ...ids]));
  return next;
}
export async function importScaleInventory(lease, state, { source, review }, registry, pilotSeeds, maxAdditionalUnits) {
  const seeds = validateScaleInventory(source, review), file = `scale/inventory/${source.id}/receipt.json`;
  const previous = await readOptionalJson(join(lease.output, file));
  const record = { schemaVersion: 1, source, review, sourceSha256: hashContent(source), reviewSha256: hashContent(review) };
  if (previous) { if (!state.sources.includes(source.id) || hashContent(previous) !== hashContent(record)) throw new Error('Inventory replay differs or has interrupted unindexed evidence.'); return state; }
  if (state.seeds.length + seeds.length > maxAdditionalUnits || classifyCandidates(appendOwnRegistry(registry, [...pilotSeeds, ...state.seeds]), seeds).accepted.length !== seeds.length) throw new Error('Inventory exceeds scale authority or overlaps retained lexical forms.');
  await scaleJson(lease, file, record);
  const next = { ...state, sources: [...state.sources, source.id], seeds: [...state.seeds, ...seeds] };
  await scaleJson(lease, 'scale/state.json', next, false); return next;
}
export async function registerScaleWave(lease, state, plan) {
  safeScaleId(plan.id);
  if (state.waves.includes(plan.id)) throw new Error('Wave identity already registered; never submit it again.');
  await scaleJson(lease, `scale/waves/${plan.id}/plan.json`, plan);
  const next = { ...state, waves: [...state.waves, plan.id] }; await scaleJson(lease, 'scale/state.json', next, false); return next;
}
export async function saveScaleDraft(lease, state, raw) {
  const unit = validateUnit(raw), seed = state.seeds.find(row => row.id === unit.id);
  if (!seed || Object.keys(seed).some(key => canonicalJson(seed[key]) !== canonicalJson(unit[key]))) throw new Error('Scale draft differs from its reviewed seed.');
  return scaleJson(lease, `drafts/${unit.id}/${hashContent(unit)}.json`, { unit, contentSha256: hashContent(unit) });
}
export async function saveScaleApproval(lease, unit, receipt) {
  const approved = approveUnit(unit, receipt), digest = hashContent(approved.unit), saved = await readJson(join(lease.output, `drafts/${unit.id}/${digest}.json`));
  if (hashContent(saved.unit) !== digest || saved.contentSha256 !== digest || approved.unit.senses.some(sense => sense.relations.length)) throw new Error('Scale publication needs its exact saved draft and no unresolved external sense links.');
  await scaleJson(lease, `reviews/${unit.id}/${digest}.json`, receipt);
  await scaleJson(lease, `approved/${unit.id}.json`, approved); return approved;
}
