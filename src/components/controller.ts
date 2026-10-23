import type { PracticeMode, PracticeSession, Profile, Question, Role, StudyData, Subject } from '@/lib/types';

export interface UploadStatus {
  topicId?: string;
  fileName: string;
  current: number;
  total: number;
  completed: number;
  phase: 'preparing' | 'connecting' | 'uploading' | 'confirming' | 'complete' | 'failed';
  message: string;
}

export interface NewLearningPlan {
  title?: string;
  subject: string;
  goal: string;
  difficulty?: string;
  targetDate?: string;
  dailyQuestionTarget?: number;
  requestedQuestionCount?: number;
  testOnly?: boolean;
  sourceIds: string[];
}

export interface StudyController {
  data: StudyData;
  profile: Profile;
  demo: boolean;
  ready: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  uploadStatus: UploadStatus | null;
  sync: { checking: boolean; lastSyncedAt: number | null; error: string | null };
  session: PracticeSession | null;
  currentQuestion: Question | null;
  feedback: { correct: boolean; correctIndex: number; explanation: string } | null;
  actions: {
    refreshStatus(): Promise<void>;
    switchRole(role: Role): void;
    startPractice(mode: PracticeMode, topicId?: string): void | Promise<void>;
    answer(index: number): void | Promise<void>;
    nextQuestion(): void | Promise<void>;
    finishSession(): void | Promise<void>;
    createTopic(title: string, subject: Subject, description: string, targetCount: number): Promise<string | void>;
    uploadSources(topicId: string | undefined, files: File[]): Promise<void>;
    createPlan(input: NewLearningPlan): Promise<string | void>;
    sendPlanningMessage(planId: string, message: string): Promise<boolean>;
    resumePlanningTurn(turnId: string): Promise<void>;
    generateProposal(planId: string, turnId: string, proposalId: string, targetCount: number, schedule?: { dailyQuestionTarget: number; plannedDays: number }): Promise<string | void>;
    arrangeTopic(topicId: string): Promise<string | void>;
    publishLibrary(topicId: string): Promise<string | void>;
    requestLibraryPublication(topicId: string): Promise<boolean>;
    addLibraryPlan(topicId: string): Promise<string | void>;
    generate(topicId: string, targetCount: number, sourceIds?: string[]): void | Promise<void>;
    resumeGeneration(jobId: string): void | Promise<void>;
    retryGeneration(jobId: string): Promise<void>;
    updateQuestion(id: string, patch: Partial<Question>): void | Promise<void>;
    publish(questionIds: string[], at?: string): void | Promise<void>;
    resetDemo(): void | Promise<void>;
    signIn(): Promise<void>;
    signOut(): void | Promise<void>;
    requestNotifications(): void | Promise<void>;
    exportData(): void | Promise<void>;
  };
}
