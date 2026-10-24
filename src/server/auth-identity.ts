import 'server-only';
import { z } from 'zod';
import type { LoginProvider } from '@/lib/login-provider';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
export interface VerifiedLoginIdentity { provider: LoginProvider; subject: string; email: string }

/** Called only with NextAuth's cryptographically verified ID-token claims, never body.user. */
export function verifiedLoginIdentity(account: { provider: string; providerAccountId: string } | null | undefined,
  profile: unknown, appleClientId?: string): VerifiedLoginIdentity | undefined {
  if (!account || !profile || typeof profile !== 'object') return undefined;
  const claims = profile as Record<string, unknown>;
  const email = emailSchema.safeParse(claims.email);
  // Preserve the existing Google callback contract; Apple always requires its signed sub claim.
  const subject = claims.sub ?? (account.provider === 'google' ? account.providerAccountId : undefined);
  if (!email.success || typeof subject !== 'string' || !subject || subject.length > 200
    || subject !== account.providerAccountId) return undefined;
  if (account.provider === 'google' && claims.email_verified === true) {
    return { provider: 'google', subject, email: email.data };
  }
  if (account.provider === 'apple' && appleClientId
    && claims.iss === 'https://appleid.apple.com' && claims.aud === appleClientId
    && (claims.email_verified === true || claims.email_verified === 'true')) {
    return { provider: 'apple', subject, email: email.data };
  }
  return undefined;
}

/** Apple posts across sites; only short-lived OAuth proof cookies need SameSite=None. */
export function appleOAuthCookies() {
  const options = { httpOnly: true, sameSite: 'none' as const, secure: true, path: '/', maxAge: 15 * 60 };
  return {
    state: { name: '__Host-hibi-apple-state', options },
    nonce: { name: '__Host-hibi-apple-nonce', options },
    pkceCodeVerifier: { name: '__Host-hibi-apple-pkce', options },
  };
}
