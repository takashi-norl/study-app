import { join } from 'node:path';
import { baseCount } from './holds.mjs';
import { readJson } from './storage.mjs';
import { GRADES, normalizeLemma, validInventoryCandidates } from './schema.mjs';
import { responseCost, structuredResult } from './provider.mjs';

export const MIN_INVENTORY_CHUNK = 10;
export const MAX_INVENTORY_CHUNK = 100;

/** Read fully closed objects only. Never complete a cut string, field, or object. */
export function completeInventoryPrefix(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid bounded inventory response text.');
  const prefix = /^\s*\{\s*"words"\s*:\s*\[/.exec(text);
  if (!prefix) throw new Error('Response is not a words array JSON prefix.');
  const words = []; let position = prefix[0].length;
  const skipSpace = () => { while (position < text.length && /\s/.test(text[position])) position++; };
  while (position < text.length && words.length < 200) {
    skipSpace();
    if (text[position] === ']' || position >= text.length) break;
    if (text[position] !== '{') throw new Error('Unexpected token between complete inventory words.');
    const start = position, stack = []; let inString = false, escaped = false, complete = false;
    for (; position < text.length; position++) {
      const character = text[position];
      if (inString) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') inString = false; continue; }
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      if (character === '}' || character === ']') {
        if (stack.pop() !== (character === '}' ? '{' : '[')) throw new Error('Mismatched brackets in inventory response prefix.');
        if (!stack.length) { position++; words.push(JSON.parse(text.slice(start, position))); complete = true; break; }
      }
    }
    if (!complete) break;
    skipSpace();
    if (text[position] === ',') { position++; continue; }
    if (text[position] === ']' || position >= text.length) break;
    throw new Error('Unexpected separator after a complete inventory word.');
  }
  return words;
}

/** Offline receipt recovery. Charges and raw evidence are never rewritten here. */
export async function savedInventoryResult(output, requestId) {
  if (!/^inventory-(?:grade3|pre2|grade2|pre1)-\d{4,}$/.test(requestId)) throw new Error('Invalid inventory request identity.');
  const raw = await readJson(join(output, 'raw', `${requestId}.json`), null);
  const ledger = await readJson(join(output, 'ledger.json'), { calls: [] });
  const receipt = ledger.calls.find(item => item.id === requestId);
  if (!raw && !receipt) return null;
  if (!raw || !receipt || receipt.status !== 'complete' || raw.id !== requestId || raw.requestHash !== receipt.requestHash || !/^[a-f0-9]{64}$/.test(raw.requestHash ?? '')) throw new Error('Inventory receipt is unresolved or mismatched. No replay or further paid request is allowed.');
  const actualUsd = responseCost(raw.response);
  if (receipt.model !== raw.response.model || !Number.isFinite(receipt.actualUsd) || !Number.isFinite(receipt.reservedUsd) || Math.abs(receipt.actualUsd - actualUsd) > 1e-9 || actualUsd > receipt.reservedUsd + 1e-9) throw new Error('Inventory receipt pricing does not match the saved response.');
  const truncated = raw.response.stop_reason === 'max_tokens';
  let value;
  if (truncated) {
    const block = raw.response.content.find(item => item.type === 'tool_use' && item.name === 'inventory_words');
    const text = raw.response.content.filter(item => item.type === 'text').map(item => item.text).join('');
    value = block ? block.input : { words: text.trim() ? completeInventoryPrefix(text) : [] };
  } else value = structuredResult(raw.response, 'inventory_words');
  if (!value || !Array.isArray(value.words)) throw new Error('Saved inventory response has no usable words array.');
  return { value, requestHash: raw.requestHash, truncated, completeObjects: value.words.length };
}

export function inventoryChunkSize(state, grade) {
  const size = state.inventoryChunkSizes?.[grade] ?? MAX_INVENTORY_CHUNK;
  if (!GRADES[grade] || !Number.isInteger(size) || size < MIN_INVENTORY_CHUNK || size > MAX_INVENTORY_CHUNK) throw new Error('Invalid saved inventory chunk size.');
  return size;
}

/** The caller writes this whole checkpoint atomically while holding the output lock. */
export function applyInventoryRound(state, { grade, round, needed, requestId, result, domainIds }) {
  if (!GRADES[grade] || round !== (state.inventoryRounds[grade] ?? 0) || requestId !== `inventory-${grade}-${String(round).padStart(4, '0')}` || state.inventoryReceipts?.[requestId]) throw new Error('Inventory round was already consumed or has a mismatched identity.');
  const remaining = GRADES[grade].target - baseCount(state.words, grade);
  if (!Number.isInteger(needed) || needed < 1 || needed > Math.min(inventoryChunkSize(state, grade), remaining)) throw new Error('Inventory round exceeds its remaining target or chunk bound.');
  const known = new Set(state.words.map(item => normalizeLemma(item.word)));
  const ids = new Set(state.words.map(item => item.id));
  const canonical = new Set(domainIds);
  if (!canonical.size) throw new Error('Canonical inventory domain IDs are required.');
  // Filter before the requested limit so malformed tags cannot displace later valid words.
  const words = result.value.words.slice(0, 200).filter(item => Array.isArray(item?.domains) && item.domains.every(domain => canonical.has(domain)));
  const candidates = validInventoryCandidates({ words }, needed, known);
  const accepted = candidates.filter(word => !ids.has(`vocab-${normalizeLemma(word.word)}`));
  for (const word of accepted) state.words.push({ ...word, id: `vocab-${normalizeLemma(word.word)}`, grade, frozen: false, status: 'inventoried' });
  const currentSize = inventoryChunkSize(state, grade);
  const nextChunkSize = result.truncated ? Math.min(currentSize, Math.max(MIN_INVENTORY_CHUNK, Math.floor(needed / 2))) : currentSize;
  state.inventoryChunkSizes ??= {}; state.inventoryChunkSizes[grade] = nextChunkSize;
  state.inventoryRounds[grade] = round + 1;
  const summary = { requestId, requestHash: result.requestHash, truncated: result.truncated, completeObjects: result.completeObjects, requested: needed, added: accepted.length, addedIds: accepted.map(word => `vocab-${normalizeLemma(word.word)}`), nextChunkSize, consumedAt: new Date().toISOString() };
  state.inventoryReceipts ??= {}; state.inventoryReceipts[requestId] = summary;
  return summary;
}
