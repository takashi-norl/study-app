import type { PlanningTurn } from './types';

export function elapsedSeconds(start: string, now = Date.now()): number {
  const date = Date.parse(start);
  return Number.isFinite(date) ? Math.max(0, Math.floor((now - date) / 1000)) : 0;
}

/** Coarse updates avoid a constantly ticking countdown. */
export function durationLabel(seconds: number): string {
  if (seconds < 10) return '10秒未満';
  if (seconds < 60) return `${Math.floor(seconds / 10) * 10}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60 / 10) * 10 || ''}${seconds % 60 >= 10 ? '秒' : ''}`;
  return `${Math.floor(seconds / 3600)}時間${Math.floor(seconds % 3600 / 60) || ''}${seconds % 3600 >= 60 ? '分' : ''}`;
}

/** Only comparable, completed requests provide an estimate; never synthesize one from elapsed time. */
export function planningTimeEstimate(turn: PlanningTurn, history: PlanningTurn[]) {
  const progress = turn.progress;
  if (!progress || progress.sourcesRequiringAnalysis === undefined) return null;
  const samples = history.filter(item => item.id !== turn.id && item.status === 'complete' && item.completedAt &&
    item.progress?.sourcesTotal === progress.sourcesTotal &&
    item.progress?.sourcesRequiringAnalysis === progress.sourcesRequiringAnalysis &&
    Date.parse(item.completedAt) <= Date.parse(turn.createdAt) &&
    Date.parse(item.completedAt) >= Date.parse(turn.createdAt) - 30 * 86400000)
    .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!)).slice(0, 20)
    .map(item => (Date.parse(item.completedAt!) - Date.parse(item.createdAt)) / 1000)
    .filter(value => Number.isFinite(value) && value > 0);
  if (samples.length < 3) return null;
  return { lower: Math.floor(Math.min(...samples) / 10) * 10,
    upper: Math.max(10, Math.ceil(Math.max(...samples) / 10) * 10), count: samples.length };
}

export function readingTimeEstimate(turn: PlanningTurn) {
  const progress = turn.progress;
  const sample = progress?.readingSample;
  if (!progress || progress.phase !== 'reading_sources' || !sample || sample.count < 3 ||
    !Number.isFinite(sample.minSeconds) || !Number.isFinite(sample.maxSeconds) || sample.minSeconds <= 0 || sample.maxSeconds < sample.minSeconds) return null;
  const remaining = Math.max(0, progress.sourcesTotal - progress.sourcesCompleted);
  if (!remaining) return null;
  return { remaining, count: sample.count, lower: Math.floor(remaining * sample.minSeconds / 10) * 10,
    upper: Math.ceil(remaining * sample.maxSeconds / 10) * 10 };
}

export function planningWaitState(turn: PlanningTurn, history: PlanningTurn[], now = Date.now()) {
  const elapsed = elapsedSeconds(turn.createdAt, now);
  const idle = elapsedSeconds(turn.updatedAt || turn.createdAt, now);
  const estimate = planningTimeEstimate(turn, history);
  // A stale display is a reason to check, not evidence that a background job failed.
  const needsCheck = idle >= (turn.status === 'queued' ? 60 : 180);
  const overEstimate = !!estimate && elapsed > estimate.upper;
  return { elapsed, idle, estimate, needsCheck, overEstimate };
}
