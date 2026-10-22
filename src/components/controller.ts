import type { PracticeMode, PracticeSession, Profile, Question, Role, StudyData, Subject } from '@/lib/types';

export interface StudyController {
  data: StudyData;
  profile: Profile;
  demo: boolean;
  ready: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  session: PracticeSession | null;
  currentQuestion: Question | null;
  feedback: { correct: boolean; correctIndex: number; explanation: string } | null;
  actions: {
    switchRole(role: Role): void;
    startPractice(mode: PracticeMode, topicId?: string): void | Promise<void>;
    answer(index: number): void | Promise<void>;
    nextQuestion(): void | Promise<void>;
    finishSession(): void | Promise<void>;
    createTopic(title: string, subject: Subject, description: string, targetCount: number): Promise<string | void>;
    uploadSources(topicId: string, files: File[]): Promise<void>;
    generate(topicId: string, targetCount: number): void | Promise<void>;
    resumeGeneration(jobId: string): void | Promise<void>;
    updateQuestion(id: string, patch: Partial<Question>): void | Promise<void>;
    publish(questionIds: string[], at?: string): void | Promise<void>;
    resetDemo(): void | Promise<void>;
    signIn(): Promise<void>;
    signOut(): void | Promise<void>;
    requestNotifications(): void | Promise<void>;
    exportData(): void | Promise<void>;
  };
}
