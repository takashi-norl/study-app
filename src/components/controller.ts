import type { PracticeMode, PracticeSession, Profile, Question, Role, StudyData, Subject } from '@/lib/types';
import type { StudyAuthStatus } from '@/lib/study-auth';

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
  tags?: string[];
  testOnly?: boolean;
  sourceIds: string[];
}

export interface StudyController {
  /** Read-only learner rehearsal; all practice state is held only in memory. */
  preview?: boolean;
  data: StudyData;
  profile: Profile;
  demo: boolean;
  ready: boolean;
  authStatus: StudyAuthStatus;
  authError: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  uploadStatus: UploadStatus | null;
  sync: { checking: boolean; lastSyncedAt: number | null; error: string | null };
  practiceStart: { mode: PracticeMode; topicId?: string } | null;
  answerConfirmation: boolean;
  session: PracticeSession | null;
  currentQuestion: Question | null;
  feedback: { correct: boolean; correctIndex: number; explanation: string; selectedIndex: number } | null;
  actions: {
    retryAuth(): Promise<void>;
    refreshStatus(): Promise<void>;
    switchRole(role: Role): void;
    startPractice(mode: PracticeMode, topicId?: string): void | Promise<void>;
    beginPractice(requireConfirmation: boolean): void | Promise<void>;
    cancelPracticeStart(): void;
    answer(index: number): boolean | Promise<boolean>;
    nextQuestion(): void | Promise<void>;
    finishSession(): void | Promise<void>;
    createTopic(title: string, subject: Subject, description: string, targetCount: number): Promise<string | void>;
    uploadSources(topicId: string | undefined, files: File[]): Promise<void>;
    createPlan(input: NewLearningPlan): Promise<string | void>;
    updatePlanTags(planId: string, tags: string[]): Promise<boolean>;
    sendPlanningMessage(planId: string, message: string): Promise<boolean>;
    resumePlanningTurn(turnId: string): Promise<void>;
    generateProposal(planId: string, turnId: string, proposalId: string, targetCount: number, schedule?: { dailyQuestionTarget: number; plannedDays: number }): Promise<string | void>;
    arrangeTopic(topicId: string): Promise<string | void>;
    publishLibrary(topicId: string): Promise<string | void>;
    requestLibraryPublication(topicId: string): Promise<boolean>;
    addLibraryPlan(topicId: string): Promise<string | void>;
    deliverToLearner(topicId: string, learnerId: string, projectName: string): Promise<string | void>;
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
