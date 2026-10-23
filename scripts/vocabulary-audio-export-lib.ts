import { createHash } from 'node:crypto';
import { mkdir, readFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { vocabularyImportBundleSchema, type VocabularyImportClip } from '../src/lib/vocabulary-import';
import { VOCABULARY_LEVELS } from '../src/lib/vocabulary-types';
import { vocabularyAudioSpec } from '../src/server/vocabulary-audio';
import { parseVocabularyBatch } from '../src/server/vocabulary-generated';

/** Exports small private files for authenticated browser import; never contacts a provider. */
export async function exportVocabularyAudioBundles(options: { catalog: string; batchId: string; audioDirectory: string; output: string }) {
  const batchId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).parse(options.batchId);
  if (batchId === 'legacy-100') throw new Error('The original 100-word audio is preserved, not re-imported.');
  const raw = JSON.parse(await readFile(options.catalog, 'utf8'));
  const basic = z.object({ schemaVersion: z.literal(2), entries: z.array(z.object({ level: z.enum(VOCABULARY_LEVELS) })).min(1).max(100) }).parse(raw);
  const { entries } = parseVocabularyBatch(raw, { id: batchId, title: batchId, level: basic.entries[0].level, entryCount: basic.entries.length });
  const clips: VocabularyImportClip[] = [];
  for (const entry of entries) {
    const spec = vocabularyAudioSpec(entry), directory = path.join(options.audioDirectory, 'assets', spec.cacheKey);
    const asset = JSON.parse(await readFile(path.join(directory, 'asset.json'), 'utf8'));
    if (asset.cacheKey !== spec.cacheKey || asset.wordId !== entry.id || asset.voiceId !== spec.voiceId) throw new Error(`Saved audio does not match ${entry.id}.`);
    const file = path.join(directory, 'audio.mp3');
    const size = (await stat(file)).size;
    if (size < 1 || size > 2 * 1024 * 1024) throw new Error(`Saved audio has an invalid size for ${entry.id}.`);
    const bytes = await readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== asset.mp3Sha256) throw new Error(`Saved audio failed its integrity check for ${entry.id}.`);
    clips.push({ wordId: entry.id, cacheKey: spec.cacheKey, segments: asset.segments, audioBase64: bytes.toString('base64'), sha256 });
  }
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  // At most 10 * 2 MiB MP3s => less than 32 MiB including JSON and base64 expansion.
  for (let offset = 0; offset < clips.length; offset += 10) {
    const bundle = vocabularyImportBundleSchema.parse({ schemaVersion: 2, batchId, clips: clips.slice(offset, offset + 10) });
    const file = path.join(options.output, `${batchId}-audio-${String(offset / 10 + 1).padStart(3, '0')}.json`);
    const encoded = `${JSON.stringify(bundle)}\n`;
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== encoded) throw error;
      files.push(file); continue;
    }
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    files.push(file);
  }
  return { batchId, clips: clips.length, files };
}
