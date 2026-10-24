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
  assert.throws(() => validateGrant({ ...info, aud: 'other' }, identity, config, 'nonce'), /別のアプリへの接続情報/);
  assert.throws(() => validateGrant({ ...info, scopes: ['openid', 'email'] }, identity, config, 'nonce'), /権限（drive.file）が許可されていません/);
  assert.throws(() => validateGrant({ ...info, scopes: [...SCOPES, 'https://www.googleapis.com/auth/drive'] }, identity, config, 'nonce'), /不要な権限が含まれています/);
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
  assert.equal(HEADERS[3], 'workspaceId');
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

test('resuming an existing sheet accepts either fourth-column heading without modifying headers or saved IDs', async () => {
  for (const fourthColumn of ['workspaceId', 'familyId']) {
    for (const phase of ['sheet-created', 'complete']) {
      const input = { ...record(), phase, env: { ...record().env,
        GOOGLE_DRIVE_FOLDER_ID: 'folder-12345678', GOOGLE_SHEETS_ID: 'sheet-12345678' } };
      const savedEnvironment = structuredClone(input.env);
      const header = Object.freeze(HEADERS.map((name, index) => index === 3 ? fourthColumn : name));
      const calls = [], checkpoints = [];
      await provisionStorage(input, async (url, options) => {
        assert.equal(options, undefined, 'existing storage is only read, never repaired or recreated');
        calls.push(url);
        return url.includes('/values/') ? { values: [header] } : { parents: ['folder-12345678'] };
      }, async value => { checkpoints.push(value.phase); });
      assert.equal(calls.length, 2);
      assert.equal(calls[1], 'https://sheets.googleapis.com/v4/spreadsheets/sheet-12345678/values/Events!A1:M1');
      assert.deepEqual(checkpoints, ['complete']);
      assert.deepEqual(input.env, savedEnvironment);
      assert.equal(header[3], fourthColumn);
    }
  }
});

test('legacy-header compatibility rejects every other changed, reordered, missing or extra column without writes', async () => {
  const legacy = HEADERS.map((name, index) => index === 3 ? 'familyId' : name);
  const invalidHeaders = [
    undefined, null, {}, HEADERS.join(','), HEADERS.slice(0, -1), [...HEADERS, 'extra'],
    [...legacy.slice(0, 3), ...legacy.slice(4)],
    legacy.map((name, index) => index === 2 ? legacy[3] : index === 3 ? legacy[2] : name),
    ...HEADERS.map((_, changedIndex) => legacy.map((name, index) => index === changedIndex ? 'wrong' : name)),
  ];
  for (const header of invalidHeaders) {
    const input = { ...record(), phase: 'complete', env: { ...record().env,
      GOOGLE_DRIVE_FOLDER_ID: 'folder-12345678', GOOGLE_SHEETS_ID: 'sheet-12345678' } };
    const before = structuredClone(input);
    let checkpoints = 0;
    await assert.rejects(() => provisionStorage(input, async (url, options) => {
      assert.equal(options, undefined);
      return url.includes('/values/') ? { values: [header] } : { parents: ['folder-12345678'] };
    }, async () => { checkpoints++; }), /記録シートの見出しを確認/);
    assert.equal(checkpoints, 0);
    assert.deepEqual(input, before);
  }
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
    // Fetch's Origin-header algorithm turns a native form POST's Origin into
    // null under no-referrer. Keep a policy compatible with the strict check.
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.ok(!html.includes(config.clientSecret));
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const confirm = /name="confirm" value="([^"]+)"/.exec(html)[1];
    const post = async (origin, formToken) => fetch(`${ORIGIN}/start`, { method: 'POST', redirect: 'manual',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirm: formToken }) });
    assert.equal((await post('https://malicious.example', confirm)).status, 400);
    assert.equal((await post('null', confirm)).status, 400);
    assert.equal((await post(ORIGIN, 'wrong')).status, 400);
    const concurrentStarts = await Promise.all([post(ORIGIN, confirm), post(ORIGIN, confirm)]);
    assert.deepEqual(concurrentStarts.map((result) => result.status).sort(), [303, 400]);
    const start = concurrentStarts.find((result) => result.status === 303);
    assert.equal(start.status, 303);
    assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
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
    assert.equal(forged.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await post(ORIGIN, confirm)).status, 400);
  } finally {
    server.close(); server.closeAllConnections(); await once(server, 'close');
  }
});
