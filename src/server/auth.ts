import 'server-only';
import { getServerSession, type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import type { Profile as StudyProfile } from '@/lib/types';
import type { LoginProvider } from '@/lib/login-provider';
import { ApiError } from './config';
import { assertSuperUser, getAuthConfig, getRegisteredAccounts } from './env';
import { registerInvitedMember, resolveRegisteredMember } from './beta-membership';
import { getAppleAuthConfig } from './apple-auth-config';
import { appleOAuthCookies, verifiedLoginIdentity } from './auth-identity';

declare module 'next-auth' {
  interface Session { profile?: StudyProfile }
}
declare module 'next-auth/jwt' {
  interface JWT { googleVerified?: boolean; googleSubject?: string; authProvider?: LoginProvider; authSubject?: string; authVerified?: boolean }
}

interface MembershipOptions {
  inviteToken?: string;
  /** Only the actual /signin/apple or /callback/apple route selects cross-site proof cookies. */
  provider?: string;
  resolveMember?: typeof resolveRegisteredMember;
  registerMember?: typeof registerInvitedMember;
}

export function getAuthOptions(membership: MembershipOptions = {}): NextAuthOptions {
  const config = getAuthConfig();
  const apple = getAppleAuthConfig();
  getRegisteredAccounts();
  return {
    secret: config.secret,
    // The client visits /api/auth/session on startup/focus so NextAuth can renew the persistent cookie.
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
    pages: { error: '/join' },
    ...(apple && membership.provider === 'apple' ? { cookies: appleOAuthCookies() } : {}),
    providers: [GoogleProvider({
      clientId: config.clientId, clientSecret: config.clientSecret,
      // Login does not request Drive permissions. Storage has a separate owner grant.
      authorization: { params: { scope: 'openid email profile' } },
    }), ...(apple ? [AppleProvider({
      clientId: apple.clientId, clientSecret: apple.clientSecret,
      authorization: { params: { scope: 'email', response_mode: 'form_post' } },
      // NextAuth validates signature, issuer, audience and these browser-bound OAuth proofs.
      checks: ['state', 'pkce', 'nonce'],
    })] : [])],
    callbacks: {
      async signIn({ account, profile }) {
        const identity = verifiedLoginIdentity(account, profile, apple?.clientId);
        if (!identity) return false;
        const { email, subject, provider } = identity;
        const member = await (membership.resolveMember ?? resolveRegisteredMember)(email, subject, {}, provider);
        if (member) return true;
        const registered = membership.inviteToken
          && await (membership.registerMember ?? registerInvitedMember)(membership.inviteToken, email, subject, {}, provider);
        return registered ? true : provider === 'apple' ? '/join?error=AppleAccessDenied' : false;
      },
      async jwt({ token, account, profile }) {
        if (account) {
          const identity = verifiedLoginIdentity(account, profile, apple?.clientId);
          // A provider switch must never retain Google claims from an earlier session.
          delete token.googleVerified; delete token.googleSubject;
          token.authVerified = !!identity;
          token.authProvider = identity?.provider;
          token.authSubject = identity?.subject;
          token.email = identity?.email;
          if (identity?.provider === 'google') {
            token.googleVerified = true; token.googleSubject = identity.subject;
          }
        }
        // Never put access_token or refresh_token into the browser's session/JWT.
        return token;
      },
      async session({ session, token }) {
        const legacyGoogle = token.authProvider === undefined && token.authVerified === undefined && token.googleVerified === true;
        const provider = token.authVerified === true ? token.authProvider : legacyGoogle ? 'google' : undefined;
        const subject = token.authVerified === true ? token.authSubject : token.googleSubject;
        const member = (provider === 'google' || provider === 'apple') && (subject || legacyGoogle) && typeof token.email === 'string'
          ? await (membership.resolveMember ?? resolveRegisteredMember)(token.email, subject, {}, provider) : undefined;
        // Resolve current server-side membership on every access, so removing a member takes effect.
        session.profile = member?.profile;
        if (session.user) {
          session.user.name = member?.profile.name ?? null;
          session.user.email = member?.email ?? null;
          session.user.image = null;
        }
        return session;
      },
    },
    logger: {
      error(code) { console.error('Authentication failure:', code); },
      warn(code) { console.warn('Authentication warning:', code); },
      debug() {},
    },
  };
}

export async function requireProfile(): Promise<{ profile: StudyProfile }> {
  const session = await getServerSession(getAuthOptions());
  if (!session?.profile) throw new ApiError(401, '登録したアカウントでログインしてください。', 'UNAUTHENTICATED');
  return { profile: session.profile };
}

export async function requireSuperUser(): Promise<{ profile: StudyProfile }> {
  const { profile } = await requireProfile();
  return { profile: assertSuperUser(profile) };
}
