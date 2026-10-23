import 'server-only';
import { randomUUID } from 'node:crypto';
import { vocabularyEntries } from './vocabulary-catalog';
import type { VocabularyAudio, VocabularyEntry } from '@/lib/vocabulary-types';
import type { Profile } from '@/lib/types';
import { ApiError, requiredEnv } from './config';
import { assertSampleAccess } from './eiken-samples';
import { audioRecord, audioSlotId, checkAudioQuota } from './audio';
import { audioSegmentsSchema } from './audio-segments';
import { appendEvent, downloadAudioCache, loadEvents, saveAudioCache } from './google-store';
import { createVocabularyProviderAudio, vocabularyAudioSpec } from './vocabulary-audio';
import { assertSuperUser } from './env';
import { checkVocabularyBuildQuota } from './vocabulary-build-budget';
import { LEGACY_VOCABULARY_BATCH, vocabularyBatchAudio, vocabularyBatchEntries, vocabularyBatchIndex } from './vocabulary-generated';

const entries = vocabularyEntries;
export function vocabularyEntry(wordId: string, batchId = LEGACY_VOCABULARY_BATCH): VocabularyEntry {
  const entry = vocabularyBatchEntries(batchId).find(item => item.id === wordId);
  if (!entry) throw new ApiError(404, '単語の見本が見つかりません。', 'SAMPLE_NOT_FOUND');
  return entry;
}

export async function vocabularyPreview(profile: Profile, batchId = LEGACY_VOCABULARY_BATCH) {
  assertSampleAccess(profile);
  const entries = vocabularyBatchEntries(batchId);
  const events = batchId === LEGACY_VOCABULARY_BATCH ? await loadEvents() : [];
  const importedAudio = vocabularyBatchAudio(batchId);
  const audio: VocabularyAudio[] = entries.map(entry => {
    const spec = vocabularyAudioSpec(entry);
    const imported = importedAudio.find(audio => audio.wordId === entry.id);
    const record = imported ?? audioRecord(events, spec.cacheKey);
    return { wordId: entry.id, url: `/api/admin/vocabulary-samples/audio?wordId=${encodeURIComponent(entry.id)}&batch=${encodeURIComponent(batchId)}`, voiceLabel: spec.voiceLabel,
      state: record?.fileId && record.segments ? 'ready' : record && 'failed' in record && record.failed ? 'failed' : record ? 'pending' : 'missing',
      ...(record?.fileId && record.segments ? { segments: record.segments } : {}),
    };
  });
  return { entries, audio, batchId, batches: vocabularyBatchIndex(), canPrepareAudio: batchId === LEGACY_VOCABULARY_BATCH };
}

/** A fixed catalog and an append-only reservation prevent arbitrary text and repeat paid requests. */
export async function prepareVocabularyAudio(profile: Profile, wordId: string, catalogBuild = false) {
  assertSampleAccess(profile);
  if (catalogBuild) assertSuperUser(profile);
  const spec = vocabularyAudioSpec(vocabularyEntry(wordId));
  const events = await loadEvents();
  const previous = audioRecord(events, spec.cacheKey);
  if (previous?.fileId && previous.segments) return { ready: true };
  if (previous) throw new ApiError(409, previous.failed ? '準備に失敗しています。管理者が状況を確認します。' : '音声を準備中です。「状況を確認」から確認できます。', previous.failed ? 'SAMPLE_AUDIO_FAILED' : 'AUDIO_PENDING');
  requiredEnv('ELEVENLABS_API_KEY');
  if (catalogBuild) checkVocabularyBuildQuota(events, entries.map(vocabularyAudioSpec), spec.cacheKey);
  else checkAudioQuota(events, spec.characters);
  const slotId = audioSlotId(events); const requestToken = randomUUID();
  await appendEvent({ id: slotId, type: 'audio.requested', actorId: profile.id, createdAt: new Date().toISOString(), payload: {
    cacheKey: spec.cacheKey, requestToken, characters: spec.characters,
  } });
  const canonical = await loadEvents();
  if (canonical.find(event => event.id === slotId)?.payload.requestToken !== requestToken) throw new ApiError(409, 'ほかの音声を準備中です。「状況を確認」から確認できます。', 'AUDIO_PENDING');
  try {
    const { bytes, segments } = await createVocabularyProviderAudio(spec);
    audioSegmentsSchema.parse(segments);
    const fileId = await saveAudioCache(spec.cacheKey, bytes);
    await appendEvent({ id: `audio-ready:${spec.cacheKey}`, type: 'audio.ready', actorId: profile.id, createdAt: new Date().toISOString(), payload: { cacheKey: spec.cacheKey, requestToken, fileId, segments } });
    return { ready: true };
  } catch (error) {
    try { await appendEvent({ id: `audio-failed:${spec.cacheKey}`, type: 'audio.failed', actorId: profile.id, createdAt: new Date().toISOString(), payload: { cacheKey: spec.cacheKey, requestToken } }); } catch { /* Uncertain reservations never trigger automatic paid retries. */ }
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, '音声の準備が中断しました。自動で再生成はしません。', 'SAMPLE_AUDIO_UNAVAILABLE');
  }
}

/** Playback only downloads saved audio; it cannot start a provider request. */
export async function readVocabularyAudio(profile: Profile, wordId: string, batchId = LEGACY_VOCABULARY_BATCH) {
  assertSampleAccess(profile);
  const spec = vocabularyAudioSpec(vocabularyEntry(wordId, batchId));
  const record = batchId === LEGACY_VOCABULARY_BATCH ? audioRecord(await loadEvents(), spec.cacheKey) : vocabularyBatchAudio(batchId).find(audio => audio.wordId === wordId);
  if (!record?.fileId || !record.segments) throw new ApiError(404, 'この音声はまだ準備されていません。', 'SAMPLE_NOT_READY');
  return downloadAudioCache(record.fileId, spec.cacheKey);
}
