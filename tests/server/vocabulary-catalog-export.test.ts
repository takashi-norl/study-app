import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashVocabularyEntry } from '../../scripts/vocabulary-batch/schema.mjs';
import { preserveVocabularyAudio } from '../../scripts/vocabulary-catalog-export-lib';
import { vocabularyEntries } from '../../src/server/vocabulary-catalog';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import type { ImportedVocabularyAudio } from '../../src/server/vocabulary-generated';

const original: VocabularyEntry = { ...structuredClone(vocabularyEntries.find(entry => entry.id === 'mitigate')!), id: 'test-mitigate' };
const record: ImportedVocabularyAudio = {
  wordId: original.id, cacheKey: vocabularyAudioSpec(original).cacheKey, fileId: 'private_audio_file', voiceLabel: 'original voice',
  segments: ['word', 'example-1', 'example-2', 'example-3'].map((id, index) => ({ id: id as ImportedVocabularyAudio['segments'][number]['id'], startSeconds: index, endSeconds: index + 1 })),
};

test('repackaging grade/CEFR/domain/test/meaning metadata preserves the exact saved recording', () => {
  const repackaged: VocabularyEntry = { ...original, level: '3級', meaning: '新しい説明', usageTip: '新しい学習ポイント',
    metadata: { schemaVersion: 2, cefrEstimate: 'B2', domains: ['academic'], gradeEstimate: '3級', levelPolicy: 'estimated' },
    questions: original.questions.map(question => ({ ...question, explanation: '更新した説明' })) };
  assert.deepEqual(preserveVocabularyAudio([original], [repackaged], [record]), [record]);
});

test('changed spoken text or voice drops only its mismatched playback reference', () => {
  for (const changed of [
    { ...original, word: 'replacement' },
    { ...original, voice: original.voice === 'female' ? 'male' as const : 'female' as const },
    { ...original, examples: original.examples.map((example, index) => index ? example : { ...example, text: 'This is a different recorded sentence.' }) },
  ]) assert.deepEqual(preserveVocabularyAudio([original], [changed], [record]), []);
  assert.deepEqual(preserveVocabularyAudio([original], [], [record]), []);
  assert.deepEqual(preserveVocabularyAudio([], [original], [record]), []);
  assert.deepEqual(preserveVocabularyAudio([original], [original], [{ ...record, cacheKey: '0'.repeat(64) }]), []);
});

test('existing plain-node exporter CLI loads the shared audio code outside the repository cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-catalog-export-'));
  try {
    const frozen = vocabularyEntries.map(entry => ({ entry }));
    await writeFile(join(directory, 'frozen-100.json'), JSON.stringify(frozen));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ frozenSha256: hashVocabularyEntry(frozen), words: [] }));
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/vocabulary-catalog-export.mjs', import.meta.url)), directory], { cwd: tmpdir(), encoding: 'utf8' }));
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.approvedNew, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
