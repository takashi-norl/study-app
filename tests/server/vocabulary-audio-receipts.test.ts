import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeVocabularyAudioReceipts } from '../../scripts/vocabulary-audio-receipts-lib';
import { vocabularyEntries } from '../../src/server/vocabulary-catalog';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';

async function fixture(work: (data: {
  root: string; index: string; batchFile: string; receiptFile: string; audioDirectory: string;
  receipt: { batchId: string; audio: { wordId: string; cacheKey: string; fileId: string; voiceLabel: string; segments: { id: string; startSeconds: number; endSeconds: number }[] }[] };
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hibi-receipt-test-'));
  try {
    const entry = { ...structuredClone(vocabularyEntries[0]), id: 'new-test-entry', word: 'newtestword', level: '3級' as const, voice: 'female' as const,
      tests: (['meaning', 'word', 'context', 'usage'] as const).map(mode => ({ mode, prompt: 'Choose the best answer.', choices: ['first', 'second', 'third', 'fourth'].map((text, i) => ({ text, meaning: `意味${i}` })), correctIndex: 0, explanation: 'The first option matches.', alternatives: [] })) };
    const batchId = 'grade3-001', spec = vocabularyAudioSpec(entry);
    const segments = ['word', 'example-1', 'example-2', 'example-3'].map((id, index) => ({ id, startSeconds: index * 2, endSeconds: index * 2 + 1 }));
    const receipt = { batchId, audio: [{ wordId: entry.id, cacheKey: spec.cacheKey, fileId: 'private_drive_file_123', voiceLabel: spec.voiceLabel, segments }] };
    const index = path.join(root, 'index.json'), batchFile = path.join(root, `${batchId}.json`), receiptFile = path.join(root, 'receipt.json'), audioDirectory = path.join(root, 'audio');
    await writeFile(index, JSON.stringify({ schemaVersion: 2, batches: [{ id: batchId, level: entry.level, title: '3級・セット1', entryCount: 1, file: `${batchId}.json` }] }));
    await writeFile(batchFile, JSON.stringify({ schemaVersion: 2, entries: [entry], audio: [], operatorMetadata: { preserved: true } }));
    await writeFile(receiptFile, JSON.stringify(receipt));
    const directory = path.join(audioDirectory, 'assets', spec.cacheKey), mp3 = Buffer.from([73, 68, 51, 4, 0, 0, 0]);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'audio.mp3'), mp3);
    await writeFile(path.join(directory, 'asset.json'), JSON.stringify({ cacheKey: spec.cacheKey, wordId: entry.id, voiceId: spec.voiceId, voiceLabel: spec.voiceLabel, segments, mp3Sha256: createHash('sha256').update(mp3).digest('hex') }));
    await work({ root, index, batchFile, receiptFile, audioDirectory, receipt });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('offline receipt merge defaults to dry-run and changes only indexed audio, once', () => fixture(async data => {
  const before = await readFile(data.batchFile, 'utf8'), indexBefore = await readFile(data.index, 'utf8');
  const options = { index: data.index, receipts: [data.receiptFile], audioDirectory: data.audioDirectory };
  const plan = await mergeVocabularyAudioReceipts(options);
  assert.equal(plan.mode, 'dry-run'); assert.equal(plan.added, 1); assert.equal(plan.localAudioVerified, true);
  assert.equal(await readFile(data.batchFile, 'utf8'), before);
  const written = await mergeVocabularyAudioReceipts({ ...options, write: true });
  assert.equal(written.added, 1);
  const after = JSON.parse(await readFile(data.batchFile, 'utf8'));
  assert.deepEqual(after.entries, JSON.parse(before).entries);
  assert.deepEqual(after.operatorMetadata, { preserved: true });
  assert.deepEqual(after.audio, data.receipt.audio);
  assert.equal(await readFile(data.index, 'utf8'), indexBefore);
  const modified = (await stat(data.batchFile)).mtimeMs;
  const repeated = await mergeVocabularyAudioReceipts({ ...options, write: true });
  assert.equal(repeated.added, 0); assert.equal(repeated.alreadyPresent, 1);
  assert.equal((await stat(data.batchFile)).mtimeMs, modified);
  assert.doesNotMatch(JSON.stringify(repeated), /private_drive_file/);
}));

test('unknown batch/word, changed cache/voice, malformed timings/file IDs and conflicting duplicate receipts fail without writing', () => fixture(async data => {
  const before = await readFile(data.batchFile, 'utf8');
  const variants = [
    { ...data.receipt, batchId: 'unknown-batch' },
    { ...data.receipt, batchId: '../outside' },
    { ...data.receipt, audio: [{ ...data.receipt.audio[0], wordId: 'unknown-word' }] },
    { ...data.receipt, audio: [{ ...data.receipt.audio[0], cacheKey: '0'.repeat(64) }] },
    { ...data.receipt, audio: [{ ...data.receipt.audio[0], voiceLabel: 'Different voice' }] },
    { ...data.receipt, audio: [{ ...data.receipt.audio[0], fileId: '../outside' }] },
    { ...data.receipt, audio: [{ ...data.receipt.audio[0], segments: [...data.receipt.audio[0].segments].reverse() }] },
    { ...data.receipt, audio: [data.receipt.audio[0], data.receipt.audio[0]] },
  ];
  for (const variant of variants) {
    await writeFile(data.receiptFile, JSON.stringify(variant));
    await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], write: true }));
    assert.equal(await readFile(data.batchFile, 'utf8'), before);
  }
  await writeFile(data.receiptFile, JSON.stringify(data.receipt));
  const conflict = path.join(data.root, 'conflict.json');
  await writeFile(conflict, JSON.stringify({ ...data.receipt, audio: [{ ...data.receipt.audio[0], fileId: 'another_private_file' }] }));
  await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile, conflict], write: true }), /Conflicting receipts/);
  assert.equal(await readFile(data.batchFile, 'utf8'), before);
}));

test('local generated audio rejects valid-looking but shifted timings and corrupt MP3 data', () => fixture(async data => {
  const shifted = structuredClone(data.receipt);
  shifted.audio[0].segments[1].startSeconds += 0.1;
  await writeFile(data.receiptFile, JSON.stringify(shifted));
  await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], audioDirectory: data.audioDirectory, write: true }), /timing or identity/);
  await writeFile(data.receiptFile, JSON.stringify(data.receipt));
  await writeFile(path.join(data.audioDirectory, 'assets', data.receipt.audio[0].cacheKey, 'audio.mp3'), 'corrupt');
  await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], audioDirectory: data.audioDirectory, write: true }), /integrity check/);
  assert.deepEqual(JSON.parse(await readFile(data.batchFile, 'utf8')).audio, []);
}));

test('existing audio cannot be replaced and a symlinked batch cannot escape the indexed directory', () => fixture(async data => {
  const original = await readFile(data.batchFile, 'utf8');
  await mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], write: true });
  await writeFile(data.receiptFile, JSON.stringify({ ...data.receipt, audio: [{ ...data.receipt.audio[0], fileId: 'another_private_file' }] }));
  await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], write: true }), /automatic replacement/);
  await writeFile(data.receiptFile, JSON.stringify(data.receipt));
  const outside = path.join(data.root, 'outside.json');
  await writeFile(outside, original); await rm(data.batchFile); await symlink(outside, data.batchFile);
  await assert.rejects(() => mergeVocabularyAudioReceipts({ index: data.index, receipts: [data.receiptFile], write: true }), /symbolic link/);
  assert.equal(await readFile(outside, 'utf8'), original);
}));
