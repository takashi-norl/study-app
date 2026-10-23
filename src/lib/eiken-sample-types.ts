export type EikenSample = {
  id: string;
  level: '2級' | '準1級';
  skill: 'Reading' | 'Listening' | 'Writing';
  title: string;
  instructions: string;
  formatNote: string;
  passage?: string;
  script?: { speaker: 'female' | 'male'; text: string }[];
  question: string;
  choices?: string[];
  correctIndex?: number;
  explanation: string;
  points?: string[];
  wordRange?: [number, number];
  modelAnswer?: string;
  rubric?: string[];
};

export type SampleAudio = {
  sampleId: string;
  url: string;
  voiceLabel: string;
  durationSeconds: number;
  state?: 'ready' | 'missing' | 'pending' | 'failed';
};
