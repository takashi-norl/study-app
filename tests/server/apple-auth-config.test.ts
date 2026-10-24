import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { getAppleAuthConfig } from '../../src/server/apple-auth-config';
import { getAuthConfig } from '../../src/server/env';
import { assertAppleEnvironment, TRUSTED_PROJECTS } from '../../src/server/environment';

const now = new Date('2026-10-24T00:00:00Z'), seconds = now.getTime() / 1000;
const clientId = 'com.example.study.staging', productionId = 'com.example.study.production';
const sessionSecret = 'synthetic-staging-session-secret-32-characters';
const header = { alg: 'ES256', kid: 'KEY1234567' };
const claims = { iss: 'TEAM123456', sub: clientId, aud: 'https://appleid.apple.com', iat: seconds - 10, exp: seconds + 86400 };
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
// Deliberately a synthetic signature. The helper checks configuration format; only Apple can accept the credential.
const jwt = (payload: unknown = claims, head: unknown = header, signature = Buffer.alloc(64, 1).toString('base64url')) => `${part(head)}.${part(payload)}.${signature}`;
function configured() {
  const bindings = {
    production: { projectId: TRUSTED_PROJECTS.production, workspaceId: 'production-workspace', googleClientId: 'production-google', driveFolderId: 'production-folder', sheetsId: 'production-sheets', origin: 'https://production.example', appleClientId: productionId },
    staging: { projectId: TRUSTED_PROJECTS.staging, workspaceId: 'staging-workspace', googleClientId: 'staging-google', driveFolderId: 'staging-folder', sheetsId: 'staging-sheets', origin: 'https://staging.example', appleClientId: clientId, authSecretSha256: createHash('sha256').update(sessionSecret).digest('hex') },
  };
  const env: Record<string, string | undefined> = {
    APP_ENV: 'staging', VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.staging,
    APP_ENV_BINDINGS_JSON: JSON.stringify(bindings), WORKSPACE_ID: 'staging-workspace',
    GOOGLE_CLIENT_ID: 'staging-google', GOOGLE_CLIENT_SECRET: 'synthetic-google-secret', GOOGLE_DRIVE_FOLDER_ID: 'staging-folder', GOOGLE_SHEETS_ID: 'staging-sheets',
    NEXTAUTH_URL: 'https://staging.example', NEXT_PUBLIC_APP_URL: 'https://staging.example', NEXTAUTH_SECRET: sessionSecret,
    APPLE_AUTH_ENABLED: 'true', APPLE_CLIENT_ID: clientId, APPLE_CLIENT_SECRET: jwt(),
    APPLE_PRIVATE_KEY: 'PRIVATE_KEY_MUST_NOT_BE_USED_OR_LOGGED',
  };
  return { env, bindings };
}
function withEnvironment(env: Record<string, string | undefined>, action: () => void) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('Apple is optional and an invalid or missing Apple setting never disables a valid Google configuration', () => {
  const { env } = configured();
  withEnvironment(env, () => {
    assert.deepEqual(getAppleAuthConfig(now), { clientId, clientSecret: jwt() });
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.APPLE_AUTH_ENABLED; else process.env.APPLE_AUTH_ENABLED = value;
      assert.equal(getAppleAuthConfig(now), undefined);
      assert.equal(getAuthConfig().clientId, 'staging-google');
    }
  });
  for (const change of [{ APPLE_CLIENT_ID: undefined }, { APPLE_CLIENT_SECRET: undefined }, { APPLE_CLIENT_SECRET: 'PRIVATE_KEY_PEM_IS_NOT_A_CLIENT_SECRET_JWT' }]) {
    withEnvironment({ ...env, ...change }, () => { assert.equal(getAppleAuthConfig(now), undefined); assert.equal(getAuthConfig().clientId, 'staging-google'); });
  }
});

