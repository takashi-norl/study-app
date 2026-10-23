import type { VerbForms } from './verb-forms';

export const VOCABULARY_LEVELS = ['3級', '準2級', '2級', '準1級'] as const;
export type VocabularyLevel = typeof VOCABULARY_LEVELS[number];
export type AuthoredVocabularyTest = {
  mode: 'meaning' | 'word' | 'context' | 'usage';
  prompt: string;
  choices: { text: string; meaning: string }[];
  correctIndex: number;
  explanation: string;
  alternatives: { answer: string; explanation: string }[];
};
export type VocabularyBatchSummary = {
  id: string;
  title: string;
  level?: VocabularyLevel;
  entryCount: number;
};

export type VocabularyEntry = {
  id: string;
  word: string;
  level: VocabularyLevel;
  ipa: string;
  ipaLabel: string;
  partOfSpeech: string;
  verbForms?: VerbForms;
  definition: string;
  meaning: string;
  usageTip: string;
  voice?: 'female' | 'male';
  tests?: AuthoredVocabularyTest[];
  metadata?: { schemaVersion: 2; cefrEstimate: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'; domains: string[]; gradeEstimate: VocabularyLevel; levelPolicy: string };
  examples: { id: string; context: string; text: string; translation: string }[];
  recall: { prompt: string; answers: string[]; explanation: string; alternatives?: { answer: string; explanation: string }[] };
  production: { prompt: string; modelAnswer: string; checkpoints: string[] };
  questions: {
    id: string;
    type: 'usage' | 'context' | 'paraphrase';
    prompt: string;
    choices: string[];
    correctIndex: number;
    explanation: string;
  }[];
};

export type VocabularyAudio = {
  wordId: string;
  url: string;
  voiceLabel: string;
  state: 'ready' | 'missing' | 'pending' | 'failed';
  segments?: { id: string; startSeconds: number; endSeconds: number }[];
};
