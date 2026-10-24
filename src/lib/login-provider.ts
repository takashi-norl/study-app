export type LoginProvider = 'google' | 'apple';

/** Only advertise a provider returned by the app's own NextAuth endpoint. */
export function appleLoginAvailable(providers: unknown): boolean {
  if (!providers || typeof providers !== 'object') return false;
  const apple = (providers as Record<string, unknown>).apple;
  return !!apple && typeof apple === 'object'
    && (apple as Record<string, unknown>).id === 'apple'
    && (apple as Record<string, unknown>).type === 'oauth';
}
