import type { LearningPlan, Profile, Question, SourceDocument } from '@/lib/types';

/** Older materials have no owner marker and remain visible only to parents. */
export function canAccessSource(source: Pick<SourceDocument, 'ownerId'|'testOnly'>, profile: Profile): boolean {
  return profile.role === 'parent' || (!source.testOnly && source.ownerId === profile.id);
}

/** Parents can inspect the child's planning; only the owner writes in the API. */
export function canAccessPlan(plan: Pick<LearningPlan, 'ownerId'|'testOnly'>, profile: Profile): boolean {
  return profile.role === 'parent' || (!plan.testOnly && plan.ownerId === profile.id);
}

export function canAccessQuestion(question: Pick<Question, 'audienceUserId'|'testOnly'|'ownerId'>, profile: Profile): boolean {
  return profile.role === 'parent' || (!question.testOnly && (question.ownerId ? question.ownerId === profile.id : !question.audienceUserId || question.audienceUserId === profile.id));
}
