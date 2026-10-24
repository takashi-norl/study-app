import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Session } from 'next-auth';
import { getAuthOptions } from '../../src/server/auth';
import { verifiedLoginIdentity, appleOAuthCookies } from '../../src/server/auth-identity';
import { TRUSTED_PROJECTS } from '../../src/server/environment';
import { getRegisteredAccounts, profileForAccount } from '../../src/server/env';
import { betaAdministrationState, createBetaInvitation, registerInvitedMember, resolveRegisteredMember, revokeBetaAccess } from '../../src/server/beta-membership';
import { betaMemberRegisteredSchema, foldBetaMembership } from '../../src/server/beta-membership-schema';
import type { StudyEvent } from '../../src/server/google-store';

const clientId = 'com.example.study.staging';
const account = { provider: 'apple', type: 'oauth' as const, providerAccountId: 'apple-subject' };
const claims = { iss: 'https://appleid.apple.com', aud: clientId, sub: 'apple-subject', email: 'friend@example.com', email_verified: 'true' };
const identity = (patch = {}) => ({ ...claims, ...patch });

async function configured(action: () => Promise<void>) {
  const secret = 'synthetic-only-staging-secret-at-least-32-characters';
  const binding = { production: { projectId: TRUSTED_PROJECTS.production, workspaceId: 'prod', googleClientId: 'prod-google', driveFolderId: 'prod-folder', sheetsId: 'prod-sheets', origin: 'https://production.example', appleClientId: 'com.example.study.production' },
    staging: { projectId: TRUSTED_PROJECTS.staging, workspaceId: 'stage', googleClientId: 'stage-google', driveFolderId: 'stage-folder', sheetsId: 'stage-sheets', origin: 'https://staging.example', appleClientId: clientId, authSecretSha256: createHash('sha256').update(secret).digest('hex') } };
  const now = Math.floor(Date.now() / 1000), part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const env = { APP_ENV: 'staging', VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.staging,
    APP_ENV_BINDINGS_JSON: JSON.stringify(binding), WORKSPACE_ID: 'stage', GOOGLE_CLIENT_ID: 'stage-google', GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
    GOOGLE_DRIVE_FOLDER_ID: 'stage-folder', GOOGLE_SHEETS_ID: 'stage-sheets', NEXTAUTH_URL: 'https://staging.example', NEXT_PUBLIC_APP_URL: 'https://staging.example', NEXTAUTH_SECRET: secret,
    REGISTERED_ACCOUNTS_JSON: JSON.stringify([{ id: 'operator', email: 'takashi.oikawa@gmail.com', name: '運営' }]),
    APPLE_AUTH_ENABLED: 'true', APPLE_CLIENT_ID: clientId,
    APPLE_CLIENT_SECRET: `${part({ alg: 'ES256', kid: 'KEY1234567' })}.${part({ iss: 'TEAM123456', sub: clientId, aud: 'https://appleid.apple.com', iat: now - 5, exp: now + 3600 })}.${Buffer.alloc(64, 1).toString('base64url')}` };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function harness() {
  const events: StudyEvent[] = [];
  const deps = { load: async () => structuredClone(events), append: async (event: StudyEvent) => { events.push(structuredClone(event)); }, now: () => new Date() };
  const resolveMember: typeof resolveRegisteredMember = (email, subject, _store, provider) => resolveRegisteredMember(email, subject, deps, provider);
  const registerMember: typeof registerInvitedMember = (token, email, subject, _store, provider) => registerInvitedMember(token, email, subject, deps, provider);
  const invite = (email = claims.email) => createBetaInvitation(profileForAccount(getRegisteredAccounts()[0]), { requestId: randomUUID(), email, name: '招待時の名前' }, deps);
  return { events, deps, resolveMember, registerMember, invite };
}

test('Apple trusts only verified ID-token email and exact issuer, audience and subject, never a returned user object', () => {
  for (const email_verified of [true, 'true']) assert.deepEqual(verifiedLoginIdentity(account, identity({ email_verified }), clientId), { provider: 'apple', subject: 'apple-subject', email: claims.email });
  for (const patch of [{ email_verified: false }, { email_verified: 'false' }, { email_verified: 1 }, { email_verified: 'TRUE' }, { email_verified: undefined },
    { iss: 'https://attacker.example' }, { aud: 'com.example.study.production' }, { aud: [clientId, 'other'] }, { sub: 'different' }, { sub: '' },
    { email: undefined, user: { email: claims.email, name: '運営' } }, { email: 'invalid' }]) {
    assert.equal(verifiedLoginIdentity(account, identity(patch), clientId), undefined);
  }
  assert.equal(verifiedLoginIdentity(account, claims), undefined);
  assert.equal(verifiedLoginIdentity({ ...account, provider: 'other' }, claims, clientId), undefined);
});

test('only configured Apple is advertised; cross-site proof cookies are confined to Apple and the session cookie stays default', () => configured(async () => {
  const apple = getAuthOptions({ provider: 'apple' });
  assert.deepEqual(apple.providers.map(provider => provider.id), ['google', 'apple']);
  const provider = apple.providers[1] as typeof apple.providers[1] & { options: { checks: string[]; authorization: { params: Record<string, string> } } };
  assert.deepEqual(provider.options.checks, ['state', 'pkce', 'nonce']);
  assert.equal(provider.options.authorization.params.response_mode, 'form_post');
  assert.deepEqual(apple.cookies, appleOAuthCookies());
  assert.equal('sessionToken' in apple.cookies!, false);
  assert.equal('csrfToken' in apple.cookies!, false);
  for (const cookie of Object.values(apple.cookies!)) { assert.equal(cookie.options.sameSite, 'none'); assert.equal(cookie.options.secure, true); assert.equal(cookie.options.httpOnly, true); assert.equal(cookie.options.maxAge, 900); }
  assert.equal(getAuthOptions({ provider: 'google' }).cookies, undefined);
  delete process.env.APPLE_AUTH_ENABLED;
  assert.deepEqual(getAuthOptions().providers.map(provider => provider.id), ['google']);
}));

test('Apple callbacks consume only an exact-email invitation, preserve canonical name and account ID, and honor live revocation', () => configured(async () => {
  const h = harness(), invitation = await h.invite();
  const args = { user: { id: account.providerAccountId, name: '未署名の別名' }, account, profile: claims };
  const noInvite = getAuthOptions(h).callbacks!;
  assert.equal(await noInvite.signIn!(args as any), '/join?error=AppleAccessDenied');
  const callbacks = getAuthOptions({ ...h, inviteToken: invitation.token }).callbacks!;
  assert.equal(await callbacks.signIn!({ ...args, profile: identity({ email_verified: 'false' }) } as any), false);
  assert.equal(await callbacks.signIn!(args as any), true);
  const count = h.events.length;
  assert.equal(await callbacks.signIn!(args as any), true);
  assert.equal(h.events.length, count);
  const token = await callbacks.jwt!({ ...args, token: { googleVerified: true, googleSubject: 'old-google-subject' } } as any);
  assert.equal(token.authProvider, 'apple'); assert.equal(token.authSubject, 'apple-subject'); assert.equal(token.authVerified, true);
  assert.equal(token.googleVerified, undefined); assert.equal(token.googleSubject, undefined); assert.equal(token.access_token, undefined);
  const session = await callbacks.session!({ session: { expires: '', user: {} }, token } as any) as Session;
  assert.equal(session.user?.name, '招待時の名前'); assert.equal(session.profile?.accessLevel, 'learner'); assert.ok(session.profile?.id);
  const changedEmail = await h.resolveMember('takashi.oikawa@gmail.com', 'apple-subject', {}, 'apple');
  assert.equal(changedEmail?.profile.id, session.profile.id); assert.equal(changedEmail?.profile.accessLevel, 'learner');
  assert.equal(changedEmail?.email, claims.email);
  await revokeBetaAccess(profileForAccount(getRegisteredAccounts()[0]), { kind: 'member', id: session.profile.id }, h.deps);
  const revoked = await callbacks.session!({ session, token } as any) as Session;
  assert.equal(revoked.profile, undefined); assert.equal(revoked.user?.email, null);
}));

test('Apple relay is invited as its own verified address and never guessed from a real email, name or Google account', () => configured(async () => {
  const h = harness(), realInvitation = await h.invite(), relay = 'hidden@privaterelay.appleid.com';
  assert.equal(await h.registerMember(realInvitation.token, relay, 'relay-subject', {}, 'apple'), undefined);
  const relayInvitation = await h.invite(relay);
  const member = await h.registerMember(relayInvitation.token, relay, 'relay-subject', {}, 'apple');
  assert.equal(member?.profile.accessLevel, 'learner');
  assert.equal(await h.resolveMember(relay, 'relay-subject', {}, 'google'), undefined);
  assert.equal(await h.resolveMember('takashi.oikawa@gmail.com', 'unbound-apple-subject', {}, 'apple'), undefined);
  const google = await h.registerMember(realInvitation.token, claims.email, 'google-subject');
  assert.ok(google);
  assert.equal(await h.resolveMember(claims.email, 'new-apple-subject', {}, 'apple'), undefined);
  assert.equal(await h.registerMember(realInvitation.token, claims.email, 'new-apple-subject', {}, 'apple'), undefined);
  assert.notEqual(google.profile.id, member?.profile.id);
  const publicState = JSON.stringify(betaAdministrationState(h.events));
  assert.equal(/googleSubject|authSubject|authProvider|tokenHash/.test(publicState), false);
}));

test('provider subject pairs cannot overwrite accounts; a subject reused by a different provider is a separate identity', () => configured(async () => {
  const h = harness(), first = await h.invite('first@example.com'), second = await h.invite('second@example.com'), third = await h.invite('third@example.com');
  const google = await h.registerMember(first.token, first.invitation.email, 'same-subject', {}, 'google');
  const apple = await h.registerMember(second.token, second.invitation.email, 'same-subject', {}, 'apple');
  assert.ok(google); assert.ok(apple); assert.notEqual(google.profile.id, apple.profile.id);
  // Already-bound Apple subject returns its original account, never claims a fresh invitation.
  assert.equal((await h.registerMember(third.token, third.invitation.email, 'same-subject', {}, 'apple'))?.profile.id, apple.profile.id);
  assert.equal(foldBetaMembership(h.events).members.size, 2);
  const raw = h.events.find(event => event.type === 'beta.member.registered')!.payload as Record<string, unknown>;
  assert.equal(betaMemberRegisteredSchema.safeParse({ ...raw, authProvider: 'apple', authSubject: 'other-subject' }).success, false);
  assert.equal(betaMemberRegisteredSchema.safeParse({ ...raw, googleSubject: undefined }).success, false);
}));

test('concurrent Apple and Google redemption of one invitation preserves exactly one account and one provider', () => configured(async () => {
  const h = harness(), invitation = await h.invite();
  const results = await Promise.all([
    h.registerMember(invitation.token, claims.email, 'apple-racing-subject', {}, 'apple'),
    h.registerMember(invitation.token, claims.email, 'google-racing-subject', {}, 'google'),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(foldBetaMembership(h.events).members.size, 1);
  const recovered = await Promise.all([
    h.resolveMember(claims.email, 'apple-racing-subject', {}, 'apple'),
    h.resolveMember(claims.email, 'google-racing-subject', {}, 'google'),
  ]);
  assert.equal(recovered.filter(Boolean).length, 1);
  assert.equal(recovered.find(Boolean)?.profile.id, results.find(Boolean)?.profile.id);
}));

test('disabling Apple removes new sign-in without breaking a current session, while membership revocation still removes access', () => configured(async () => {
  const h = harness(), invitation = await h.invite();
  const args = { user: { id: account.providerAccountId }, account, profile: claims };
  const callbacks = getAuthOptions({ ...h, inviteToken: invitation.token }).callbacks!;
  assert.equal(await callbacks.signIn!(args as any), true);
  const token = await callbacks.jwt!({ ...args, token: {} } as any);
  const initial = await callbacks.session!({ session: { expires: '', user: {} }, token } as any) as Session;
  process.env.APPLE_AUTH_ENABLED = 'false';
  process.env.APPLE_CLIENT_SECRET = 'expired-or-removed-secret';
  const options = getAuthOptions(h);
  assert.deepEqual(options.providers.map(provider => provider.id), ['google']);
  assert.equal(await options.callbacks!.signIn!(args as any), false);
  const renewed = await options.callbacks!.session!({ session: { expires: '', user: {} }, token } as any) as Session;
  assert.equal(renewed.profile?.id, initial.profile?.id);
  await revokeBetaAccess(profileForAccount(getRegisteredAccounts()[0]), { kind: 'member', id: initial.profile!.id }, h.deps);
  assert.equal(((await options.callbacks!.session!({ session: renewed, token } as any)) as Session).profile, undefined);
}));
