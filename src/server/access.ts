import type { LearningPlan, Profile, Question, SourceDocument } from '@/lib/types';

/** Older materials have no owner marker and remain visible only to parents. */
export function canAccessSource(source: Pick<SourceDocument, 'ownerId'>, profile: Profile): boolean {
  return profile.role === 'parent' || source.ownerId === profile.id;
}

/** Parents can inspect the child's planning; only the owner writes in the API. */
export function canAccessPlan(plan: Pick<LearningPlan, 'ownerId'>, profile: Profile): boolean {
  return profile.role === 'parent' || plan.ownerId === profile.id;
}

export function canAccessQuestion(question: Pick<Question, 'audienceUserId'>, profile: Profile): boolean {
  return profile.role === 'parent' || !question.audienceUserId || question.audienceUserId === profile.id;
}
