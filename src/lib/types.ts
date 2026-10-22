export type Subject = string;
export type Role = 'parent' | 'student';
export type AccessLevel = 'superuser' | 'manager' | 'learner';
export type PracticeMode = 'daily' | 'extra' | 'weak';
export type QuestionStatus = 'draft' | 'approved' | 'published' | 'archived';

export interface Topic {
  id: string; title: string; subject: Subject; description: string;
  createdAt: string; targetCount: number;
  audienceUserId?: string; planId?: string;
  testOnly?: boolean; libraryPublished?: boolean; librarySourceTopicId?: string;
}
export interface SourceDocument {
  id: string; topicId?: string; ownerId?: string; name: string; mimeType: string;
  storagePath?: string; previewUrl?: string; createdAt: string;
  testOnly?: boolean;
}
export interface Question {
  id: string; topicId: string; prompt: string; choices: string[];
  correctIndex: number; explanation: string; learningPoint: string;
  sourceIds: string[]; sourceNote: string; status: QuestionStatus;
  version: number; createdAt: string; publishedAt?: string;
  needsReview?: boolean;
  audienceUserId?: string; planId?: string;
  testOnly?: boolean;
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
  audienceUserId?: string; planId?: string; sourceIds?: string[];
  instructions?: string; requestedBy?: string; proposalId?: string;
  turnId?: string; requestId?: string;
  retryOfJobId?: string;
  testOnly?: boolean;
}
export interface LearningPlan {
  id: string; ownerId: string; title: string; subject: Subject;
  goal: string; difficulty: string; targetDate?: string; dailyQuestionTarget: number;
  requestedQuestionCount?: number;
  testOnly?: boolean; libraryTopicId?: string;
  sourceIds: string[]; version: number; createdAt: string; updatedAt: string;
}
export interface PlanningProposal {
  id: string; title: string; subject: Subject; description: string;
  instructions: string; difficulty: string; targetCount: number;
  format: 'multiple-choice'; sourceIds: string[];
}
export interface PlanningTurn {
  id: string; planId: string; requestedBy: string; version: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
  message: string; reply?: string; proposals?: PlanningProposal[];
  createdAt: string; completedAt?: string; error?: string;
  startedAt?: string; updatedAt?: string; workflowRunId?: string;
  progress?: {
    phase: 'queued' | 'preparing' | 'reading_sources' | 'thinking' | 'saving' | 'complete' | 'failed';
    sourcesCompleted: number; sourcesTotal: number;
    /** Number without saved analysis when this turn was accepted; remains fixed. */
    sourcesRequiringAnalysis?: number;
    /** Successful request-to-response observations for this turn; not full per-file processing times. */
    readingSample?: { count: number; minSeconds: number; maxSeconds: number };
  };
}
export interface Profile {
  id: string; familyId: string; name: string; role: Role;
  accessLevel?: AccessLevel;
}
export interface StudyData {
  topics: Topic[]; sources: SourceDocument[]; questions: Question[];
  attempts: Attempt[]; exposures: Exposure[]; sessions: PracticeSession[];
  jobs: GenerationJob[]; profiles: Profile[];
  plans: LearningPlan[]; planningTurns: PlanningTurn[];
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
