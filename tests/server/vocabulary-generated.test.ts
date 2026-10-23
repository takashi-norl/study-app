import assert from 'node:assert/strict';
import test from 'node:test';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import { vocabularyEntries } from '../../src/server/vocabulary-catalog';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { LEGACY_VOCABULARY_BATCH, parseVocabularyBatch, vocabularyBatchEntries, vocabularyBatchIndex, vocabularyGeneratedIndexSchema } from '../../src/server/vocabulary-generated';

function entry(): VocabularyEntry {
  const base = structuredClone(vocabularyEntries[0]);
  return { ...base, id: 'test-new-word', word: 'sampleword', level: '3級', voice: 'female',
    tests: (['meaning', 'word', 'context', 'usage'] as const).map(mode => ({ mode, prompt: 'Choose the best answer.',
      choices: ['sampleword', 'second', 'third', 'fourth'].map((text, index) => ({ text, meaning: `意味${index + 1}` })),
      correctIndex: 0, explanation: 'The first expression matches the intended meaning.', alternatives: [] })) };
}
const descriptor = { id: 'grade3-001', level: '3級' as const, title: '3級・セット1', entryCount: 1 };

test('empty generated index preserves the exact existing catalog and exposes only a bounded index', () => {
  assert.equal(vocabularyBatchEntries(), vocabularyEntries);
  assert.equal(vocabularyBatchEntries(LEGACY_VOCABULARY_BATCH), vocabularyEntries);
  const index = vocabularyBatchIndex();
  assert.equal(index[0].entryCount, 100);
  assert.doesNotMatch(JSON.stringify(index), /examples|recall|cacheKey|fileId/);
  for (const id of ['', '../vocabulary-grade2', '/etc/passwd', 'arbitrary-file.json']) {
    assert.throws(() => vocabularyBatchEntries(id), { code: 'VOCABULARY_BATCH_NOT_FOUND' });
  }
});

test('catalog index cannot request paths outside the generated folder or replace the existing100', () => {
  const batch = { ...descriptor, file: 'grade3-001.json' };
  assert.doesNotThrow(() => vocabularyGeneratedIndexSchema.parse({ schemaVersion: 2, batches: [batch] }));
  for (const file of ['../secret.json', '/tmp/file.json', 'nested/file.json', '.env', 'file.json/../../secret']) {
    assert.throws(() => vocabularyGeneratedIndexSchema.parse({ schemaVersion: 2, batches: [{ ...batch, file }] }));
  }
  for (const batches of [[{ ...batch, id: LEGACY_VOCABULARY_BATCH }], [batch, batch], [{ ...batch, entryCount: 101 }]]) {
    assert.throws(() => vocabularyGeneratedIndexSchema.parse({ schemaVersion: 2, batches }));
  }
});

test('generated batches require complete four-mode tests, correct level/count and unique new words', () => {
  const valid = { schemaVersion: 2, entries: [entry()] };
  assert.equal(parseVocabularyBatch(valid, descriptor).entries.length, 1);
  assert.deepEqual(parseVocabularyBatch(valid, descriptor).audio, []);
  const invalid = [
    { ...valid, entries: [{ ...entry(), level: '1級' }] },
    { ...valid, entries: [{ ...entry(), level: '2級' }] },
    { ...valid, entries: [{ ...entry(), id: vocabularyEntries[0].id }] },
    { ...valid, entries: [{ ...entry(), word: vocabularyEntries[0].word }] },
    { ...valid, entries: [entry(), entry()] },
    { ...valid, entries: [{ ...entry(), tests: undefined }] },
    { ...valid, entries: [{ ...entry(), tests: Array(4).fill(entry().tests![0]) }] },
    { ...valid, entries: [{ ...entry(), tests: entry().tests!.map(test => ({ ...test, choices: Array(4).fill(test.choices[0]) })) }] },
    { ...valid, entries: [{ ...entry(), examples: entry().examples.slice(0, 2) }] },
  ];
  for (const data of invalid) assert.throws(() => parseVocabularyBatch(data, descriptor));
});

test('imported audio must match the entry text, voice, four sections and one recording per word', () => {
  const word = entry();
  const spec = vocabularyAudioSpec(word);
  const audio = { wordId: word.id, cacheKey: spec.cacheKey, fileId: 'private_drive_asset', voiceLabel: spec.voiceLabel,
    segments: ['word', 'example-1', 'example-2', 'example-3'].map((id, index) => ({ id, startSeconds: index, endSeconds: index + 1 })) };
  const valid = { schemaVersion: 2, entries: [word], audio: [audio] };
  assert.equal(parseVocabularyBatch(valid, descriptor).audio[0].fileId, 'private_drive_asset');
  for (const bad of [{ ...audio, cacheKey: '0'.repeat(64) }, { ...audio, wordId: 'unknown' }, { ...audio, fileId: '../secret' },
    { ...audio, segments: audio.segments.slice(1) }, { ...audio, segments: audio.segments.map(segment => ({ ...segment, endSeconds: 0 })) }]) {
    assert.throws(() => parseVocabularyBatch({ ...valid, audio: [bad] }, descriptor));
  }
  assert.throws(() => parseVocabularyBatch({ ...valid, audio: [audio, audio] }, descriptor));
  assert.throws(() => parseVocabularyBatch({ ...valid, entries: [{ ...word, voice: 'male' }] }, descriptor));
});
