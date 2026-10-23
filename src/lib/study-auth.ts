import type { LoginSessionResult } from './auth-session';
import type { Profile, StudyData } from './types';

export type StudyAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable';
export interface StudyStatePayload { data: StudyData; profile: Profile }
export type StudyAccessResult =
  | ({ status: 'authenticated' } & StudyStatePayload)
  | { status: 'unauthenticated' }
  | { status: 'unavailable'; message: string; identityChanged?: boolean };
export const STUDY_CONNECTION_ERROR = '学習データを読み込めませんでした。接続を確認して、もう一度お試しください。';

export function sameStudyIdentity(a: Profile, b: Profile): boolean {
  return a.id === b.id && a.familyId === b.familyId && a.role === b.role && a.accessLevel === b.accessLevel;
}

export function isStudyStatePayload(value: unknown): value is StudyStatePayload {
  if (!value || typeof value !== 'object') return false;
  const { data, profile } = value as Partial<StudyStatePayload>;
  return !!profile && typeof profile.id === 'string' && !!profile.id && profile.id !== 'guest'
    && typeof profile.familyId === 'string' && !!profile.familyId && typeof profile.name === 'string'
    && (profile.role === 'parent' || profile.role === 'student')
    && (profile.accessLevel === undefined || ['superuser', 'manager', 'learner'].includes(profile.accessLevel)) && !!data
    && ['topics', 'sources', 'questions', 'attempts', 'exposures', 'sessions', 'jobs', 'profiles', 'plans', 'planningTurns']
      .every(key => Array.isArray(data[key as keyof StudyData]));
}

export function studyAccessFailure(error: unknown): Exclude<StudyAccessResult, { status: 'authenticated' }> {
  // The state endpoint independently checks current membership, including revocation after session renewal.
  if (error && typeof error === 'object' && 'status' in error && error.status === 401) return { status: 'unauthenticated' };
  return { status: 'unavailable', message: STUDY_CONNECTION_ERROR };
}

/** Network/storage failures never mean signed out; only an explicit server rejection does. */
export async function checkStudyAccess(readSession: () => Promise<LoginSessionResult>,
  readState: (profile: Profile) => Promise<unknown>): Promise<StudyAccessResult> {
  try {
    const session = await readSession();
    if (session.status !== 'authenticated') return session;
    const state = await readState(session.profile);
    if (!isStudyStatePayload(state)) return { status: 'unavailable', message: STUDY_CONNECTION_ERROR };
    if (!sameStudyIdentity(session.profile, state.profile)) return { status: 'unavailable', message: STUDY_CONNECTION_ERROR, identityChanged: true };
    return { status: 'authenticated', data: state.data, profile: state.profile };
  } catch (error) { return studyAccessFailure(error); }
}
