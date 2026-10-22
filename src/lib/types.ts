export type Subject = '古文' | '漢文' | '英語';
export type Role = 'parent' | 'student';
export type PracticeMode = 'daily' | 'extra' | 'weak';
export type QuestionStatus = 'draft' | 'approved' | 'published' | 'archived';

export interface Topic {
  id: string; title: string; subject: Subject; description: string;
  createdAt: string; targetCount: number;
}
export interface SourceDocument {
  id: string; topicId: string; name: string; mimeType: string;
  storagePath?: string; previewUrl?: string; createdAt: string;
}
export interface Question {
  id: string; topicId: string; prompt: string; choices: string[];
  correctIndex: number; explanation: string; learningPoint: string;
  sourceIds: string[]; sourceNote: string; status: QuestionStatus;
  version: number; createdAt: string; publishedAt?: string;
  needsReview?: boolean;
}
export interface Attempt {
  id: string; userId: string; questionId: string; questionVersion: number;
  sessionId: string; selectedIndex: number; correct: boolean;
  answeredAt: string;
}
export interface Exposure {
  id: string; userId: string; questionId: string; questionVersion: number;
  sessionId: string; shownAt: string;
}
export interface PracticeSession {
  id: string; userId: string; mode: PracticeMode; questionIds: string[];
  createdAt: string; completedAt?: string;
}
export interface GenerationJob {
  id: string; topicId: string;
  status: 'queued' | 'running' | 'review' | 'failed';
  targetCount: number; generatedCount: number; createdAt: string;
  error?: string;
}
export interface Profile {
  id: string; familyId: string; name: string; role: Role;
}
export interface StudyData {
  topics: Topic[]; sources: SourceDocument[]; questions: Question[];
  attempts: Attempt[]; exposures: Exposure[]; sessions: PracticeSession[];
  jobs: GenerationJob[]; profiles: Profile[];
}
export interface QuestionProgress {
  questionId: string; totalAnswered: number; correctCount: number;
  wrongCount: number; accuracy: number | null; streak: number;
  stage: number; lastAnsweredAt: string | null; nextReviewAt: string | null;
  lastCorrect: boolean | null;
}
export interface TopicStats {
  total: number; exposed: number; answered: number; unattempted: number;
  coverageRate: number; firstAccuracy: number | null;
  reviewAccuracy: number | null; dueCount: number; weakCount: number;
}
export interface DailyActivity {
  date: string; answers: number; correct: number; firstAnswers: number;
  firstCorrect: number;
}
