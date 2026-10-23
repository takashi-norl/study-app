import 'server-only';
import { ApiError } from './config';
import type { StudyEvent } from './google-store';

/** A one-time, fixed 100-word asset build. The normal 30-clips/day practice limit stays unchanged. */
export function checkVocabularyBuildQuota(events: StudyEvent[], catalog: { cacheKey: string; characters: number }[], cacheKey: string, now = new Date()) {
  const unique = new Map(catalog.map(spec => [spec.cacheKey, spec.characters]));
  const chars = unique.get(cacheKey);
  if (catalog.length !== 100 || unique.size !== 100 || !chars || [...unique.values()].some(value => value <= 0 || value > 1500)
    || [...unique.values()].reduce((sum, value) => sum + value, 0) > 35000) throw new ApiError(503, '100語セットの音声予算を確認してください。', 'VOCABULARY_BUILD_BUDGET');
  const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now).slice(0, 7);
  const requests = [...new Map(events.filter(event => event.type === 'audio.requested').map(event => [event.id, event])).values()];
  const monthly = requests.filter(event => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(event.createdAt)).slice(0, 7) === month);
  if (monthly.length >= 300 || monthly.reduce((sum, event) => sum + event.payload.characters, 0) + chars > 150000) throw new ApiError(429, '今月の音声利用上限に達しました。保存済みの音声は再生できます。', 'AUDIO_LIMIT');
  if (requests.some(event => event.payload.cacheKey === cacheKey)) throw new ApiError(409, 'この音声はすでに準備を依頼しています。', 'AUDIO_PENDING');
}
