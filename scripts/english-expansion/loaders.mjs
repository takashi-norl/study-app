import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRegistry } from './registry.mjs';
import { loadAudioReservations } from './audio-adapter.mjs';
import { assertDispositionContent, dispositionFor, isPublicCandidate } from '../vocabulary-batch/catalog-policy.mjs';
import { hashContent } from './schema.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function records(directory) {
  const names = await readdir(directory);
  return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => json(join(directory, name))));
}
export async function loadBudgetSnapshot({ phaseOneOutput, expansionLedgerPath, allowNewExpansion = false, cashPurchases = [], lifecycle = {} }) {
  // Missing phase-one ledgers are fatal. A new expansion ledger must be explicit.
  const phaseOneText = await json(join(phaseOneOutput, 'ledger.json'));
  const phaseOneAudioReservations = await loadAudioReservations(join(phaseOneOutput, 'audio'));
  let expansion;
  try { expansion = await json(expansionLedgerPath); }
  catch (error) { if (error.code !== 'ENOENT' || !allowNewExpansion) throw error; expansion = { schemaVersion: 1, calls: [] }; }
  return { phaseOneText, phaseOneAudioReservations, expansion, cashPurchases, lifecycle };
}
export async function loadRegistry({ phaseOneOutput, ownInventory = [] }) {
  const approvedBatches = [], retainedEntries = [], manifest = await json(join(phaseOneOutput, 'manifest.json'));
  const seeds = new Map(manifest.words.map(word => [word.id, word]));
  const seen = new Set();
  for (const directory of await readdir(join(phaseOneOutput, 'approved'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const batch of await records(join(phaseOneOutput, 'approved', directory.name))) {
      if (batch.schemaVersion !== 1 || !Array.isArray(batch.entries)) throw new Error('Expected version-one approved base batches.');
      const entries = [];
      for (const row of batch.entries) {
        if (row.review?.status !== 'approved' || hashContent(row.entry) !== row.review.contentSha256) throw new Error('Base catalog content is not hash-bound to approval.');
        const seed = seeds.get(row.entry.id);
        if (!seed || seed.status !== 'approved' || (seed.batchId && seed.batchId !== batch.batchId)) throw new Error('Approved catalog differs from its manifest identity.');
        const disposition = assertDispositionContent(seed, row); seen.add(seed.id);
        if (isPublicCandidate(seed)) entries.push(row);
        else retainedEntries.push({ entry: row.entry, source: disposition ? 'retained-excluded' : 'quarantined' });
      }
      approvedBatches.push({ ...batch, entries });
    }
  }
  for (const seed of manifest.words) {
    const disposition = dispositionFor(seed);
    if (seed.status === 'approved' && !seen.has(seed.id)) throw new Error('Manifest approved asset is missing.');
    if (disposition && seed.status === 'rejected') {
      const batch = await json(join(phaseOneOutput, 'rejected', `${seed.batchId}.json`));
      const row = batch.entries.find(item => item.entry?.id === seed.id);
      if (!row) throw new Error('Excluded rejected asset is missing.');
      assertDispositionContent(seed, row);
      // Canonical replacements are reserved too; reuse needs deliberate review, not paid duplicates.
      retainedEntries.push({ entry: { ...row.entry, aliases: [...(seed.aliases ?? []), ...(row.entry.aliases ?? []), ...(disposition.canonicalLemma ? [disposition.canonicalLemma] : [])] }, source: 'retained-excluded' });
    } else if (seed.inventoryHold && !seen.has(seed.id)) retainedEntries.push({ entry: seed, source: 'quarantined' });
  }
  return createRegistry({ approvedBatches, frozenEntries: await json(join(phaseOneOutput, 'frozen-100.json')), ownInventory, retainedEntries });
}
