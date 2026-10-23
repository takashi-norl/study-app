import type { Profile } from './types';

export type LoginSessionResult =
  | { status: 'authenticated'; profile: Profile }
  | { status: 'unauthenticated' }
  | { status: 'unavailable'; message: string };

const unavailable = (): LoginSessionResult => ({ status: 'unavailable',
  message: 'ログイン状態を確認できませんでした。接続を確認して、もう一度お試しください。' });

function sessionResult(value: unknown): LoginSessionResult {
  if (value === null) return { status: 'unauthenticated' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const session = value as Record<string, unknown>;
  if (session.error) return unavailable();
  if (session.profile === undefined || session.profile === null) {
    // NextAuth returns {} for no session, or a session without a profile for a removed member.
    return !Object.keys(session).length || typeof session.expires === 'string' || 'user' in session
      ? { status: 'unauthenticated' } : unavailable();
  }
  if (typeof session.profile !== 'object' || Array.isArray(session.profile)) return unavailable();
  const profile = session.profile as Record<string, unknown>;
  if (typeof profile.id !== 'string' || !profile.id || typeof profile.familyId !== 'string' || !profile.familyId
    || typeof profile.name !== 'string' || (profile.role !== 'parent' && profile.role !== 'student')) return unavailable();
  if (profile.accessLevel !== undefined && !['superuser', 'manager', 'learner'].includes(String(profile.accessLevel))) return unavailable();
  return { status: 'authenticated', profile: { id: profile.id, familyId: profile.familyId, name: profile.name, role: profile.role,
    ...(profile.accessLevel ? { accessLevel: profile.accessLevel as Profile['accessLevel'] } : {}) } };
}

/** Use NextAuth's public session route so its renewed HttpOnly cookie reaches the browser. */
export function createLoginSessionReader(request: typeof fetch = fetch, timeoutMs = 10_000) {
  let inFlight: Promise<LoginSessionResult> | null = null;
  let paused = false;
  function refresh(): Promise<LoginSessionResult> {
    if (paused) return Promise.resolve(unavailable());
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<LoginSessionResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (response.status === 401) return { status: 'unauthenticated' };
        if (!response.ok) return unavailable();
        return sessionResult(await response.json());
      } catch { return unavailable(); }
      finally { clearTimeout(timer); }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  return Object.assign(refresh, {
    // A late renewal must finish before signOut deletes the cookie; block new focus checks meanwhile.
    async pause(): Promise<void> { paused = true; await inFlight; },
    resume(): void { paused = false; },
  });
}

// Deduplicate concurrent checks only; every later visit rechecks current membership on the server.
export const refreshLoginSession = createLoginSessionReader();
export const pauseLoginSessionRefresh = () => refreshLoginSession.pause();
export const resumeLoginSessionRefresh = () => refreshLoginSession.resume();
