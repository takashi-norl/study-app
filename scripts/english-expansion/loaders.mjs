import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRegistry } from './registry.mjs';
import { loadAudioReservations } from './audio-adapter.mjs';

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
  const approvedBatches = [];
  for (const directory of await readdir(join(phaseOneOutput, 'approved'), { withFileTypes: true })) {
    if (directory.isDirectory()) approvedBatches.push(...await records(join(phaseOneOutput, 'approved', directory.name)));
  }
  return createRegistry({ approvedBatches, frozenEntries: await json(join(phaseOneOutput, 'frozen-100.json')), ownInventory });
}
