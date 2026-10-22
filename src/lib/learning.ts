import type {
  Attempt, DailyActivity, Exposure, PracticeMode, Question, QuestionProgress, TopicStats,
} from './types';

const DAY = 86_400_000;
const JST_OFFSET = 9 * 60 * 60 * 1_000;
const REVIEW_DAYS = [1, 1, 3, 7, 14, 30] as const;

/** A stable calendar key, independent of the browser or server's timezone. */
export function formatJapanDate(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp + JST_OFFSET).toISOString().slice(0, 10) : '';
}

function visibleAttempts(attempts: Attempt[], userId: string, now: Date): Attempt[] {
  return attempts
    .filter((attempt) => attempt.userId === userId && Date.parse(attempt.answeredAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt) || a.id.localeCompare(b.id));
}

function isPublished(question: Question, now: Date): boolean {
  return question.status === 'published'
    && (!question.publishedAt || Date.parse(question.publishedAt) <= now.getTime());
}

function progressFromAttempts(questionId: string, history: Attempt[]): QuestionProgress {
  let correctCount = 0;
  let streak = 0;
  let stage = 0;
  let lastDay: string | null = null;
  let nextReviewAt: string | null = null;
  for (const attempt of history) {
    const day = formatJapanDate(attempt.answeredAt);
    let reschedule = !nextReviewAt;
    if (attempt.correct) {
      correctCount += 1;
      streak += 1;
      // A correction immediately after seeing an answer is practice, not spaced recall.
      if (day !== lastDay && (!nextReviewAt || Date.parse(attempt.answeredAt) >= Date.parse(nextReviewAt))) {
        stage = Math.min(stage + 1, REVIEW_DAYS.length - 1);
        reschedule = true;
      }
    } else {
      stage = 0;
      streak = 0;
      reschedule = true;
    }
    const startOfDay = Date.parse(`${day}T00:00:00+09:00`);
    if (reschedule) nextReviewAt = new Date(startOfDay + REVIEW_DAYS[stage] * DAY).toISOString();
    lastDay = day;
  }
  const last = history.at(-1);
  return {
    questionId,
    totalAnswered: history.length,
    correctCount,
    wrongCount: history.length - correctCount,
    accuracy: history.length ? correctCount / history.length : null,
    streak,
    stage,
    lastAnsweredAt: last?.answeredAt ?? null,
    nextReviewAt,
    lastCorrect: last?.correct ?? null,
  };
}

export function getQuestionProgress(
  questionId: string, attempts: Attempt[], userId: string, now = new Date(),
): QuestionProgress {
  return progressFromAttempts(questionId, visibleAttempts(attempts, userId, now)
    .filter((attempt) => attempt.questionId === questionId));
}

function groupAttempts(attempts: Attempt[], userId: string, now: Date): Map<string, Attempt[]> {
  const groups = new Map<string, Attempt[]>();
  for (const attempt of visibleAttempts(attempts, userId, now)) {
    const group = groups.get(attempt.questionId) ?? [];
    group.push(attempt);
    groups.set(attempt.questionId, group);
  }
  return groups;
}

/** Mix subjects without making random selection or the system timezone part of the outcome. */
function interleaveTopics(questions: Question[]): Question[] {
  const topics = new Map<string, Question[]>();
  for (const question of questions) {
    const group = topics.get(question.topicId) ?? [];
    group.push(question);
    topics.set(question.topicId, group);
  }
  const result: Question[] = [];
  for (let i = 0; result.length < questions.length; i += 1) {
    for (const group of topics.values()) if (group[i]) result.push(group[i]);
  }
  return result;
}

