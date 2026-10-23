import type { LearningPlan, Question, StudyData } from './types';
import { learnerQuestions } from './learner-library';
import { isPracticeReadyQuestion } from './library-policy';
import { getTopicStats } from './learning';

export const MAX_PLAN_TAGS = 8;
export const MAX_PLAN_TAG_LENGTH = 40;

/** The editor accepts Japanese punctuation as well as commas. Stored labels stay exact. */
export function parsePlanTags(input: string): string[] {
  return [...new Set(input.split(/[,、，\n]/).map(tag => tag.trim()).filter(Boolean))];
}

export function planTagsError(tags: string[]): string | null {
  if (tags.length > MAX_PLAN_TAGS) return `タグは${MAX_PLAN_TAGS}個までにしてください。`;
  if (tags.some(tag => tag.length > MAX_PLAN_TAG_LENGTH)) return `1つのタグは${MAX_PLAN_TAG_LENGTH}文字以内にしてください。`;
  return null;
}

export interface ProjectProgress {
  total: number;
  answered: number;
  percent: number | null;
  firstAccuracy: number | null;
  due: number;
}

export interface LearningPlanProgress {
  plan: LearningPlan;
  tags: string[];
  questions: Question[];
  topicIds: string[];
  progress: ProjectProgress;
}

export interface LearningProject {
  id: string;
  label: string;
  plans: LearningPlanProgress[];
  progress: ProjectProgress;
}

function uniqueQuestions(questions: Question[]): Question[] {
  return [...new Map(questions.map(question => [question.id, question])).values()];
}

function projectProgress(data: StudyData, questions: Question[], userId: string, now: Date): ProjectProgress {
  const topicId = '__learning_project__';
  const stats = getTopicStats(topicId, uniqueQuestions(questions).map(question => ({ ...question, topicId })),
    data.attempts, data.exposures, userId, now);
  return { total: stats.total, answered: stats.answered,
    percent: stats.total ? Math.round(stats.answered / stats.total * 100) : null,
    firstAccuracy: stats.firstAccuracy, due: stats.dueCount };
}

/** All group totals are calculated from the learner's current, practiceable question scope. */
export function learningProjects(data: StudyData, userId: string, now = new Date()): {
  plans: LearningPlanProgress[];
  groups: LearningProject[];
} {
  const plans = data.plans.filter(plan => plan.ownerId === userId && !plan.testOnly)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const ownPlanIds = new Set(plans.map(plan => plan.id));
  const hiddenPlanIds = new Set(data.plans.filter(plan => !ownPlanIds.has(plan.id)).map(plan => plan.id));
  const topics = new Map(data.topics.map(topic => [topic.id, topic]));
  const questions = uniqueQuestions(learnerQuestions(data, userId).filter(question => {
    const topic = topics.get(question.topicId);
    return !!topic && !topic.testOnly && !question.testOnly && isPracticeReadyQuestion(question)
      && (!question.publishedAt || Date.parse(question.publishedAt) <= now.getTime())
      && (!question.audienceUserId || question.audienceUserId === userId)
      && (!topic.audienceUserId || topic.audienceUserId === userId)
      && (!question.planId || !hiddenPlanIds.has(question.planId))
      && (!topic.planId || !hiddenPlanIds.has(topic.planId));
  }));
  const entries: LearningPlanProgress[] = plans.map(plan => {
    const planQuestions = questions.filter(question => question.planId === plan.id
      || topics.get(question.topicId)?.planId === plan.id || question.topicId === plan.libraryTopicId);
    return {
      plan, tags: [...new Set((plan.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
      questions: planQuestions,
      topicIds: [...new Set(planQuestions.map(question => question.topicId))],
      progress: projectProgress(data, planQuestions, userId, now),
    };
  });
  const group = (id: string, label: string, members: LearningPlanProgress[]): LearningProject => ({
    id, label, plans: members, progress: projectProgress(data, members.flatMap(item => item.questions), userId, now),
  });
  const tags = [...new Set(entries.flatMap(entry => entry.tags))].sort((a, b) => entries.filter(entry => entry.tags.includes(b)).length - entries.filter(entry => entry.tags.includes(a)).length || a.localeCompare(b, 'ja'));
  return { plans: entries, groups: [
    group('all', 'すべて', entries),
    ...tags.map(tag => group(`tag:${tag}`, tag, entries.filter(entry => entry.tags.includes(tag)))),
    group('untagged', '未分類', entries.filter(entry => !entry.tags.length)),
  ] };
}
