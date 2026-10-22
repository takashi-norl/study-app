import type { Profile, Question, StudyData, Topic } from './types';

/** Resolve old records without rewriting audience fields used by in-flight workflows. */
export function topicOwnerId(data: StudyData, topic: Topic): string | undefined {
  if (topic.libraryPublished) return undefined;
  return data.plans.find(plan => plan.id === topic.planId)?.ownerId ?? topic.ownerId
    ?? data.jobs.find(job => job.topicId === topic.id && job.requestedBy)?.requestedBy ?? topic.audienceUserId;
}

export function mayPracticeLibraryTopic(data: StudyData, profile: Profile, topic: Topic): boolean {
  if (topic.testOnly) return profile.role === 'parent';
  if (topic.libraryPublished) return data.plans.some(plan => plan.ownerId === profile.id && !plan.testOnly && plan.libraryTopicId === topic.id);
  return topicOwnerId(data, topic) === profile.id;
}

/** Approval is editing metadata, not a gate to practicing your saved questions. */
export function isPracticeReadyQuestion(question: Question, _now = new Date()): boolean {
  return question.status !== 'archived';
}

export function asPracticeQuestion(question: Question): Question {
  return { ...question, status: question.status === 'archived' ? 'archived' : 'published', publishedAt: question.createdAt };
}
