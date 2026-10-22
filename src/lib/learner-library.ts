import type { StudyData } from './types';

/** Scope parent dashboards to the learner's actual collection, not the admin's test catalog. */
export function learnerQuestions(data: StudyData, userId: string) {
  const adopted = new Set(data.plans.filter(plan => plan.ownerId === userId && !plan.testOnly).map(plan => plan.libraryTopicId));
  const topics = new Set(data.topics.filter(topic => !topic.testOnly
    && (!topic.audienceUserId || topic.audienceUserId === userId)
    && (!topic.libraryPublished || adopted.has(topic.id))).map(topic => topic.id));
  return data.questions.filter(question => topics.has(question.topicId) && !question.testOnly
    && (!question.audienceUserId || question.audienceUserId === userId));
}
