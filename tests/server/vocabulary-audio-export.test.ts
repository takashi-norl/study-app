import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportVocabularyAudioBundles } from '../../scripts/vocabulary-audio-export-lib';
import { vocabularyImportBundleSchema } from '../../src/lib/vocabulary-import';
import { vocabularyEntries } from '../../src/server/vocabulary-catalog';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';

test('export splits verified audio into small importer-compatible bundles, reuses exact files, and rejects corrupt MP3s', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hibi-audio-export-'));
  try {
    const entries = Array.from({ length: 11 }, (_, index) => ({ ...structuredClone(vocabularyEntries[0]), id: `test-new-${index}`, word: `newtestword${index}`, level: '3級' as const, voice: 'female' as const,
      tests: (['meaning', 'word', 'context', 'usage'] as const).map(mode => ({ mode, prompt: 'Choose the best answer.', choices: ['first', 'second', 'third', 'fourth'].map((text, i) => ({ text, meaning: `意味${i}` })), correctIndex: 0, explanation: 'The first option matches.', alternatives: [] })) }));
    const bytes = Buffer.from([73, 68, 51, 4, 0, 0, 0]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const audioDirectory = path.join(temporary, 'audio');
    for (const entry of entries) {
      const spec = vocabularyAudioSpec(entry), directory = path.join(audioDirectory, 'assets', spec.cacheKey);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'audio.mp3'), bytes);
      await writeFile(path.join(directory, 'asset.json'), JSON.stringify({ wordId: entry.id, cacheKey: spec.cacheKey, voiceId: spec.voiceId, mp3Sha256: sha256,
        segments: ['word', 'example-1', 'example-2', 'example-3'].map((id, index) => ({ id, startSeconds: index, endSeconds: index + 1 })) }));
    }
    const catalog = path.join(temporary, 'catalog.json');
    await writeFile(catalog, JSON.stringify({ schemaVersion: 2, entries, audio: [] }));
    const options = { catalog, audioDirectory, batchId: 'grade3-001', output: path.join(temporary, 'exports') };
    const first = await exportVocabularyAudioBundles(options);
    assert.equal(first.clips, 11); assert.equal(first.files.length, 2);
    const counts = [];
    for (const file of first.files) {
      const bundle = vocabularyImportBundleSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      assert.equal(bundle.batchId, 'grade3-001'); counts.push(bundle.clips.length);
    }
    assert.deepEqual(counts, [10, 1]);
    assert.deepEqual(await exportVocabularyAudioBundles(options), first);
    await writeFile(path.join(audioDirectory, 'assets', vocabularyAudioSpec(entries[0]).cacheKey, 'audio.mp3'), 'corrupted');
    await assert.rejects(() => exportVocabularyAudioBundles(options), /integrity check/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
