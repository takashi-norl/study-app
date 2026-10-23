import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import rawIndex from '../../content/vocabulary-generated/index.json';
import { VOCABULARY_LEVELS, type VocabularyBatchSummary, type VocabularyEntry } from '@/lib/vocabulary-types';
import { ApiError } from './config';
import { vocabularyEntries } from './vocabulary-catalog';
import { audioSegmentsSchema } from './audio-segments';
import { vocabularyAudioSpec } from './vocabulary-audio';

export const LEGACY_VOCABULARY_BATCH = 'legacy-100';
const text = z.string().trim().min(1).max(4000);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
const alternative = z.object({ answer: text, explanation: text });
const authoredTest = z.object({
  mode: z.enum(['meaning', 'word', 'context', 'usage']), prompt: text,
  choices: z.array(z.object({ text, meaning: text })).length(4),
  correctIndex: z.number().int().min(0).max(3), explanation: text,
  alternatives: z.array(alternative).max(10),
}).superRefine((value, context) => {
  if (new Set(value.choices.map(choice => choice.text.normalize('NFKC').trim().toLowerCase())).size !== 4) {
    context.addIssue({ code: 'custom', message: 'Choices must be unique.' });
  }
});
const entrySchema = z.object({
  id, word: text, level: z.enum(VOCABULARY_LEVELS), ipa: text, ipaLabel: text,
  partOfSpeech: text, definition: text, meaning: text, usageTip: text,
  voice: z.enum(['female', 'male']),
  verbForms: z.object({ base: z.array(text).min(1), past: z.array(text).min(1), pastParticiple: z.array(text).min(1),
    presentParticiple: z.array(text).min(1), thirdPersonSingular: z.array(text).min(1), note: text.optional() }).optional(),
  examples: z.array(z.object({ id: text, context: text, text, translation: text })).length(3),
  recall: z.object({ prompt: text, answers: z.array(text).min(1), explanation: text, alternatives: z.array(alternative).optional() }),
  production: z.object({ prompt: text, modelAnswer: text, checkpoints: z.array(text).min(1) }),
  questions: z.array(z.object({ id: text, type: z.enum(['usage', 'context', 'paraphrase']), prompt: text,
    choices: z.array(text).length(4), correctIndex: z.number().int().min(0).max(3), explanation: text })).min(1),
  tests: z.array(authoredTest).length(4),
  metadata: z.object({ schemaVersion: z.literal(2), cefrEstimate: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
    domains: z.array(text).max(10), gradeEstimate: z.enum(VOCABULARY_LEVELS), levelPolicy: text }).optional(),
}).superRefine((value, context) => {
  if (new Set(value.tests.map(test => test.mode)).size !== 4) context.addIssue({ code: 'custom', message: 'All four test modes are required.' });
  if (new Set(value.examples.map(example => example.id)).size !== 3) context.addIssue({ code: 'custom', message: 'Example IDs must be unique.' });
});

export const vocabularyGeneratedIndexSchema = z.object({
  schemaVersion: z.literal(2),
  batches: z.array(z.object({ id, level: z.enum(VOCABULARY_LEVELS), title: text,
    entryCount: z.number().int().min(1).max(100), file: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}\.json$/) })).max(1000),
}).superRefine((value, context) => {
  if (new Set(value.batches.map(batch => batch.id)).size !== value.batches.length || value.batches.some(batch => batch.id === LEGACY_VOCABULARY_BATCH)) {
    context.addIssue({ code: 'custom', message: 'Batch IDs must be unique and cannot replace the existing catalog.' });
  }
});

const index = vocabularyGeneratedIndexSchema.parse(rawIndex);
const importedAudioSchema = z.object({ wordId: id, cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), segments: audioSegmentsSchema, voiceLabel: text }).strict();
export type ImportedVocabularyAudio = z.infer<typeof importedAudioSchema>;
type VocabularyBatchData = { entries: VocabularyEntry[]; audio: ImportedVocabularyAudio[] };
const cached = new Map<string, VocabularyBatchData>();
const existingIds = new Set(vocabularyEntries.map(entry => entry.id));
const existingWords = new Set(vocabularyEntries.map(entry => entry.word.normalize('NFKC').toLowerCase()));

export function vocabularyBatchIndex(): VocabularyBatchSummary[] {
  return [{ id: LEGACY_VOCABULARY_BATCH, title: '2級・準1級 最初の100語', entryCount: vocabularyEntries.length },
    ...index.batches.map(({ id, level, title, entryCount }) => ({ id, level, title, entryCount }))];
}

/** Validation also protects audio routes from arbitrary file paths or unvalidated paid text. */
export function parseVocabularyBatch(raw: unknown, batch: VocabularyBatchSummary): VocabularyBatchData {
  const parsed = z.object({ schemaVersion: z.literal(2), entries: z.array(entrySchema).min(1).max(100),
    audio: z.array(importedAudioSchema).max(100).default([]) }).parse(raw);
  const entries = parsed.entries as VocabularyEntry[];
  if (entries.length !== batch.entryCount || entries.some(entry => entry.level !== batch.level || existingIds.has(entry.id) || existingWords.has(entry.word.normalize('NFKC').toLowerCase()))
    || new Set(entries.map(entry => entry.id)).size !== entries.length
    || new Set(entries.map(entry => entry.word.normalize('NFKC').toLowerCase())).size !== entries.length) {
    throw new Error('Vocabulary batch does not match its index.');
  }
  if (new Set(parsed.audio.map(audio => audio.wordId)).size !== parsed.audio.length || parsed.audio.some(audio => {
    const entry = entries.find(entry => entry.id === audio.wordId);
    return !entry || vocabularyAudioSpec(entry).cacheKey !== audio.cacheKey;
  })) throw new Error('Vocabulary audio does not match its text.');
  return { entries, audio: parsed.audio };
}

function vocabularyBatchData(batchId: string): VocabularyBatchData {
  if (batchId === LEGACY_VOCABULARY_BATCH) return { entries: vocabularyEntries, audio: [] };
  const batch = index.batches.find(batch => batch.id === batchId);
  if (!batch) throw new ApiError(404, 'この単語教材が見つかりません。', 'VOCABULARY_BATCH_NOT_FOUND');
  const previous = cached.get(batchId);
  if (previous) return previous;
  try {
    const data = parseVocabularyBatch(JSON.parse(readFileSync(join(process.cwd(), 'content', 'vocabulary-generated', batch.file), 'utf8')), batch);
    // Only active batches stay in memory, even after browsing a large library.
    if (cached.size >= 4) cached.delete(cached.keys().next().value!);
    cached.set(batchId, data);
    return data;
  } catch {
    throw new ApiError(503, 'この単語教材を読み込めませんでした。別の教材を選んでください。', 'VOCABULARY_BATCH_UNAVAILABLE');
  }
}

export function vocabularyBatchEntries(batchId = LEGACY_VOCABULARY_BATCH): VocabularyEntry[] {
  return vocabularyBatchData(batchId).entries;
}

export function vocabularyBatchAudio(batchId: string): ImportedVocabularyAudio[] {
  return vocabularyBatchData(batchId).audio;
}
