import 'server-only';
import { createHash } from 'node:crypto';
import type { Profile } from '@/lib/types';
import type { VocabularyEntry } from '@/lib/vocabulary-types';
import { VOCABULARY_IMPORT_BODY_BYTES, vocabularyImportRequestSchema, type VocabularyImportClip } from '@/lib/vocabulary-import';
import { ApiError } from './config';
import { assertSuperUser } from './env';
import { assertSameOrigin } from './http';
import { audioSegmentsSchema } from './audio-segments';
import { vocabularyAudioSpec } from './vocabulary-audio';
import { LEGACY_VOCABULARY_BATCH, vocabularyBatchEntries } from './vocabulary-generated';
import { downloadAudioCache, findAudioCache, MAX_AUDIO_BYTES, saveAudioCache } from './google-store';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new ApiError(400, '音声ファイルと教材が一致しません。書き出したファイルを選び直してください。', 'INVALID_VOCABULARY_IMPORT');

/** Bound actual streamed bytes, including when Content-Length is missing or inaccurate. */
export async function readVocabularyImport(request: Request) {
  assertSameOrigin(request);
  if (!request.headers.get('origin')) throw new ApiError(403, 'アプリの取込画面から操作してください。', 'INVALID_ORIGIN');
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new ApiError(415, 'JSON形式の音声ファイルを選んでください。');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > VOCABULARY_IMPORT_BODY_BYTES)) throw new ApiError(413, '音声ファイルが大きすぎます。', 'IMPORT_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VOCABULARY_IMPORT_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, '音声ファイルが大きすぎます。', 'IMPORT_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
  return vocabularyImportRequestSchema.parse(body);
}

export function validateVocabularyImportClip(clip: VocabularyImportClip, entry: VocabularyEntry) {
  const spec = vocabularyAudioSpec(entry);
  if (clip.wordId !== entry.id || clip.cacheKey !== spec.cacheKey || clip.audioBase64.length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(clip.audioBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString('base64') !== clip.audioBase64 || digest(bytes) !== clip.sha256) throw invalid();
  if (bytes.subarray(0, 3).toString('ascii') !== 'ID3' && !(bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224)) throw invalid();
  const segments = audioSegmentsSchema.parse(clip.segments);
  return { bytes, segments, spec };
}

type ImportDependencies = {
  entries: (batchId: string) => VocabularyEntry[];
  find: typeof findAudioCache;
  save: typeof saveAudioCache;
  download: typeof downloadAudioCache;
};
const dependencies: ImportDependencies = { entries: vocabularyBatchEntries, find: findAudioCache, save: saveAudioCache, download: downloadAudioCache };

/** Uploads already-created audio only: no TTS request and no per-clip Sheets events. */
export async function importVocabularyAudio(profile: Profile, raw: unknown, store: ImportDependencies = dependencies) {
  assertSuperUser(profile);
  const input = vocabularyImportRequestSchema.parse(raw);
  if (input.batchId === LEGACY_VOCABULARY_BATCH) throw new ApiError(409, '既存100語の音声はそのまま利用します。追加教材のファイルを選んでください。', 'EXISTING_AUDIO_PRESERVED');
  const clip = input.clips[0];
  const entry = store.entries(input.batchId).find(entry => entry.id === clip.wordId);
  if (!entry) throw invalid();
  const { bytes, segments, spec } = validateVocabularyImportClip(clip, entry);
  let fileId = await store.find(spec.cacheKey);
  const reused = !!fileId;
  if (fileId) {
    // A same-name file is not sufficient: re-use only the exact private cache content.
    if (digest(await store.download(fileId, spec.cacheKey)) !== clip.sha256) {
      throw new ApiError(409, '同じ教材に別の保存音声があります。既存の音声を確認してください。', 'AUDIO_CACHE_CONFLICT');
    }
  } else fileId = await store.save(spec.cacheKey, bytes);
  return { batchId: input.batchId, audio: [{ wordId: entry.id, cacheKey: spec.cacheKey, fileId, segments, voiceLabel: spec.voiceLabel }], reused };
}
