import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { findAudioCache } from '../../src/server/google-store';

test('cache lookup is restricted to app-owned private audio in the configured folder and validates returned metadata', async () => {
  const values = {
    NEXTAUTH_SECRET: 'test-only-secret-with-at-least-32-characters', GOOGLE_CLIENT_ID: 'audio-find-client', GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN: 'audio-find-test-token', GOOGLE_DRIVE_FOLDER_ID: 'test-folder-12345678', GOOGLE_SHEETS_ID: 'test-sheet-12345678', GOOGLE_DRIVE_OWNER_EMAIL: 'owner@example.com',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const access = mock.method(OAuth2Client.prototype, 'getAccessToken', async () => ({ token: 'test-only-access-token' }));
  const info = mock.method(OAuth2Client.prototype, 'getTokenInfo', async () => ({ aud: values.GOOGLE_CLIENT_ID, scopes: ['https://www.googleapis.com/auth/drive.file'], email: values.GOOGLE_DRIVE_OWNER_EMAIL, email_verified: true, expiry_date: Date.now() + 60000 }));
  const key = 'a'.repeat(64);
  const good = { id: 'test-audio-12345678', mimeType: 'audio/mpeg', size: '10', parents: [values.GOOGLE_DRIVE_FOLDER_ID], appProperties: { purpose: 'hibi-study-audio', cacheKey: key }, trashed: false };
  let files = [{ ...good, parents: ['unrelated-folder'] }, { ...good, trashed: true }, { ...good, appProperties: { ...good.appProperties, cacheKey: 'b'.repeat(64) } }, good];
  let calls = 0;
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/drive/v3/files');
    const query = url.searchParams.get('q')!;
    assert.ok(query.includes(`'${values.GOOGLE_DRIVE_FOLDER_ID}' in parents`));
    assert.ok(query.includes("key='purpose' and value='hibi-study-audio'"));
    assert.ok(query.includes(`key='cacheKey' and value='${key}'`));
    assert.ok(query.includes('trashed = false'));
    assert.equal(init?.method, undefined);
    return Response.json({ files });
  });
  try {
    assert.equal(await findAudioCache(key), good.id);
    files = []; assert.equal(await findAudioCache(key), null);
    await assert.rejects(() => findAudioCache("' or true"), { status: 400 });
    assert.equal(calls, 2);
  } finally {
    network.mock.restore(); info.mock.restore(); access.mock.restore();
    for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
