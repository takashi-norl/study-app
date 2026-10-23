import type { LearningPlan, Profile, Question, SourceDocument, StudyData } from '@/lib/types';
import { ApiError } from './config';

/** Roles grant system capabilities, never access to another person's study data. */
export function canAccessSource(source: Pick<SourceDocument, 'ownerId'|'testOnly'>, profile: Profile): boolean {
  return source.ownerId === profile.id && (!source.testOnly || profile.accessLevel === 'superuser');
}

export function canAccessPlan(plan: Pick<LearningPlan, 'ownerId'|'testOnly'>, profile: Profile): boolean {
  return plan.ownerId === profile.id && (!plan.testOnly || profile.accessLevel === 'superuser');
}

export function canAccessQuestion(question: Pick<Question, 'audienceUserId'|'testOnly'|'ownerId'> & { requestedBy?: string; libraryPublished?: boolean }, profile: Profile): boolean {
  return !question.libraryPublished && (question.ownerId ?? question.requestedBy ?? question.audienceUserId) === profile.id
    && (!question.testOnly || profile.accessLevel === 'superuser');
}

export function assertOwnQuestion(data: StudyData, profile: Profile, questionId: string): Question {
  const question = data.questions.find(item => item.id === questionId);
  const topic = data.topics.find(item => item.id === question?.topicId);
  if (!question || !topic || !canAccessQuestion(topic, profile) || !canAccessQuestion(question, profile)) {
    throw new ApiError(404, '自分の問題が見つかりません。', 'QUESTION_NOT_FOUND');
  }
  return question;
}
