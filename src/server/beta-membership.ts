import 'server-only';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Profile } from '@/lib/types';
import type { LoginProvider } from '@/lib/login-provider';
import { ApiError } from './config';
import { assertSuperUser, getAuthConfig, getRegisteredAccounts, profileForAccount } from './env';
import { appendEvent, loadOperationsEvents, type StudyEvent } from './google-store';
import { BETA_MEMBER_LIMIT, betaAccessRevokedSchema, betaMemberId, betaMemberIdentity, betaTokenHash, foldBetaMembership, profileForBetaMember } from './beta-membership-schema';

export const BETA_INVITE_COOKIE = 'hibi-beta-invitation';
export const APPLE_BETA_INVITE_COOKIE = '__Host-hibi-apple-invitation';
export const betaTokenSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
export const createBetaInvitationSchema = z.object({ requestId: z.string().uuid(), email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(80), expiresInDays: z.number().int().min(1).max(14).default(7) }).strict();
export const acceptBetaInvitationSchema = z.object({ token: betaTokenSchema, provider: z.enum(['google', 'apple']).default('google') }).strict();
export { betaAccessRevokedSchema };
interface MembershipStore { load: () => Promise<StudyEvent[]>; append: (event: StudyEvent) => Promise<void>; now: () => Date }
const storeFor = (overrides: Partial<MembershipStore>): MembershipStore => ({ load: loadOperationsEvents, append: appendEvent, now: () => new Date(), ...overrides });
const invitationError = () => new ApiError(403, 'この招待は利用できません。招待した人に新しいリンクを確認してください。', 'INVITATION_UNAVAILABLE');

export function betaAdministrationState(events: StudyEvent[], now = new Date()) {
  const state = foldBetaMembership(events);
  return {
    invitations: [...state.invitations.values()].reverse().map(({ tokenHash: _secret, ...invitation }) => ({ ...invitation,
      status: state.revokedInvitations.has(invitation.id) ? 'revoked' : invitation.usedBy ? 'used' : Date.parse(invitation.expiresAt) <= now.getTime() ? 'expired' : 'available' })),
    members: [...state.members.values()].map(({ googleSubject: _google, authSubject: _subject, authProvider: _provider, ...member }) => ({ ...member, active: !state.revokedMembers.has(member.id) })),
  };
}

export async function createBetaInvitation(profile: Profile, raw: unknown, overrides: Partial<MembershipStore> = {}) {
  assertSuperUser(profile);
  const input = createBetaInvitationSchema.parse(raw), store = storeFor(overrides), events = await store.load(), state = foldBetaMembership(events);
  // Recover the same link after a lost response without storing a usable invitation token.
  const token = createHmac('sha256', getAuthConfig().secret).update(`beta-invite\0${input.requestId}\0${input.email}`).digest('base64url');
  const tokenHash = betaTokenHash(token), previous = state.invitations.get(input.requestId);
  if (previous) {
    if (previous.email !== input.email || previous.name !== input.name || previous.tokenHash !== tokenHash
      || Date.parse(previous.expiresAt)-Date.parse(previous.createdAt) !== input.expiresInDays*86400000) {
      throw new ApiError(409, 'この発行番号は別の招待に使われています。再読み込みしてください。', 'REQUEST_CONFLICT');
    }
    if (state.revokedInvitations.has(previous.id) || previous.usedBy || Date.parse(previous.expiresAt) <= store.now().getTime()) throw invitationError();
    return { token, invitation: { id: previous.id, email: previous.email, name: previous.name, expiresAt: previous.expiresAt } };
  }
  if (getRegisteredAccounts().some(member => member.email === input.email) || [...state.members.values()].some(member => member.email === input.email)) {
    throw new ApiError(409, 'このメールアドレスは登録済みです。最初に登録したログイン方法を使ってください。', 'MEMBER_EXISTS');
  }
  const reservedInvitations = [...state.invitations.values()].filter(invitation => !invitation.usedBy && !state.revokedInvitations.has(invitation.id)
    && Date.parse(invitation.expiresAt) > store.now().getTime()).length;
  if (state.members.size + reservedInvitations >= BETA_MEMBER_LIMIT) throw new ApiError(429, 'ベータ版の招待上限に達しました。', 'BETA_LIMIT');
  const createdAt = store.now().toISOString(), invitation = { id: input.requestId, email: input.email, name: input.name, tokenHash,
    expiresAt: new Date(Date.parse(createdAt)+input.expiresInDays*86400000).toISOString() };
  await store.append({ id: `beta-invitation:${invitation.id}`, type: 'beta.invitation.created', actorId: profile.id, createdAt, payload: invitation });
  const saved = foldBetaMembership(await store.load()).invitations.get(invitation.id);
  if (!saved || saved.tokenHash !== tokenHash || saved.email !== input.email || saved.name !== input.name) throw new ApiError(409, '招待の保存を確認できませんでした。同じ内容で再試行してください。', 'INVITATION_CONFLICT');
  return { token, invitation: { id: invitation.id, email: invitation.email, name: invitation.name, expiresAt: invitation.expiresAt } };
}

