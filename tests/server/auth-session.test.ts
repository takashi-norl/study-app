import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerSession } from 'next-auth';
import { encode, decode } from 'next-auth/jwt';
import { getAuthOptions } from '../../src/server/auth';

test('active sessions renew a secure persistent thirty-day cookie and revoked members stay unauthorized', async () => {
  const keys = ['NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'REGISTERED_ACCOUNTS_JSON'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const operator = { id: 'operator', email: 'operator@example.com', name: '管理者', };
  const learner = { id: 'learner', email: 'learner@example.com', name: '学習者', };
  try {
    const secret = 'test-only-secret-at-least-thirty-two-characters-long';
    process.env.NEXTAUTH_SECRET = secret;
    process.env.NEXTAUTH_URL = 'https://study.example';
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator, learner]);
    const options = getAuthOptions();
    assert.equal(options.session?.maxAge, 30 * 24 * 60 * 60);
    const original = await encode({ secret, token: { email: learner.email, googleVerified: true }, maxAge: 60 });
    const req = { headers: {}, cookies: { '__Secure-next-auth.session-token': original } };
    let saved: string[] = [];
    const res = { getHeader: () => saved, setHeader: (_name: string, value: string[]) => { saved = value; } };
    const session = await getServerSession(req as any, res as any, options);
    assert.equal(session?.profile?.id, learner.id);
    const cookie = saved.find(value => value.startsWith('__Secure-next-auth.session-token='));
    assert.ok(cookie);
    assert.match(cookie, /; Expires=/); assert.match(cookie, /; HttpOnly/); assert.match(cookie, /; Secure/); assert.match(cookie, /; SameSite=Lax/);
    const renewed = await decode({ secret, token: decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('=')) });
    assert.ok(typeof renewed?.exp === 'number' && renewed.exp > Date.now() / 1000 + 29 * 24 * 60 * 60);
    assert.equal(renewed?.access_token, undefined); assert.equal(renewed?.refresh_token, undefined);
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator]);
    const revoked = await getServerSession(req as any, res as any, getAuthOptions());
    assert.equal(revoked?.profile, undefined);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
