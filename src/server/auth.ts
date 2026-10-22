import 'server-only';
import { getServerSession, type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import type { Profile as StudyProfile, Role } from '@/lib/types';
import { ApiError } from './config';
import { getAuthConfig, getFamilyMembers, profileForMember } from './env';

declare module 'next-auth' {
  interface Session { profile?: StudyProfile }
}
declare module 'next-auth/jwt' {
  interface JWT { googleVerified?: boolean }
}

export function getAuthOptions(): NextAuthOptions {
  const config = getAuthConfig();
  getFamilyMembers();
  return {
    secret: config.secret,
    session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
    providers: [GoogleProvider({
      clientId: config.clientId, clientSecret: config.clientSecret,
      // Student and parent login do not request Drive permissions. Storage has a separate owner grant.
      authorization: { params: { scope: 'openid email profile' } },
    })],
    callbacks: {
      async signIn({ account, profile }) {
        const googleProfile = profile as { email?: string; email_verified?: boolean } | undefined;
        return account?.provider === 'google' && googleProfile?.email_verified === true
          && getFamilyMembers().some((member) => member.email === googleProfile.email?.trim().toLowerCase());
      },
      async jwt({ token, account, profile }) {
        if (account) {
          const googleProfile = profile as { email?: string; email_verified?: boolean } | undefined;
          token.googleVerified = account.provider === 'google' && googleProfile?.email_verified === true;
          token.email = googleProfile?.email?.trim().toLowerCase();
        }
        // Never put access_token or refresh_token into the browser's session/JWT.
        return token;
      },
      async session({ session, token }) {
        const member = token.googleVerified && typeof token.email === 'string'
          ? getFamilyMembers().find((entry) => entry.email === token.email!.toLowerCase()) : undefined;
        // Resolve current server-side membership on every access, so removing a member takes effect.
        session.profile = member ? profileForMember(member) : undefined;
        if (session.user) {
          session.user.name = member?.name ?? null;
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
  if (!session?.profile) throw new ApiError(401, '家族のGoogleアカウントでログインしてください。', 'UNAUTHENTICATED');
  if (role && session.profile.role !== role) throw new ApiError(403, 'この操作を行う権限がありません。', 'FORBIDDEN');
  return { profile: session.profile };
}
