import type { VocabularyEntry } from '../src/lib/vocabulary-types';
import type { ImportedVocabularyAudio } from '../src/server/vocabulary-generated';
import { vocabularyAudioSpec } from '../src/server/vocabulary-audio';

/** Exam tags and tests may change while the recorded word/examples stay identical. */
export function preserveVocabularyAudio(previousEntries: VocabularyEntry[], nextEntries: VocabularyEntry[], audio: ImportedVocabularyAudio[]): ImportedVocabularyAudio[] {
  const previous = new Map(previousEntries.map(entry => [entry.id, entry]));
  const next = new Map(nextEntries.map(entry => [entry.id, entry]));
  return audio.filter(record => {
    const oldEntry = previous.get(record.wordId), newEntry = next.get(record.wordId);
    if (!oldEntry || !newEntry) return false;
    const oldSpec = vocabularyAudioSpec(oldEntry), newSpec = vocabularyAudioSpec(newEntry);
    return record.cacheKey === oldSpec.cacheKey && oldSpec.cacheKey === newSpec.cacheKey;
  });
}
