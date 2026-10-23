import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './storage.mjs';
import { hashVocabularyEntry } from './schema.mjs';

/** Keep an already prepared group intact when inventory grows during provider work. */
export async function preparedGenerationGroups(output) {
  let names;
  try { names = await readdir(join(output, 'prepared')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const groups = [];
  for (const name of names.filter(name => /^generate-.*-r\d+\.json$/.test(name))) {
    const request = await readJson(join(output, 'prepared', name));
    if (request.id !== name.slice(0, -5) || hashVocabularyEntry(request.params) !== request.requestHash) throw new Error('Prepared generation group failed its request integrity check.');
    const message = request.params.messages.find(message => message.role === 'user');
    const entries = JSON.parse(message.content).entries;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 5 || new Set(entries.map(entry => entry.word)).size !== entries.length) continue;
    groups.push({ batchId: request.id.slice('generate-'.length), attempt: Number(/-r(\d+)$/.exec(request.id)[1]), entries, preparedAt: request.preparedAt });
  }
  return groups.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt) || a.batchId.localeCompare(b.batchId));
}

export function activeGenerationGroups(groups, words, eligible, repairing) {
  const byWord = new Map(words.map(word => [word.word, word]));
  const assigned = new Map();
  for (const group of groups) {
    const seeds = group.entries.map(entry => byWord.get(entry.word));
    if (seeds.some((seed, i) => !seed || seed.frozen || seed.status === 'salvaged' || !eligible(seed) || assigned.has(seed.id)
      || group.attempt !== (repairing ? (seed.attempt ?? 0) + 1 : 0)
      || seed.partOfSpeech !== group.entries[i].partOfSpeech || seed.meaning !== group.entries[i].meaning)
      || new Set(seeds.map(seed => seed.grade)).size !== 1) continue;
    const pinned = { ...group, seeds };
    for (const seed of seeds) assigned.set(seed.id, pinned);
  }
  return assigned;
}