export function selectQuestions(
  questions: Question[], attempts: Attempt[], exposures: Exposure[], userId: string,
  mode: PracticeMode, now = new Date(), count = 10, topicId?: string,
): Question[] {
  const limit = Math.max(0, Math.floor(Number.isFinite(count) ? count : 10));
  if (!limit) return [];
  const today = formatJapanDate(now.toISOString());
  const groups = groupAttempts(attempts, userId, now);
  const progress = new Map<string, QuestionProgress>();
  const lastShown = new Map<string, number>();
  for (const exposure of exposures) {
    const shownAt = Date.parse(exposure.shownAt);
    if (exposure.userId === userId && shownAt <= now.getTime()) {
      lastShown.set(exposure.questionId, Math.max(lastShown.get(exposure.questionId) ?? 0, shownAt));
    }
  }
  // Published content can be used immediately after approval, or from a future release date.
  const eligible = questions.filter((question) => isPublished(question, now)
    && (!topicId || question.topicId === topicId));
  for (const question of eligible) {
    progress.set(question.id, progressFromAttempts(question.id, groups.get(question.id) ?? []));
  }
  const p = (question: Question) => progress.get(question.id)!;
  const due = (question: Question) => !!p(question).nextReviewAt
    && Date.parse(p(question).nextReviewAt!) <= now.getTime();
  const oldestShown = (a: Question, b: Question) => (lastShown.get(a.id) ?? 0)
    - (lastShown.get(b.id) ?? 0) || a.id.localeCompare(b.id);
  const weakOrder = (a: Question, b: Question) => Number(p(b).lastCorrect === false)
    - Number(p(a).lastCorrect === false)
    || (p(a).accuracy ?? 1) - (p(b).accuracy ?? 1)
    || p(b).wrongCount - p(a).wrongCount
    || oldestShown(a, b);

  if (mode === 'weak') {
    return eligible.filter((question) => p(question).wrongCount > 0).sort(weakOrder).slice(0, limit);
  }

  // A deliberate "weak questions" session may repeat a correct answer; ordinary sessions do not.
  const available = eligible.filter((question) => !(p(question).lastCorrect
    && formatJapanDate(p(question).lastAnsweredAt!) === today));
  const fresh = interleaveTopics(available.filter((question) => !p(question).totalAnswered).sort(oldestShown));
  const reviews = available.filter((question) => p(question).totalAnswered > 0);
  const dueReviews = reviews.filter(due).sort((a, b) => Date.parse(p(a).nextReviewAt!)
    - Date.parse(p(b).nextReviewAt!) || weakOrder(a, b));
  const notDueReviews = reviews.filter((question) => !due(question)).sort(weakOrder);
  const selected: Question[] = [];
  const ids = new Set<string>();
  const append = (list: Question[], maximum = limit) => {
    let added = 0;
    for (const question of list) {
      if (selected.length >= limit || added >= maximum) break;
      if (!ids.has(question.id)) {
        selected.push(question);
        ids.add(question.id);
        added += 1;
      }
    }
  };
  const newTarget = Math.ceil(limit * 0.6);
  append(fresh, newTarget);
  append(dueReviews, limit - newTarget);
  append(dueReviews);
  append(fresh);
  append(notDueReviews);
  return selected;
}

export function getTopicStats(
  topicId: string, questions: Question[], attempts: Attempt[], exposures: Exposure[],
  userId: string, now = new Date(),
): TopicStats {
  const published = questions.filter((question) => question.topicId === topicId && isPublished(question, now));
  const ids = new Set(published.map((question) => question.id));
  const groups = groupAttempts(attempts, userId, now);
  const exposed = new Set(exposures.filter((exposure) => exposure.userId === userId
    && ids.has(exposure.questionId) && Date.parse(exposure.shownAt) <= now.getTime())
    .map((exposure) => exposure.questionId));
  let answered = 0;
  let firstCorrect = 0;
  let reviewCount = 0;
  let reviewCorrect = 0;
  let dueCount = 0;
  let weakCount = 0;
  for (const question of published) {
    const history = groups.get(question.id) ?? [];
    if (!history.length) continue;
    answered += 1;
    firstCorrect += Number(history[0].correct);
    // Same-day retries remain in the answer log but do not inflate retention accuracy.
    const seenDays = new Set([formatJapanDate(history[0].answeredAt)]);
    for (const attempt of history.slice(1)) {
      const day = formatJapanDate(attempt.answeredAt);
      if (!seenDays.has(day)) {
        reviewCount += 1;
        reviewCorrect += Number(attempt.correct);
        seenDays.add(day);
      }
    }
    const progress = progressFromAttempts(question.id, history);
    if (progress.nextReviewAt && Date.parse(progress.nextReviewAt) <= now.getTime()) dueCount += 1;
    if (progress.wrongCount > 0 && progress.stage < 3) weakCount += 1;
  }
  return {
    total: published.length, exposed: exposed.size, answered,
    unattempted: published.length - answered,
    coverageRate: published.length ? exposed.size / published.length : 0,
    firstAccuracy: answered ? firstCorrect / answered : null,
    reviewAccuracy: reviewCount ? reviewCorrect / reviewCount : null,
    dueCount, weakCount,
  };
}

export function getDailyActivity(
  attempts: Attempt[], userId: string, days = 14, now = new Date(),
): DailyActivity[] {
  const length = Math.max(0, Math.floor(Number.isFinite(days) ? days : 14));
  const today = Date.parse(`${formatJapanDate(now.toISOString())}T00:00:00+09:00`);
  const activity: DailyActivity[] = Array.from({ length }, (_, index) => ({
    date: formatJapanDate(new Date(today - (length - 1 - index) * DAY).toISOString()),
    answers: 0, correct: 0, firstAnswers: 0, firstCorrect: 0,
  }));
  const byDate = new Map(activity.map((day) => [day.date, day]));
  const seen = new Set<string>();
  for (const attempt of visibleAttempts(attempts, userId, now)) {
    const first = !seen.has(attempt.questionId);
    seen.add(attempt.questionId);
    const day = byDate.get(formatJapanDate(attempt.answeredAt));
    if (!day) continue;
    day.answers += 1;
    day.correct += Number(attempt.correct);
    day.firstAnswers += Number(first);
    day.firstCorrect += Number(first && attempt.correct);
  }
  return activity;
}
