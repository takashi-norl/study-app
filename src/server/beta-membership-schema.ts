import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Profile } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { getFamilyId, getFamilyMembers, profileForMember } from './env';

const email = z.string().trim().toLowerCase().email().max(254);
const memberId = z.string().regex(/^beta-[a-f0-9]{40}$/);
export const BETA_MEMBER_LIMIT = 50;
export const betaInvitationCreatedSchema = z.object({
  id: z.string().uuid(), email, name: z.string().trim().min(1).max(80),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
}).strict();
export const betaMemberRegisteredSchema = z.object({
  invitationId: z.string().uuid(), id: memberId, email, name: z.string().trim().min(1).max(80),
  googleSubject: z.string().min(1).max(200),
}).strict();
export const betaAccessRevokedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invitation'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('member'), id: memberId }).strict(),
]);
export type BetaInvitation = z.infer<typeof betaInvitationCreatedSchema> & { createdAt: string; usedBy?: string };
export type BetaMember = z.infer<typeof betaMemberRegisteredSchema> & { createdAt: string };
export const betaMemberId = (address: string) => `beta-${createHash('sha256').update(`${getFamilyId()}\0${address.trim().toLowerCase()}`).digest('hex').slice(0,40)}`;
export const betaTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Replay only server-authorized invitations. An invitation never grants a manager role. */
export function foldBetaMembership(events: readonly StudyEvent[]) {
  const seeds = getFamilyMembers();
  const administrators = new Set(seeds.filter(member => profileForMember(member).accessLevel === 'superuser').map(member => member.id));
  const invitations = new Map<string, BetaInvitation>(), members = new Map<string, BetaMember>();
  const revokedInvitations = new Set<string>(), revokedMembers = new Set<string>(), seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id) || (event.familyId && event.familyId !== getFamilyId())) continue;
    seen.add(event.id);
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    if (event.type === 'beta.invitation.created') {
      const parsed = betaInvitationCreatedSchema.safeParse(event.payload);
      if (!parsed.success || !administrators.has(event.actorId)) continue;
      const invite = parsed.data, expires = Date.parse(invite.expiresAt);
      if (event.id !== `beta-invitation:${invite.id}` || invitations.has(invite.id) || expires <= at || expires-at > 14*86400000) continue;
      invitations.set(invite.id, { ...invite, createdAt: event.createdAt });
    } else if (event.type === 'beta.access.revoked') {
      const parsed = betaAccessRevokedSchema.safeParse(event.payload);
      if (!parsed.success || !administrators.has(event.actorId)) continue;
      (parsed.data.kind === 'invitation' ? revokedInvitations : revokedMembers).add(parsed.data.id);
    } else if (event.type === 'beta.member.registered') {
      const parsed = betaMemberRegisteredSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      const member = parsed.data, invitation = invitations.get(member.invitationId);
      if (members.size >= BETA_MEMBER_LIMIT || !invitation || revokedInvitations.has(invitation.id) || invitation.usedBy || revokedMembers.has(member.id)
        || member.id !== betaMemberId(member.email) || event.actorId !== member.id || event.id !== `beta-member:${member.id}`
        || invitation.email !== member.email || invitation.name !== member.name
        || at < Date.parse(invitation.createdAt) || at >= Date.parse(invitation.expiresAt)
        || seeds.some(seed => seed.email === member.email || seed.id === member.id)
        || [...members.values()].some(existing => existing.email === member.email || existing.googleSubject === member.googleSubject)) continue;
      invitation.usedBy = member.id;
      members.set(member.id, { ...member, createdAt: event.createdAt });
    }
  }
  return { invitations, members, revokedInvitations, revokedMembers };
}

export function profileForBetaMember(member: BetaMember): Profile {
  return { id: member.id, name: member.name, familyId: getFamilyId(), role: 'student', accessLevel: 'learner' };
}

export function profilesWithBetaMembers(events: readonly StudyEvent[]): Profile[] {
  const state = foldBetaMembership(events);
  return [...getFamilyMembers().map(profileForMember), ...[...state.members.values()]
    .filter(member => !state.revokedMembers.has(member.id)).map(profileForBetaMember)];
}