export async function checkBetaInvitation(token: string, overrides: Partial<MembershipStore> = {}) {
  if (!betaTokenSchema.safeParse(token).success) throw invitationError();
  const store = storeFor(overrides), state = foldBetaMembership(await store.load());
  const invitation = [...state.invitations.values()].find(entry => entry.tokenHash === betaTokenHash(token));
  if (!invitation || invitation.usedBy || state.revokedInvitations.has(invitation.id) || state.revokedMembers.has(betaMemberId(invitation.email))
    || Date.parse(invitation.expiresAt) <= store.now().getTime()) throw invitationError();
  // This public endpoint deliberately does not reveal the invited address or name.
  return { expiresAt: invitation.expiresAt };
}

export async function resolveRegisteredMember(email: string, subject?: string, overrides: Partial<MembershipStore> = {}, provider: LoginProvider = 'google') {
  const normalized = email.trim().toLowerCase();
  if (provider === 'apple') {
    if (!subject) return undefined;
    const state = foldBetaMembership(await storeFor(overrides).load());
    // Apple's stable subject identifies an existing account even when its verified email changes.
    // Never use that new email to adopt a Google/seed account or confer operator capabilities.
    const member = [...state.members.values()].find(entry => entry.authProvider === 'apple' && entry.authSubject === subject);
    return member && !state.revokedMembers.has(member.id) ? { email: member.email, profile: profileForBetaMember(member) } : undefined;
  }
  const seed = getRegisteredAccounts().find(member => member.email === normalized);
  // Seed accounts are existing Google identities, including the operator. Apple email alone cannot link them.
  if (seed) return provider === 'google' ? { email: seed.email, profile: profileForAccount(seed) } : undefined;
  if (!subject) return undefined;
  const state = foldBetaMembership(await storeFor(overrides).load());
  const member = state.members.get(betaMemberId(normalized));
  return member && member.email === normalized && betaMemberIdentity(member).provider === provider
    && betaMemberIdentity(member).subject === subject && !state.revokedMembers.has(member.id)
    ? { email: member.email, profile: profileForBetaMember(member) } : undefined;
}

/** The caller supplies a verified provider identity, never an email/name from the invite form. */
export async function registerInvitedMember(token: string, email: string, subject: string, overrides: Partial<MembershipStore> = {}, provider: LoginProvider = 'google') {
  if (!betaTokenSchema.safeParse(token).success || !subject || subject.length > 200) return undefined;
  const store = storeFor(overrides), normalized = email.trim().toLowerCase(), existing = await resolveRegisteredMember(normalized, subject, overrides, provider);
  if (existing) return existing;
  if (getRegisteredAccounts().some(member => member.email === normalized)) return undefined;
  const state = foldBetaMembership(await store.load()), id = betaMemberId(normalized);
  if (state.members.size >= BETA_MEMBER_LIMIT || state.members.has(id) || state.revokedMembers.has(id)) return undefined;
  const invitation = [...state.invitations.values()].find(entry => entry.tokenHash === betaTokenHash(token));
  if (!invitation || invitation.email !== normalized || invitation.usedBy || state.revokedInvitations.has(invitation.id)
    || Date.parse(invitation.expiresAt) <= store.now().getTime()) return undefined;
  await store.append({ id: `beta-member:${id}`, type: 'beta.member.registered', actorId: id, createdAt: store.now().toISOString(),
    payload: { invitationId: invitation.id, id, email: normalized, name: invitation.name,
      ...(provider === 'apple' ? { authProvider: 'apple', authSubject: subject } : { googleSubject: subject }) } });
  // Sheets appends can race; only the canonical registration may establish a session.
  return resolveRegisteredMember(normalized, subject, overrides, provider);
}

export async function revokeBetaAccess(profile: Profile, raw: unknown, overrides: Partial<MembershipStore> = {}) {
  assertSuperUser(profile);
  const input = betaAccessRevokedSchema.parse(raw), store = storeFor(overrides), state = foldBetaMembership(await store.load());
  if (!(input.kind === 'member' ? state.members : state.invitations).has(input.id)) throw new ApiError(404, '招待または登録が見つかりません。', 'MEMBER_NOT_FOUND');
  await store.append({ id: `beta-revoked:${input.kind}:${input.id}`, type: 'beta.access.revoked', actorId: profile.id, createdAt: store.now().toISOString(), payload: input });
  return betaAdministrationState(await store.load(), store.now());
}
