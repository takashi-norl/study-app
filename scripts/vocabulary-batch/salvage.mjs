import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson } from './storage.mjs';
import { hashVocabularyEntry, materializeEntry, validateGeneratedBatch } from './schema.mjs';

/** Extract only fully closed JSON entry objects. Never repair or guess a cut token/string. */
export function completeEntryPrefix(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid bounded response text.');
  const prefix = /^\s*\{\s*"entries"\s*:\s*\[/.exec(text);
  if (!prefix) throw new Error('Response is not an entries array JSON prefix.');
  const entries = []; let position = prefix[0].length;
  const skipSpace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  while (position < text.length && entries.length < 10) {
    skipSpace(); if (text[position] === ']' || position >= text.length) break;
    if (text[position] !== '{') throw new Error('Unexpected token between complete entries.');
    const start = position, stack = []; let inString = false, escaped = false, complete = false;
    for (; position < text.length; position++) {
      const character = text[position];
      if (inString) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') inString = false; continue; }
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      if (character === '}' || character === ']') {
        const open = stack.pop();
        if (open !== (character === '}' ? '{' : '[')) throw new Error('Mismatched brackets in response prefix.');
        if (!stack.length) { position++; entries.push(JSON.parse(text.slice(start, position))); complete = true; break; }
      }
    }
    if (!complete) break;
    skipSpace();
    if (text[position] === ',') { position++; continue; }
    if (text[position] === ']' || position >= text.length) break;
    throw new Error('Unexpected separator after a complete entry.');
  }
  return entries;
}

/** Offline only. A salvaged card is still a draft and must pass the separate AI reviewer. */
export async function salvageResponses(output) {
  const manifestPath = join(output, 'manifest.json'), state = await readJson(manifestPath);
  const ledger = await readJson(join(output, 'ledger.json'), { calls: [] });
  const summaries = [];
  for (const file of (await readdir(join(output, 'raw'))).filter(name => name.startsWith('generate-') && name.endsWith('.json')).sort()) {
    const raw = await readJson(join(output, 'raw', file));
    if (raw.response?.stop_reason !== 'max_tokens') continue;
    if (state.salvage?.[raw.id]) { summaries.push(state.salvage[raw.id]); continue; }
    const receipt = ledger.calls.find(item => item.id === raw.id);
    if (!receipt || receipt.status !== 'complete' || receipt.requestHash !== raw.requestHash) throw new Error('Cannot salvage an unconfirmed provider receipt.');
    const originalBatchId = raw.id.slice('generate-'.length);
    const seeds = state.words.filter(item => !item.frozen && item.batchId === originalBatchId && item.status === 'rejected');
    if (!seeds.length) continue;
    const text = raw.response.content.filter(item => item.type === 'text').map(item => item.text).join('');
    const extracted = completeEntryPrefix(text), valid = [], invalid = [];
    const seen = new Set();
    for (const candidate of extracted) {
      const seed = seeds.find(item => item.word === candidate?.word);
      if (!seed || seen.has(seed.id)) { invalid.push({ word: candidate?.word ?? null, issue: 'Unexpected or duplicate complete entry.' }); continue; }
      seen.add(seed.id);
      const index = state.words.findIndex(item => item.id === seed.id);
      try {
        const [checked] = validateGeneratedBatch({ entries: [candidate] }, [{ ...seed, preferredIpaLabel: index % 2 ? '英音' : '米音' }]);
        valid.push({ seed, entry: materializeEntry(checked, seed, index) });
      } catch (error) { invalid.push({ word: seed.word, issue: error.name === 'ZodError' ? 'Complete entry did not pass the required structure.' : String(error.message).slice(0, 500) }); }
    }
    for (let start = 0; start < valid.length; start += 5) {
      const group = valid.slice(start, start + 5), grade = group[0].seed.grade;
      const batchId = `${grade}-saved-${hashVocabularyEntry({ originalRequestId: raw.id, ids: group.map(item => item.seed.id) }).slice(0, 20)}-r0`;
      await atomicJson(join(output, 'drafts', `${batchId}.json`), { schemaVersion: 1, batchId, entries: group.map(item => item.entry), generatedBy: raw.response.model, generatedRequestId: raw.id, salvagedFrom: originalBatchId });
      for (const { seed } of group) { seed.status = 'salvaged'; seed.salvageBatchId = batchId; }
    }
    const summary = { requestId: raw.id, completeObjects: extracted.length, salvaged: valid.length, invalid, missingOrInvalid: seeds.filter(seed => seed.status !== 'salvaged').map(seed => seed.word) };
    state.salvage ??= {}; state.salvage[raw.id] = summary;
    state.updatedAt = new Date().toISOString(); await atomicJson(manifestPath, state);
    summaries.push(summary);
  }
  return summaries;
}
