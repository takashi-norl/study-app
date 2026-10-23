import { z } from 'zod';

export const VOCABULARY_IMPORT_BODY_BYTES = 3 * 1024 * 1024;
export const VOCABULARY_IMPORT_FILE_BYTES = 32 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
export const vocabularyImportSegmentsSchema = z.array(z.object({
  id: z.enum(['word', 'example-1', 'example-2', 'example-3']),
  startSeconds: z.number().finite().min(0).max(180),
  endSeconds: z.number().finite().positive().max(180),
}).strict()).length(4).refine(segments => segments.every((segment, index) =>
  segment.id === ['word', 'example-1', 'example-2', 'example-3'][index]
  && segment.endSeconds > segment.startSeconds
  && (index === 0 || segment.startSeconds >= segments[index - 1].endSeconds)), 'Invalid audio sections');
export const vocabularyImportClipSchema = z.object({
  wordId: id, cacheKey: digest, segments: vocabularyImportSegmentsSchema,
  audioBase64: z.string().min(4).max(4 * Math.ceil(2 * 1024 * 1024 / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  sha256: digest,
}).strict();
export const vocabularyImportBundleSchema = z.object({
  schemaVersion: z.literal(2), batchId: id, clips: z.array(vocabularyImportClipSchema).min(1).max(100),
}).strict().refine(bundle => new Set(bundle.clips.map(clip => clip.wordId)).size === bundle.clips.length, 'Duplicate vocabulary clips');
export const vocabularyImportRequestSchema = z.object({
  schemaVersion: z.literal(2), batchId: id, clips: z.array(vocabularyImportClipSchema).length(1),
}).strict();
export const vocabularyImportReceiptSchema = z.object({
  wordId: id, cacheKey: digest, fileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  segments: vocabularyImportSegmentsSchema, voiceLabel: z.string().min(1).max(200),
}).strict();
export const vocabularyImportResponseSchema = z.object({
  batchId: id, audio: z.array(vocabularyImportReceiptSchema).length(1), reused: z.boolean(),
}).strict();
export type VocabularyImportClip = z.infer<typeof vocabularyImportClipSchema>;
export type VocabularyImportBundle = z.infer<typeof vocabularyImportBundleSchema>;
export type VocabularyImportReceipt = z.infer<typeof vocabularyImportReceiptSchema>;
