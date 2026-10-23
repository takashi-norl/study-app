import type { VerbForms } from './verb-forms';

export type VocabularyEntry = {
  id: string;
  word: string;
  level: '2級' | '準1級';
  ipa: string;
  ipaLabel: string;
  partOfSpeech: string;
  verbForms?: VerbForms;
  definition: string;
  meaning: string;
  usageTip: string;
  voice?: 'female' | 'male';
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
