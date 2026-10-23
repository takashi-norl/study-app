import 'server-only';
import grade2 from '../../content/vocabulary-grade2.json';
import pre1 from '../../content/vocabulary-pre1.json';
import alternatives from '../../content/vocabulary-recall-alternatives.json';
import type { VocabularyEntry } from '@/lib/vocabulary-types';
import { getVerbForms } from '@/lib/verb-forms';

export const VOCABULARY_CATALOG_ID = 'eiken-vocabulary-100-v1';
const contextAlternatives: Record<string, { answer: string; explanation: string }[]> = alternatives;
export const vocabularyEntries: VocabularyEntry[] = ([...grade2.entries, ...pre1.entries] as VocabularyEntry[]).map(entry => ({
  ...entry,
  recall: { ...entry.recall, alternatives: contextAlternatives[entry.id] ?? [] },
  ...(entry.partOfSpeech === '動詞' ? { verbForms: getVerbForms(entry.word) } : {}),
}));
