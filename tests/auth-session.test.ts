import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginSessionReader } from '../src/lib/auth-session';

const profile = { id: 'learner', workspaceId: 'workspace-primary', name: '学習者', accessLevel: 'learner' as const };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('session checks use the cookie-renewing official route and deduplicate only overlapping calls', async () => {
  let calls = 0;
  let release!: (value: Response) => void;
  const reader = createLoginSessionReader(async (url, options) => {
    calls += 1;
    assert.equal(url, '/api/auth/session');
    assert.equal(options?.credentials, 'same-origin'); assert.equal(options?.cache, 'no-store');
    assert.equal(options?.signal?.aborted, false);
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return json({});
  });
  const first = reader();
  const second = reader();
  assert.equal(first, second); assert.equal(calls, 1);
  release(json({ profile, expires: '2026-11-23T00:00:00.000Z' }));
  assert.deepEqual(await first, { status: 'authenticated', profile });
  assert.deepEqual(await reader(), { status: 'unauthenticated' });
  assert.equal(calls, 2, 'a later check must detect logout or removed membership');
});

test('only a missing or rejected session means login is required', async () => {
  for (const response of [json({}), json(null), json({ user: { name: null }, expires: '2026-11-23T00:00:00.000Z' }), json({}, 401)]) {
    assert.deepEqual(await createLoginSessionReader(async () => response)(), { status: 'unauthenticated' });
  }
});

test('network, server, malformed responses and timeout do not pretend the user logged out', async () => {
  for (const response of [json({ error: 'temporary' }, 503), json({ error: 'temporary' }), new Response('<html>error</html>'),
    json({ profile: { ...profile, accessLevel: 'invalid' } }), json({ unexpected: true })]) {
    assert.equal((await createLoginSessionReader(async () => response)()).status, 'unavailable');
  }
  assert.equal((await createLoginSessionReader(async () => { throw new TypeError('network'); })()).status, 'unavailable');
  let aborted = false;
  const reader = createLoginSessionReader(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('abort')); }, { once: true });
  }), 1);
  assert.equal((await reader()).status, 'unavailable'); assert.equal(aborted, true);
});

test('session response exposes only the application profile', async () => {
  const reader = createLoginSessionReader(async () => json({ profile: { ...profile, role: 'obsolete-value', secret: 'not-a-profile-field' }, user: { email: 'private@example.com' } }));
  assert.deepEqual(await reader(), { status: 'authenticated', profile });
});

test('operational capability does not require a different learner identity or an extra profile field', async () => {
  const operator = { ...profile, accessLevel: 'superuser' as const };
  assert.deepEqual(await createLoginSessionReader(async () => json({ profile: operator }))(), { status: 'authenticated', profile: operator });
  const ordinary = { id: profile.id, workspaceId: profile.workspaceId, name: profile.name };
  assert.deepEqual(await createLoginSessionReader(async () => json({ profile: ordinary }))(), { status: 'authenticated', profile: ordinary });
});

test('logout waits for an outstanding cookie renewal and blocks new focus renewals until recovery', async () => {
  const order: string[] = [];
  let release!: (response: Response) => void;
  let calls = 0;
  const reader = createLoginSessionReader(async () => {
    calls += 1;
    if(calls > 1)return json({});
    const response = await new Promise<Response>(resolve => { release = resolve; });
    order.push('renewed-cookie');
    return response;
  });
  const pending = reader();
  const logout = reader.pause().then(() => { order.push('delete-cookie'); });
  assert.equal((await reader()).status, 'unavailable');
  assert.equal(calls, 1); assert.deepEqual(order, []);
  release(json({ profile }));
  await pending; await logout;
  assert.deepEqual(order, ['renewed-cookie', 'delete-cookie']);
  assert.equal((await reader()).status, 'unavailable'); assert.equal(calls, 1);
  reader.resume();
  assert.deepEqual(await reader(), { status: 'unauthenticated' }); assert.equal(calls, 2);
});
