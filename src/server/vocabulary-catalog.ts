import 'server-only';
import grade2 from '../../content/vocabulary-grade2.json';
import pre1 from '../../content/vocabulary-pre1.json';
import type { VocabularyEntry } from '@/lib/vocabulary-types';

export const VOCABULARY_CATALOG_ID = 'eiken-vocabulary-100-v1';
export const vocabularyEntries = [...grade2.entries, ...pre1.entries] as VocabularyEntry[];
