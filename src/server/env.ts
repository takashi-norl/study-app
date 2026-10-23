import 'server-only';
import { z } from 'zod';
import type { Profile } from '@/lib/types';
import type { TokenInfo } from 'google-auth-library';
import { ApiError, requiredEnv } from './config';

const memberSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.string().email().transform((email) => email.trim().toLowerCase()),
  name: z.string().min(1).max(80),
  role: z.enum(['parent', 'student']),
});
export type FamilyMember = z.infer<typeof memberSchema>;
const SUPER_USER_EMAIL = 'takashi.oikawa@gmail.com';

export function getFamilyId(): string {
  return process.env.FAMILY_ID?.trim() || 'family-primary';
}

/** An invalid or empty allowlist must never turn the app into an open sign-up service. */
export function getFamilyMembers(): FamilyMember[] {
  try {
    const parsed = z.array(memberSchema).min(1).max(20).parse(JSON.parse(requiredEnv('ALLOWED_FAMILY_MEMBERS_JSON')));
    if (!parsed.some((member) => member.role === 'parent')
      || new Set(parsed.map((member) => member.email)).size !== parsed.length
      || new Set(parsed.map((member) => member.id)).size !== parsed.length) throw new Error('Invalid allowlist');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, '登録アカウントの設定を確認してください。', 'INVALID_FAMILY_CONFIG');
  }
}

export function profileForMember(member: FamilyMember): Profile {
  const superUser = member.email.trim().toLowerCase() === SUPER_USER_EMAIL;
  return { id: member.id, name: member.name, role: superUser ? 'parent' : member.role, familyId: getFamilyId(),
    // Keep legacy roles for stored-record compatibility; only the operator has administrative access.
    accessLevel: superUser ? 'superuser' : 'learner' };
}

/** Only use with a profile obtained from the verified Google session, never a request body. */
export function assertSuperUser(profile: Profile): Profile {
  const member = getFamilyMembers().find(entry => entry.id === profile.id);
  if (profile.familyId !== getFamilyId() || member?.email !== SUPER_USER_EMAIL) {
    throw new ApiError(403, 'この画面は運営者だけが利用できます。', 'FORBIDDEN');
  }
  // Ignore stale or client-supplied role/accessLevel values and resolve the current allowlist.
  return profileForMember(member);
}

export function getAuthConfig() {
  const secret = requiredEnv('NEXTAUTH_SECRET');
  if (secret.length < 32) throw new ApiError(503, 'ログイン用の秘密鍵は32文字以上で設定してください。', 'INVALID_AUTH_CONFIG');
  return { clientId: requiredEnv('GOOGLE_CLIENT_ID'), clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'), secret };
}

function googleId(name: string): string {
  const value = requiredEnv(name);
  if (!/^[a-zA-Z0-9_-]{8,200}$/.test(value)) throw new ApiError(503, 'Google Driveの保存先設定を確認してください。', 'INVALID_DRIVE_CONFIG');
  return value;
}

export function getDriveConfig() {
  const auth = getAuthConfig();
  const tab = process.env.GOOGLE_SHEETS_EVENTS_TAB?.trim() || 'Events';
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(tab)) throw new ApiError(503, '学習記録のシート名を確認してください。', 'INVALID_DRIVE_CONFIG');
  return {
    clientId: auth.clientId, clientSecret: auth.clientSecret,
    refreshToken: requiredEnv('GOOGLE_DRIVE_REFRESH_TOKEN'),
    folderId: googleId('GOOGLE_DRIVE_FOLDER_ID'),
    spreadsheetId: googleId('GOOGLE_SHEETS_ID'), tab,
    ownerEmail: process.env.GOOGLE_DRIVE_OWNER_EMAIL?.trim().toLowerCase(),
  };
}

/** Refuse an accidentally broad grant instead of relying only on the setup instructions. */
export function assertStorageGrant(info: Pick<TokenInfo, 'aud' | 'scopes' | 'email'> & { email_verified?: boolean | string },
  config: { clientId: string; ownerEmail?: string }) {
  const allowed = new Set(['https://www.googleapis.com/auth/drive.file', 'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']);
  if (info.aud !== config.clientId || !info.scopes.includes('https://www.googleapis.com/auth/drive.file')
    || info.scopes.some((scope) => !allowed.has(scope))) {
    throw new ApiError(503, '保存用Google接続は、同じアプリのdrive.file権限で設定してください。', 'INVALID_GOOGLE_SCOPE');
  }
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (config.ownerEmail && (info.email?.toLowerCase() !== config.ownerEmail || !verified)) {
    throw new ApiError(503, '保存先の所有者アカウントでGoogle接続を設定してください。', 'INVALID_GOOGLE_OWNER');
  }
}
