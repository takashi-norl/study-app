import './legacy-production-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getAuthOptions } from '../../src/server/auth';
import { ApiError } from '../../src/server/config';
import { getRegisteredAccounts, profileForAccount } from '../../src/server/env';
import { betaAdministrationState, checkBetaInvitation, createBetaInvitation, registerInvitedMember, resolveRegisteredMember, revokeBetaAccess } from '../../src/server/beta-membership';
import { betaMemberId, foldBetaMembership, profilesWithBetaMembers } from '../../src/server/beta-membership-schema';
import type { StudyEvent } from '../../src/server/google-store';

const seeds = [{ id: 'admin', email: 'takashi.oikawa@gmail.com', name: '運営', },
  { id: 'existing-learner', email: 'existing@example.com', name: '既存', }];
const at = new Date('2026-10-23T10:00:00.000Z');
async function configured(action: () => Promise<void>) {
  const keys = ['REGISTERED_ACCOUNTS_JSON', 'NEXTAUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify(seeds);
  process.env.NEXTAUTH_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';
  process.env.GOOGLE_CLIENT_ID = 'test-client'; process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  try { await action(); } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
}
function harness() {
  const events: StudyEvent[] = [];
  let now = new Date(at);
  const deps = { load: async () => structuredClone(events), append: async (event: StudyEvent) => { events.push(structuredClone(event)); }, now: () => now };
  return { events, deps, setTime: (date: Date) => { now = date; } };
}
const admin = () => profileForAccount(getRegisteredAccounts()[0]);
const request = () => ({ requestId: randomUUID(), email: 'friend@example.com', name: '友達', expiresInDays: 7 });
async function registeredFixture(count: number) {
  const h = harness();
  for (let index = 0; index < count; index += 1) {
    const input = { ...request(), email: `registered-${index}@example.com` };
    const invitation = await createBetaInvitation(admin(), input, h.deps);
    assert.ok(await registerInvitedMember(invitation.token, input.email, `registered-sub-${index}`, h.deps));
  }
  return h;
}

test('email-bound invitation is one account, stores only a hash, and retries preserve the link', () => configured(async () => {
  const h = harness(), input = request();
  const invitation = await createBetaInvitation(admin(), input, h.deps);
  assert.equal((await createBetaInvitation(admin(), input, h.deps)).token, invitation.token);
  assert.equal(h.events.length, 1); assert.equal(JSON.stringify(h.events).includes(invitation.token), false);
  assert.deepEqual(await checkBetaInvitation(invitation.token, h.deps), { expiresAt: invitation.invitation.expiresAt });
  assert.equal(await registerInvitedMember(invitation.token, 'other@example.com', 'other-sub', h.deps), undefined);
  assert.equal(await resolveRegisteredMember(input.email, 'friend-sub', h.deps), undefined);
  const member = await registerInvitedMember(invitation.token, ' FRIEND@example.com ', 'friend-sub', h.deps);
  assert.equal(member?.profile.id, betaMemberId(input.email)); assert.equal('role' in member!.profile, false); assert.equal(member?.profile.accessLevel, 'learner');
  assert.equal((await registerInvitedMember(invitation.token, input.email, 'friend-sub', h.deps))?.profile.id, member?.profile.id);
  assert.equal(await resolveRegisteredMember(input.email, 'different-sub', h.deps), undefined);
  assert.equal(await resolveRegisteredMember(input.email, undefined, h.deps), undefined);
  await assert.rejects(checkBetaInvitation(invitation.token, h.deps), { code: 'INVITATION_UNAVAILABLE' });
  const publicState = betaAdministrationState(h.events, at);
  assert.equal(JSON.stringify(publicState).includes('tokenHash'), false); assert.equal(JSON.stringify(publicState).includes('googleSubject'), false);
  assert.equal(publicState.invitations[0].status, 'used');
  assert.equal(profilesWithBetaMembers(h.events).length, 3);
}));

test('invitation expiration, cancellation and member stopping are enforced on subsequent sessions', () => configured(async () => {
  const h = harness(), input = request(), invitation = await createBetaInvitation(admin(), input, h.deps);
  h.setTime(new Date(Date.parse(invitation.invitation.expiresAt)));
  assert.equal(await registerInvitedMember(invitation.token, input.email, 'friend-sub', h.deps), undefined);
  await assert.rejects(checkBetaInvitation(invitation.token, h.deps), { code: 'INVITATION_UNAVAILABLE' });
  h.setTime(at);
  await revokeBetaAccess(admin(), { kind: 'invitation', id: input.requestId }, h.deps);
  assert.equal(await registerInvitedMember(invitation.token, input.email, 'friend-sub', h.deps), undefined);
  const second = await createBetaInvitation(admin(), request(), h.deps);
  const member = await registerInvitedMember(second.token, input.email, 'friend-sub', h.deps);
  assert.ok(member);
  await revokeBetaAccess(admin(), { kind: 'member', id: member.profile.id }, h.deps);
  assert.equal(await resolveRegisteredMember(input.email, 'friend-sub', h.deps), undefined);
  assert.equal(await registerInvitedMember(second.token, input.email, 'friend-sub', h.deps), undefined);
  assert.equal(profilesWithBetaMembers(h.events).some(profile => profile.id === member.profile.id), false);
}));

test('concurrent acceptance cannot create two identities or overwrite the canonical Google subject', () => configured(async () => {
  const h = harness(), input = request(), invitation = await createBetaInvitation(admin(), input, h.deps);
  const results = await Promise.all([registerInvitedMember(invitation.token, input.email, 'first-sub', h.deps), registerInvitedMember(invitation.token, input.email, 'second-sub', h.deps)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(foldBetaMembership(h.events).members.size, 1);
  const registered = [...foldBetaMembership(h.events).members.values()][0];
  assert.equal((await resolveRegisteredMember(input.email, registered.googleSubject, h.deps))?.profile.id, betaMemberId(input.email));
}));

test('only the configured Super User issues invitations; malformed and forged events grant no access', () => configured(async () => {
  const h = harness(), learner = profileForAccount(getRegisteredAccounts()[1]);
  await assert.rejects(createBetaInvitation({ ...learner,  accessLevel: 'superuser' }, request(), h.deps), { code: 'FORBIDDEN' });
  await assert.rejects(createBetaInvitation(admin(), { ...request(), accessLevel: 'superuser' }, h.deps));
  const input = request(), invitation = await createBetaInvitation(admin(), input, h.deps);
  await assert.rejects(createBetaInvitation(admin(), { ...input, email: 'different@example.com' }, h.deps), { code: 'REQUEST_CONFLICT' });
  const forged = structuredClone(h.events); forged[0].actorId = learner.id;
  assert.equal(foldBetaMembership(forged).invitations.size, 0);
  const member = await registerInvitedMember(invitation.token, input.email, 'friend-sub', h.deps); assert.ok(member);
  const spoofed = structuredClone(h.events); spoofed[1].actorId = learner.id;
  assert.equal(foldBetaMembership(spoofed).members.size, 0);
  const crossWorkspace = structuredClone(h.events); crossWorkspace[0].workspaceId = 'another-workspace';
  assert.equal(foldBetaMembership(crossWorkspace).members.size, 0);
  assert.equal((await resolveRegisteredMember('existing@example.com', 'subject', h.deps))?.profile.id, 'existing-learner');
}));

test('Google callbacks require verified Google identity and an invitation, then resolve live membership', () => configured(async () => {
  const h = harness(), input = request(), invitation = await createBetaInvitation(admin(), input, h.deps);
  const resolveMember = (email: string, subject?: string) => resolveRegisteredMember(email, subject, h.deps);
  const registerMember = (token: string, email: string, subject: string) => registerInvitedMember(token, email, subject, h.deps);
  const callbacks = getAuthOptions({ inviteToken: invitation.token, resolveMember, registerMember }).callbacks!;
  const args = { user: { id: 'friend-sub' }, account: { provider: 'google', type: 'oauth' as const, providerAccountId: 'friend-sub' }, profile: { email: input.email, email_verified: true, sub: 'friend-sub' } };
  assert.equal(await callbacks.signIn!({ ...args, profile: { ...args.profile, email_verified: false } } as any), false);
  assert.equal(await callbacks.signIn!({ ...args, account: { ...args.account, provider: 'other' } } as any), false);
  const noInvite = getAuthOptions({ resolveMember, registerMember }).callbacks!;
  assert.equal(await noInvite.signIn!(args as any), false);
  assert.equal(await callbacks.signIn!(args as any), true);
  const token = await callbacks.jwt!({ ...args, token: {} } as any);
  assert.equal(token.googleSubject, 'friend-sub'); assert.equal(token.access_token, undefined);
  const session = { expires: at.toISOString(), user: { name: '', email: '' } };
  const accepted = await callbacks.session!({ session, token } as any);
  assert.equal((accepted as any).profile.id, betaMemberId(input.email));
  await revokeBetaAccess(admin(), { kind: 'member', id: betaMemberId(input.email) }, h.deps);
  const denied = await callbacks.session!({ session, token } as any);
  assert.equal((denied as any).profile, undefined); assert.equal(denied.user?.email, null);
  const failing = getAuthOptions({ resolveMember: async () => { throw new ApiError(503, 'unavailable'); } }).callbacks!;
  await assert.rejects(async () => failing.signIn!(args as any), { status: 503 });
}));

test('the fifty-person capacity includes active invitations and frees cancelled or expired reservations', () => configured(async () => {
  const h = await registeredFixture(49);
  const cancelled = await createBetaInvitation(admin(), request(), h.deps);
  await assert.rejects(createBetaInvitation(admin(), { ...request(), email: 'second@example.com' }, h.deps), { code: 'BETA_LIMIT' });
  await revokeBetaAccess(admin(), { kind: 'invitation', id: cancelled.invitation.id }, h.deps);
  const expired = await createBetaInvitation(admin(), { ...request(), expiresInDays: 1 }, h.deps);
  await assert.rejects(createBetaInvitation(admin(), { ...request(), email: 'third@example.com' }, h.deps), { code: 'BETA_LIMIT' });
  h.setTime(new Date(expired.invitation.expiresAt));
  const final = await createBetaInvitation(admin(), request(), h.deps);
  assert.ok(await registerInvitedMember(final.token, final.invitation.email, 'fiftieth-sub', h.deps));
  assert.equal(foldBetaMembership(h.events).members.size, 50);
  await assert.rejects(createBetaInvitation(admin(), { ...request(), email: 'overflow@example.com' }, h.deps), { code: 'BETA_LIMIT' });
  assert.ok(await resolveRegisteredMember(final.invitation.email, 'fiftieth-sub', h.deps));
}));

test('concurrent invitations cannot admit a fifty-first member and full registration performs no append', () => configured(async () => {
  const h = await registeredFixture(49);
  // Both issuances may observe the same free slot; canonical registration must still be bounded.
  const invitations = await Promise.all(['race-a@example.com', 'race-b@example.com'].map(email => createBetaInvitation(admin(), { ...request(), email }, h.deps)));
  const accepted = await Promise.all(invitations.map((invitation, index) => registerInvitedMember(invitation.token, invitation.invitation.email, `race-sub-${index}`, h.deps)));
  assert.equal(accepted.filter(Boolean).length, 1);
  assert.equal(foldBetaMembership(h.events).members.size, 50);
  assert.equal(profilesWithBetaMembers(h.events).length, seeds.length + 50);
  const rejectedIndex = accepted.findIndex(member => !member), rejected = invitations[rejectedIndex], count = h.events.length;
  assert.equal(await registerInvitedMember(rejected.token, rejected.invitation.email, `race-sub-${rejectedIndex}`, h.deps), undefined);
  assert.equal(h.events.length, count);
  assert.equal(await resolveRegisteredMember(rejected.invitation.email, `race-sub-${rejectedIndex}`, h.deps), undefined);
}));