test('client secret shape, intended Services ID, issuer, audience and bounded lifetime are checked before exposing Apple', () => {
  const { env } = configured();
  const invalid = [
    jwt({ ...claims, sub: productionId }), jwt({ ...claims, aud: 'https://attacker.example' }), jwt({ ...claims, iss: 'wrong' }),
    jwt({ ...claims, exp: seconds }), jwt({ ...claims, exp: claims.iat }), jwt({ ...claims, exp: claims.iat + 15_777_001 }),
    jwt({ ...claims, iat: seconds + 61 }), jwt({ ...claims, iat: '123' }), jwt({ ...claims, exp: 1.5 }),
    jwt(claims, { ...header, alg: 'none' }), jwt(claims, { ...header, kid: '' }), jwt(claims, { ...header, jku: 'https://attacker.example' }),
    jwt(claims, header, ''), jwt(claims, header, Buffer.alloc(63).toString('base64url')), `${jwt()}.extra`,
    `${part(header)}.not-json.${Buffer.alloc(64).toString('base64url')}`, `${jwt()}=`, 'x'.repeat(8193),
  ];
  for (const clientSecret of invalid) withEnvironment({ ...env, APPLE_CLIENT_SECRET: clientSecret }, () => {
    assert.equal(getAppleAuthConfig(now), undefined);
    assert.equal(getAuthConfig().clientId, 'staging-google');
  });
  withEnvironment({ ...env, APPLE_CLIENT_SECRET: jwt({ ...claims, exp: claims.iat + 15_777_000 }) }, () => {
    assert.ok(getAppleAuthConfig(now));
    assert.equal(getAppleAuthConfig(new Date((claims.iat + 15_777_000) * 1000)), undefined);
  });
});

test('Apple cannot reuse production Services ID in staging or enable through the legacy production fallback', () => {
  const { env, bindings } = configured();
  withEnvironment({ ...env, APPLE_CLIENT_ID: productionId, APPLE_CLIENT_SECRET: jwt({ ...claims, sub: productionId }) }, () => {
    assert.equal(getAppleAuthConfig(now), undefined);
    assert.throws(() => assertAppleEnvironment(productionId), { code: 'ENVIRONMENT_NOT_BOUND' });
  });
  for (const pin of [undefined, null, 123, '', clientId]) {
    const changed = { ...bindings, production: { ...bindings.production, appleClientId: pin } };
    withEnvironment({ ...env, APP_ENV_BINDINGS_JSON: JSON.stringify(changed) }, () => {
      assert.equal(getAppleAuthConfig(now), undefined);
      assert.equal(getAuthConfig().clientId, 'staging-google', 'bad optional Apple pins must not block Google');
    });
  }
  withEnvironment({ ...env, APP_ENV: undefined, APP_ENV_BINDINGS_JSON: undefined, VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production }, () => {
    assert.equal(getAppleAuthConfig(now), undefined);
    assert.equal(getAuthConfig().clientId, 'staging-google');
  });
});

test('Apple preflight is local, refuses insecure or unknown environments, and emits no keys or decoded values', () => {
  const { env } = configured();
  const output: unknown[] = [];
  const logs = ['log', 'error', 'warn'].map(method => mock.method(console, method as 'log', (...args: unknown[]) => { output.push(args); }));
  const network = mock.method(globalThis, 'fetch', async () => { throw new Error('Provider must never be called by configuration preflight'); });
  try {
    for (const change of [{ NEXTAUTH_URL: 'http://staging.example' }, { VERCEL_PROJECT_ID: 'untrusted' }, { APP_ENV: 'local' }, { APPLE_CLIENT_SECRET: 'SUPER_SECRET_INVALID_VALUE' }]) {
      withEnvironment({ ...env, ...change }, () => { assert.equal(getAppleAuthConfig(now), undefined); });
    }
    withEnvironment(env, () => { assert.ok(getAppleAuthConfig(now)); });
    assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(output, []);
  } finally { network.mock.restore(); for (const log of logs) log.mock.restore(); }
});
