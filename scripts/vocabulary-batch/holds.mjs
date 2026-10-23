import { hashVocabularyEntry } from './schema.mjs';

export const isBaseCandidate = word => !word.inventoryHold;
export const baseCount = (words, grade) => words.filter(word => isBaseCandidate(word) && (!grade || word.grade === grade)).length;

/** Preserve indices, original seeds and paid groups. A hold never deletes a receipt. */
export function applyInventoryHolds(state, decisions, preparedGroups, reviewId) {
  if (!reviewId || !Array.isArray(decisions) || !decisions.length) throw new Error('A reviewed hold decision is required.');
  const byId = new Map(state.words.map(word => [word.id, word]));
  const byWord = new Map(state.words.map(word => [word.word, word]));
  const causes = new Map();
  for (const decision of decisions) {
    const word = byId.get(decision.id);
    if (!word || word.frozen || word.status !== 'inventoried' || !decision.reason || decision.seedHash !== hashVocabularyEntry(word)) throw new Error('Hold decision is stale or would change completed material.');
    if (causes.has(word.id)) throw new Error('Duplicate hold decision.');
    causes.set(word.id, { reason: decision.reason, sourceIds: [word.id] });
  }
  // Close over whole groups, including overlapping historical requests, before any edit.
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of preparedGroups) {
      const members = group.entries.map(entry => byWord.get(entry.word));
      const held = members.filter(member => member && causes.has(member.id));
      if (!held.length) continue;
      for (const member of members) {
        if (!member || member.frozen || member.status !== 'inventoried') throw new Error('Cannot split a paid group or hold an already completed sibling.');
        if (causes.has(member.id)) continue;
        causes.set(member.id, { reason: `Preserve prepared group ${group.batchId}; review held member before further spending.`, sourceIds: held.flatMap(word => causes.get(word.id).sourceIds) });
        changed = true;
      }
    }
  }
  const applied = [];
  for (const [id, cause] of causes) {
    const word = byId.get(id);
    if (word.inventoryHold) throw new Error('An existing hold needs explicit reconciliation.');
    applied.push({ id, seedHash: hashVocabularyEntry(word), ...cause });
  }
  for (const record of applied) byId.get(record.id).inventoryHold = { reviewId, ...record };
  return applied;
}

/** Also fence requests prepared before a hold, before token counting or submission. */
export function requestTouchesHeldInventory(request, words) {
  const held = new Set(words.filter(word => !isBaseCandidate(word)).map(word => word.word));
  if (!held.size) return false;
  const message = request.params?.messages?.find(message => message.role === 'user');
  let entries;
  try { entries = JSON.parse(message.content).entries; } catch { throw new Error('Cannot check held inventory against malformed prepared request.'); }
  if (!Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry.word !== 'string')) throw new Error('Cannot verify prepared request inventory.');
  return entries.some(entry => held.has(entry.word));
}
