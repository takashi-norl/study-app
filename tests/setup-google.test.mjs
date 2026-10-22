import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { HEADERS, ORIGIN, SCOPES, REDIRECT_URI, validateConfig, validateGrant, validateCallback,
  readPrivateJson, savePrivateJson, validateSaved, provisionStorage, startSetup } from '../scripts/setup-google.mjs';

const config = { clientId: '123-example.apps.googleusercontent.com', clientSecret: 'not-a-real-secret', ownerEmail: 'owner@example.com' };
function record() {
  return { version: 1, phase: 'authorized', env: { GOOGLE_CLIENT_ID: config.clientId, GOOGLE_CLIENT_SECRET: config.clientSecret,
    GOOGLE_DRIVE_OWNER_EMAIL: config.ownerEmail, GOOGLE_DRIVE_REFRESH_TOKEN: 'not-a-real-refresh-token', GOOGLE_SHEETS_EVENTS_TAB: 'Events' } };
}

test('only the intended Google client, verified owner and narrow grant are accepted', () => {
  const info = { aud: config.clientId, scopes: SCOPES };
  const identity = { aud: config.clientId, email: config.ownerEmail, email_verified: true, nonce: 'nonce' };
  assert.doesNotThrow(() => validateGrant(info, identity, config, 'nonce'));
  for (const invalid of [
    { ...info, aud: 'other' }, { ...info, scopes: ['openid', 'email'] },
    { ...info, scopes: [...SCOPES, 'https://www.googleapis.com/auth/drive'] },
    { ...info, scopes: [...SCOPES, 'https://www.googleapis.com/auth/spreadsheets'] },
  ]) assert.throws(() => validateGrant(invalid, identity, config, 'nonce'));
  for (const invalid of [
    { ...identity, aud: 'other' }, { ...identity, email: 'someone@example.com' },
    { ...identity, email_verified: false }, { ...identity, nonce: 'other' },
  ]) assert.throws(() => validateGrant(info, invalid, config, 'nonce'));
  assert.equal(validateConfig(record().env).ownerEmail, config.ownerEmail);
  assert.throws(() => validateConfig({ ...record().env, GOOGLE_CLIENT_ID: 'https://example.com' }));
});

test('OAuth callback rejects forged, duplicated, expired and cross-browser responses', () => {
  const url = new URL(`${REDIRECT_URI}?code=valid-code&state=expected`);
  assert.equal(validateCallback(url, 'expected', 'cookie', 'cookie', 2000, 1000), 'valid-code');
  assert.throws(() => validateCallback(url, 'other', 'cookie', 'cookie', 2000, 1000));
  assert.throws(() => validateCallback(url, 'expected', 'other', 'cookie', 2000, 1000));
  assert.throws(() => validateCallback(url, 'expected', 'cookie', 'cookie', 2000, 2000));
  for (const value of [
    `${REDIRECT_URI}?code=valid-code&state=expected&state=expected`,
    `${REDIRECT_URI}?code=valid-code&code=second&state=expected`,
    `${REDIRECT_URI}?error=access_denied&state=expected`,
    `${REDIRECT_URI}?state=expected`,
    'https://example.com/oauth/callback?code=valid-code&state=expected',
  ]) assert.throws(() => validateCallback(new URL(value), 'expected', 'cookie', 'cookie', 2000, 1000));
});

