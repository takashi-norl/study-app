export const RELEASE_SEEN_KEY = 'hibi-study-release-seen-v1';

export function compareVersions(left: string, right: string): number | null {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!semver.test(left) || !semver.test(right)) return null;
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

/** A fresh browser establishes a baseline; a prior install sees this migration once. */
export function releaseNoticeState(input: { runningVersion: string; availableVersion: string; seenVersion: string | null; returningInstall?: boolean }) {
  const availableVsRunning = compareVersions(input.availableVersion, input.runningVersion);
  const seen = input.seenVersion && compareVersions(input.seenVersion, input.runningVersion) !== null ? input.seenVersion : null;
  if (availableVsRunning === null) return { show: false, nextSeen: seen ?? input.runningVersion, reloadAvailable: false };
  const newest = availableVsRunning >= 0 ? input.availableVersion : input.runningVersion;
  const show = seen ? compareVersions(newest, seen) === 1 : availableVsRunning > 0 || !!input.returningInstall;
  const nextSeen = seen && compareVersions(seen, newest) === 1 ? seen : newest;
  return { show, nextSeen, reloadAvailable: availableVsRunning > 0 };
}
