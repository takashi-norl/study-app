import 'server-only';
import { getServerSession, type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import type { Profile as StudyProfile, Role } from '@/lib/types';
import { ApiError } from './config';
import { assertSuperUser, getAuthConfig, getFamilyMembers } from './env';
import { registerInvitedMember, resolveRegisteredMember } from './beta-membership';

declare module 'next-auth' {
  interface Session { profile?: StudyProfile }
}
declare module 'next-auth/jwt' {
  interface JWT { googleVerified?: boolean; googleSubject?: string }
}

interface MembershipOptions {
  inviteToken?: string;
  resolveMember?: typeof resolveRegisteredMember;
  registerMember?: typeof registerInvitedMember;
}

export function getAuthOptions(membership: MembershipOptions = {}): NextAuthOptions {
  const config = getAuthConfig();
  getFamilyMembers();
  return {
    secret: config.secret,
    // The client visits /api/auth/session on startup/focus so NextAuth can renew the persistent cookie.
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
    pages: { error: '/join' },
    providers: [GoogleProvider({
      clientId: config.clientId, clientSecret: config.clientSecret,
      // Login does not request Drive permissions. Storage has a separate owner grant.
      authorization: { params: { scope: 'openid email profile' } },
    })],
    callbacks: {
      async signIn({ account, profile }) {
        const googleProfile = profile as { email?: string; email_verified?: boolean; sub?: string } | undefined;
        if (account?.provider !== 'google' || googleProfile?.email_verified !== true || !googleProfile.email) return false;
        const email = googleProfile.email.trim().toLowerCase(), subject = googleProfile.sub ?? account.providerAccountId;
        const member = await (membership.resolveMember ?? resolveRegisteredMember)(email, subject);
        if (member) return true;
        return !!(membership.inviteToken && subject
          && await (membership.registerMember ?? registerInvitedMember)(membership.inviteToken, email, subject));
      },
      async jwt({ token, account, profile }) {
        if (account) {
          const googleProfile = profile as { email?: string; email_verified?: boolean; sub?: string } | undefined;
          token.googleVerified = account.provider === 'google' && googleProfile?.email_verified === true;
          token.email = googleProfile?.email?.trim().toLowerCase();
          token.googleSubject = token.googleVerified ? googleProfile?.sub ?? account.providerAccountId : undefined;
        }
        // Never put access_token or refresh_token into the browser's session/JWT.
        return token;
      },
      async session({ session, token }) {
        const member = token.googleVerified && typeof token.email === 'string'
          ? await (membership.resolveMember ?? resolveRegisteredMember)(token.email, token.googleSubject) : undefined;
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

export async function requireProfile(role?: Role): Promise<{ profile: StudyProfile }> {
  const session = await getServerSession(getAuthOptions());
  if (!session?.profile) throw new ApiError(401, '登録したGoogleアカウントでログインしてください。', 'UNAUTHENTICATED');
  if (role && session.profile.role !== role) throw new ApiError(403, 'この操作を行う権限がありません。', 'FORBIDDEN');
  return { profile: session.profile };
}

export async function requireSuperUser(): Promise<{ profile: StudyProfile }> {
  const { profile } = await requireProfile();
  return { profile: assertSuperUser(profile) };
}
