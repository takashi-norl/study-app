import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { vocabularyImportReceiptSchema, type VocabularyImportReceipt } from '../src/lib/vocabulary-import';
import { parseVocabularyBatch, vocabularyGeneratedIndexSchema } from '../src/server/vocabulary-generated';
import { vocabularyAudioSpec } from '../src/server/vocabulary-audio';
import { audioSegmentsSchema } from '../src/server/audio-segments';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const receiptsSchema = z.object({
  batchId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  audio: z.array(vocabularyImportReceiptSchema.extend({ fileId: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/) })).min(1).max(100),
}).strict().refine(value => new Set(value.audio.map(item => item.wordId)).size === value.audio.length, 'Duplicate words in receipt');
type ReceiptDocument = z.infer<typeof receiptsSchema>;

async function readSmall(file: string, maximum = 2 * 1024 * 1024): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) throw new Error('Receipt or catalog metadata exceeds its file limit.');
  return readFile(file, 'utf8');
}
async function receiptFiles(source: string): Promise<string[]> {
  const resolved = path.resolve(source), info = await stat(resolved);
  if (info.isFile()) return [resolved];
  if (!info.isDirectory()) throw new Error('Receipt input must be a JSON file or directory.');
  return (await readdir(resolved, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.json'))
    .map(item => path.join(resolved, item.name)).sort();
}
const sameReceipt = (left: VocabularyImportReceipt, right: VocabularyImportReceipt) => JSON.stringify(vocabularyImportReceiptSchema.parse(left)) === JSON.stringify(vocabularyImportReceiptSchema.parse(right));

async function validateLocalAudio(directory: string, receipt: VocabularyImportReceipt, expectedVoiceId: string) {
  const assetDirectory = path.join(directory, 'assets', receipt.cacheKey);
  const asset = z.object({
    cacheKey: z.string(), wordId: z.string(), voiceId: z.string(), voiceLabel: z.string(),
    segments: audioSegmentsSchema, mp3Sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(JSON.parse(await readSmall(path.join(assetDirectory, 'asset.json'), 128 * 1024)));
  if (asset.cacheKey !== receipt.cacheKey || asset.wordId !== receipt.wordId || asset.voiceId !== expectedVoiceId || asset.voiceLabel !== receipt.voiceLabel
    || JSON.stringify(asset.segments) !== JSON.stringify(receipt.segments)) throw new Error(`Imported timing or identity differs from the saved audio for ${receipt.wordId}.`);
  const audioFile = path.join(assetDirectory, 'audio.mp3');
  const size = (await stat(audioFile)).size;
  if (size < 1 || size > 2 * 1024 * 1024 || digest(await readFile(audioFile)) !== asset.mp3Sha256) throw new Error(`Local audio failed its integrity check for ${receipt.wordId}.`);
}

export type ReceiptMergeReport = {
  mode: 'dry-run' | 'written'; receiptFiles: number; received: number; added: number; alreadyPresent: number;
  localAudioVerified: boolean; batches: { batchId: string; added: number; alreadyPresent: number; audioCount: number; changed: boolean }[];
};

/** Offline metadata merge. Only batch.audio changes; entries, index, and other batches remain untouched. */
export async function mergeVocabularyAudioReceipts(options: { index: string; receipts: string[]; audioDirectory?: string; write?: boolean }): Promise<ReceiptMergeReport> {
  const indexPath = await realpath(path.resolve(options.index)), catalogDirectory = path.dirname(indexPath);
  const indexText = await readSmall(indexPath), index = vocabularyGeneratedIndexSchema.parse(JSON.parse(indexText));
  if (new Set(index.batches.map(batch => batch.file)).size !== index.batches.length) throw new Error('Catalog batches must use distinct files.');
  const files = (await Promise.all(options.receipts.map(receiptFiles))).flat();
  if (!files.length || files.length > 1000) throw new Error('Choose between 1 and 1000 receipt files.');
  const documents: ReceiptDocument[] = [];
  for (const file of files) documents.push(receiptsSchema.parse(JSON.parse(await readSmall(file))));
  if (documents.reduce((sum, document) => sum + document.audio.length, 0) > 7500) throw new Error('A merge may include at most 7500 received clips.');
  const grouped = new Map<string, Map<string, VocabularyImportReceipt>>();
  for (const document of documents) {
    if (!index.batches.some(batch => batch.id === document.batchId)) throw new Error(`Receipt batch ${document.batchId} is not in the catalog index.`);
    const group = grouped.get(document.batchId) ?? new Map<string, VocabularyImportReceipt>();
    for (const receipt of document.audio) {
      const previous = group.get(receipt.wordId);
      if (previous && !sameReceipt(previous, receipt)) throw new Error(`Conflicting receipts for ${receipt.wordId}; automatic replacement is disabled.`);
      group.set(receipt.wordId, receipt);
    }
    grouped.set(document.batchId, group);
  }
  const report: ReceiptMergeReport = { mode: options.write ? 'written' : 'dry-run', receiptFiles: files.length, received: 0, added: 0, alreadyPresent: 0, localAudioVerified: !!options.audioDirectory, batches: [] };
  const changes: { file: string; originalHash: string; content: string; changed: boolean }[] = [];
  for (const [batchId, received] of grouped) {
    const batch = index.batches.find(item => item.id === batchId)!;
    const file = path.join(catalogDirectory, batch.file);
    if (await realpath(file) !== file) throw new Error('A catalog batch cannot be a symbolic link.');
    const original = await readSmall(file), raw: unknown = JSON.parse(original);
    const parsed = parseVocabularyBatch(raw, batch);
    const entries = new Map(parsed.entries.map(entry => [entry.id, entry]));
    const merged = new Map(parsed.audio.map(audio => [audio.wordId, audio]));
    let added = 0, alreadyPresent = 0;
    for (const receipt of received.values()) {
      const entry = entries.get(receipt.wordId);
      if (!entry) throw new Error(`Receipt word ${receipt.wordId} is not in its indexed batch.`);
      const spec = vocabularyAudioSpec(entry);
      if (receipt.cacheKey !== spec.cacheKey || receipt.voiceLabel !== spec.voiceLabel) throw new Error(`Receipt does not match the approved text/voice for ${receipt.wordId}.`);
      if (options.audioDirectory) await validateLocalAudio(options.audioDirectory, receipt, spec.voiceId);
      const previous = merged.get(receipt.wordId);
      if (previous) {
        if (!sameReceipt(previous, receipt)) throw new Error(`Existing audio for ${receipt.wordId} differs; automatic replacement is disabled.`);
        alreadyPresent++;
      } else { merged.set(receipt.wordId, receipt); added++; }
    }
    // Catalog entry order makes repeated merges deterministic, independently of receipt file order.
    const audio = parsed.entries.flatMap(entry => merged.has(entry.id) ? [merged.get(entry.id)!] : []);
    const next = { ...(raw as Record<string, unknown>), audio };
    parseVocabularyBatch(next, batch);
    report.batches.push({ batchId, added, alreadyPresent, audioCount: audio.length, changed: added > 0 });
    report.received += received.size; report.added += added; report.alreadyPresent += alreadyPresent;
    changes.push({ file, originalHash: digest(original), content: `${JSON.stringify(next, null, 2)}\n`, changed: added > 0 });
  }
  if (!options.write || !changes.some(change => change.changed)) return report;
  const lockPath = path.join(catalogDirectory, '.audio-receipts.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('An audio receipt merge is already running.'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    if (digest(await readSmall(indexPath)) !== digest(indexText)) throw new Error('The catalog index changed during validation. Rerun the merge.');
    for (const change of changes) if (digest(await readSmall(change.file)) !== change.originalHash) throw new Error('A catalog batch changed during validation. Rerun the merge.');
    // Validation of every receipt completes before any file is replaced.
    for (const change of changes.filter(change => change.changed)) {
      const temporary = `${change.file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(change.content); await handle.sync();
      } finally { await handle.close(); }
      if (digest(await readSmall(change.file)) !== change.originalHash) { await unlink(temporary); throw new Error('A catalog batch changed before writing. Rerun the merge.'); }
      await rename(temporary, change.file);
    }
    const directory = await open(catalogDirectory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await lock.close(); await unlink(lockPath); }
  return report;
}
