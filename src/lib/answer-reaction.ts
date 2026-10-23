import type { Attempt } from './types';

type SessionAttempt = Pick<Attempt, 'id' | 'sessionId' | 'questionId' | 'correct' | 'answeredAt'>;

export interface SessionAnswerStats {
  answered: number;
  correct: number;
  streak: number;
  bestStreak: number;
  lastCorrect: boolean | null;
  previousCorrect: boolean | null;
}

/** The current practice only; this streak is separate from long-term review progress. */
export function sessionAnswerStats(
  attempts: readonly SessionAttempt[], sessionId: string, questionIds?: readonly string[],
): SessionAnswerStats {
  const seenIds = new Set<string>();
  const byQuestion = new Map<string, SessionAttempt>();
  for (const attempt of attempts) {
    if (attempt.sessionId !== sessionId || seenIds.has(attempt.id)) continue;
    seenIds.add(attempt.id);
    if (byQuestion.has(attempt.questionId)) continue;
    byQuestion.set(attempt.questionId, attempt);
  }
  // Supplying the questions up to the visible question also excludes any later answers.
  const ordered = questionIds
    ? [...new Set(questionIds)].flatMap(id => byQuestion.has(id) ? [byQuestion.get(id)!] : [])
    : [...byQuestion.values()].sort((left, right) => Date.parse(left.answeredAt) - Date.parse(right.answeredAt));
  const stats: SessionAnswerStats = { answered: 0, correct: 0, streak: 0, bestStreak: 0, lastCorrect: null, previousCorrect: null };
  for (const attempt of ordered) {
    stats.answered++;
    stats.correct += Number(attempt.correct);
    stats.streak = attempt.correct ? stats.streak + 1 : 0;
    stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
    stats.previousCorrect = stats.lastCorrect;
    stats.lastCorrect = attempt.correct;
  }
  return stats;
}

export interface AnswerReaction {
  message: string;
  vibration: number | number[];
  milestone: 3 | 5 | 10 | null;
}

export function answerReaction(correct: boolean, streak: number, comeback = false): AnswerReaction {
  const milestone = correct && (streak === 3 || streak === 5 || streak === 10) ? streak : null;
  return {
    message: !correct ? 'くやしい、次こそ！'
      : milestone ? `${milestone}問連続！ その調子。`
      : comeback ? 'よし、切り替えた！' : '正解！ いい感じ。',
    vibration: !correct ? [10, 75, 10] : milestone ? [18, 45, 18] : 18,
    milestone,
  };
}

export interface AnswerVibrationEnvironment {
  navigator?: { vibrate?: (pattern: number | number[]) => boolean };
  matchMedia?: (query: string) => { matches: boolean };
  visibilityState?: string;
}

/** Call once for a newly accepted result. The caller owns result deduplication and preferences. */
export function vibrateAnswer(
  reaction: Pick<AnswerReaction, 'vibration'>, enabled: boolean, environment?: AnswerVibrationEnvironment,
): boolean {
  if (!enabled) return false;
  try {
    const browser = environment ?? {
      navigator: typeof navigator === 'undefined' ? undefined : navigator,
      matchMedia: typeof window === 'undefined' || typeof window.matchMedia !== 'function'
        ? undefined : (query: string) => window.matchMedia(query),
      visibilityState: typeof document === 'undefined' ? undefined : document.visibilityState,
    };
    if (browser.visibilityState !== 'visible'
      || browser.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      || typeof browser.navigator?.vibrate !== 'function') return false;
    // Keep the receiver for native browser methods. A true result is acceptance, not a hardware guarantee.
    return browser.navigator.vibrate(Array.isArray(reaction.vibration) ? [...reaction.vibration] : reaction.vibration) === true;
  } catch {
    return false;
  }
}
