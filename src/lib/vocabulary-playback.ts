import type { VocabularyAudio } from './vocabulary-types';

/** Pick only recordings of this word and this spoken segment; never fall back to another word. */
export function selectVocabularyAudio(
  clips: readonly VocabularyAudio[], wordId: string, segmentId: string, random: () => number = Math.random,
): VocabularyAudio | undefined {
  const unique = new Map<string, VocabularyAudio>();
  for (const clip of clips) {
    const segment = clip.segments?.find(item => item.id === segmentId);
    if (clip.wordId !== wordId || clip.state !== 'ready' || !clip.url.trim() || !segment
      || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)
      || segment.startSeconds < 0 || segment.endSeconds <= segment.startSeconds) continue;
    if (!unique.has(clip.url)) unique.set(clip.url, clip);
  }
  const candidates = [...unique.values()];
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  const draw = random();
  const fraction = Number.isFinite(draw) ? Math.max(0, Math.min(draw, 1 - Number.EPSILON)) : 0;
  return candidates[Math.floor(fraction * candidates.length)];
}