test('saved credentials remain private and refuse symlinks, public files and replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-setup-test-'));
  try {
    const path = join(directory, 'credentials.json');
    await savePrivateJson(path, record(), { create: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(path), record());
    await assert.rejects(() => savePrivateJson(path, {}, { create: true }));
    const updated = { ...record(), phase: 'folder-created', env: { ...record().env, GOOGLE_DRIVE_FOLDER_ID: 'folder-12345678' } };
    await savePrivateJson(path, updated);
    assert.deepEqual(await readPrivateJson(path), updated);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const link = join(directory, 'symlink.json');
    await symlink(path, link);
    await assert.rejects(() => readPrivateJson(link));
    await assert.rejects(() => savePrivateJson(link, {}));
    await chmod(path, 0o644);
    await assert.rejects(() => readPrivateJson(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('new folder and sheet are initialized with the correct event headers and checkpointed', async () => {
  const input = record();
  const phases = [];
  const writes = [];
  const request = async (url, options = {}) => {
    if (options.method) writes.push({ url, ...options });
    if (url.includes('/drive/v3/files?')) return { id: 'folder-12345678' };
    if (url.includes('/v4/spreadsheets?')) return { spreadsheetId: 'sheet-12345678' };
    if (url.includes('/values/')) return { values: [HEADERS] };
    if (options.method === 'PATCH') return { id: 'sheet-12345678', parents: ['folder-12345678'] };
    return { parents: ['root-12345678'] };
  };
  await provisionStorage(input, request, async (value) => { phases.push(value.phase); });
  assert.deepEqual(phases, ['creating-folder', 'folder-created', 'creating-sheet', 'sheet-created', 'complete']);
  assert.equal(input.phase, 'complete');
  assert.equal(writes.length, 3);
  assert.equal(JSON.parse(writes[0].body).mimeType, 'application/vnd.google-apps.folder');
  const sheet = JSON.parse(writes[1].body);
  assert.equal(sheet.sheets[0].properties.title, 'Events');
  assert.deepEqual(sheet.sheets[0].data[0].rowData[0].values.map((cell) => cell.userEnteredValue.stringValue), HEADERS);
  assert.match(writes[2].url, /addParents=folder-12345678/);
  assert.match(writes[2].url, /removeParents=root-12345678/);
  assert.equal(validateSaved(input).ownerEmail, config.ownerEmail);
});

test('ambiguous creates cannot be retried blindly; completed setup does not create duplicates', async () => {
  const input = record();
  const checkpoints = [];
  await assert.rejects(() => provisionStorage(input, async () => { throw new Error('network lost'); },
    async (value) => { checkpoints.push(structuredClone(value)); }));
  assert.equal(checkpoints[0].phase, 'creating-folder');
  let calls = 0;
  await assert.rejects(() => provisionStorage(checkpoints[0], async () => { calls++; }, async () => {}));
  assert.equal(calls, 0);
  const complete = { ...record(), phase: 'complete', env: { ...record().env,
    GOOGLE_DRIVE_FOLDER_ID: 'folder-12345678', GOOGLE_SHEETS_ID: 'sheet-12345678' } };
  await provisionStorage(complete, async (url, options) => {
    assert.equal(options, undefined);
    return url.includes('/values/') ? { values: [HEADERS] } : { parents: ['folder-12345678'] };
  }, async () => {});
  assert.throws(() => validateSaved({ ...record(), phase: 'complete' }));
});

test('localhost start page rejects hostile host/origin and requires a browser-bound POST before OAuth', async () => {
  const server = await startSetup(config, { log: () => {} });
  const local = 'http://127.0.0.1:8765';
  try {
    const badHost = await fetch(local);
    assert.equal(badHost.status, 403);
    const page = await fetch(ORIGIN);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok(!html.includes(config.clientSecret));
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const confirm = /name="confirm" value="([^"]+)"/.exec(html)[1];
    const post = async (origin, formToken) => fetch(`${ORIGIN}/start`, { method: 'POST', redirect: 'manual',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirm: formToken }) });
    assert.equal((await post('https://malicious.example', confirm)).status, 400);
    assert.equal((await post(ORIGIN, 'wrong')).status, 400);
    const concurrentStarts = await Promise.all([post(ORIGIN, confirm), post(ORIGIN, confirm)]);
    assert.deepEqual(concurrentStarts.map((result) => result.status).sort(), [303, 400]);
    const start = concurrentStarts.find((result) => result.status === 303);
    assert.equal(start.status, 303);
    const destination = new URL(start.headers.get('location'));
    assert.equal(destination.origin, 'https://accounts.google.com');
    assert.equal(destination.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(destination.searchParams.get('login_hint'), config.ownerEmail);
    assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(destination.searchParams.get('access_type'), 'offline');
    assert.ok(destination.searchParams.get('nonce'));
    assert.ok(destination.searchParams.get('state'));
    assert.ok(destination.searchParams.get('code_challenge'));
    const forged = await fetch(`${ORIGIN}/oauth/callback?code=untrusted&state=wrong`, {
      headers: { Cookie: cookie } });
    assert.equal(forged.status, 400);
    assert.equal((await post(ORIGIN, confirm)).status, 400);
  } finally {
    server.close(); server.closeAllConnections(); await once(server, 'close');
  }
});
