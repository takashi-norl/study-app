#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

export const ORIGIN = 'http://localhost:8765';
export const REDIRECT_URI = `${ORIGIN}/oauth/callback`;
export const SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.file'];
export const HEADERS = ['id', 'type', 'actorId', 'familyId', 'createdAt',
  'payload1', 'payload2', 'payload3', 'payload4', 'payload5', 'payload6', 'payload7', 'payload8'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, '.env.google-setup.json');
const FOLDER_NAME = 'ひび学習アプリ';
const SHEET_NAME = 'ひび学習アプリ・学習記録';
const ALLOWED_SCOPES = new Set([...SCOPES, 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.profile']);

class SetupError extends Error {}
function fail(message) { throw new SetupError(message); }
function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function validateConfig(input) {
  const clientId = input.GOOGLE_CLIENT_ID;
  const clientSecret = input.GOOGLE_CLIENT_SECRET;
  const ownerEmail = input.GOOGLE_DRIVE_OWNER_EMAIL?.trim().toLowerCase();
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)
    || typeof clientSecret !== 'string' || clientSecret.length < 12 || /[\r\n\0]/.test(clientSecret)
    || typeof ownerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    fail('Google client ID、client secret、保存先所有者のメールを秘密設定ファイルで指定してください。');
  }
  return { clientId, clientSecret, ownerEmail };
}

export function validateGrant(info, identity, config, expectedNonce) {
  const scopes = Array.isArray(info.scopes) ? info.scopes : [];
  if (info.aud !== config.clientId) {
    fail('別のアプリへの接続情報です。Googleクライアントの設定を確認し、このセットアップの開始画面から接続し直してください。');
  }
  if (!scopes.includes(SCOPES[2])) {
    fail('教材を保存する権限（drive.file）が許可されていません。接続し直し、Googleの許可画面で「このアプリで使用するファイル」の権限にチェックを入れて続行してください。');
  }
  if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    fail('このアプリに不要な権限が含まれています。Googleアカウントでこのアプリへの既存の接続を確認し、drive.fileと本人確認の権限だけで接続し直してください。');
  }
  if (identity?.aud !== config.clientId || identity?.email_verified !== true
    || identity?.email?.toLowerCase() !== config.ownerEmail
    || (expectedNonce !== undefined && !equal(identity.nonce, expectedNonce))) {
    fail('指定した保存先所有者の、本人確認済みGoogleアカウントで接続してください。');
  }
}

export function validateCallback(url, state, cookie, expectedCookie, expiresAt, now = Date.now()) {
  if (url.origin !== ORIGIN || url.pathname !== '/oauth/callback' || now >= expiresAt
    || !equal(cookie, expectedCookie) || url.searchParams.getAll('state').length !== 1
    || !equal(url.searchParams.get('state'), state)) fail('接続確認が一致しないか、期限が切れています。最初からやり直してください。');
  if (url.searchParams.has('error')) fail('Google接続がキャンセルされました。');
  const code = url.searchParams.get('code');
  if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096) fail('Googleからの接続確認を読み取れませんでした。');
  return code;
}

export async function readPrivateJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64_000
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      fail('秘密設定ファイルは自分が所有する通常ファイルにし、chmod 600 で保護してください。');
    }
    try { return JSON.parse(await handle.readFile('utf8')); }
    catch { fail('秘密設定ファイルをJSON形式で確認してください。'); }
  } finally { await handle.close(); }
}

/** Never follow symlinks, print credentials, or expose a partially written credential file. */
export async function savePrivateJson(path, value, { create = false } = {}) {
  if (create) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    return;
  }
  await readPrivateJson(path);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await savePrivateJson(temporary, value, { create: true });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function googleId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) fail('Googleから保存先IDを取得できませんでした。');
  return value;
}

export function validateSaved(input) {
  if (input?.version !== 1 || !['authorized', 'creating-folder', 'folder-created', 'creating-sheet',
    'sheet-created', 'complete'].includes(input.phase)) fail('保存済みセットアップ情報の形式を確認してください。');
  const config = validateConfig(input.env ?? {});
  if (typeof input.env.GOOGLE_DRIVE_REFRESH_TOKEN !== 'string' || input.env.GOOGLE_DRIVE_REFRESH_TOKEN.length < 20) {
    fail('保存済みGoogle接続の情報が不足しています。');
  }
  if (input.env.GOOGLE_DRIVE_FOLDER_ID) googleId(input.env.GOOGLE_DRIVE_FOLDER_ID);
  if (input.env.GOOGLE_SHEETS_ID) googleId(input.env.GOOGLE_SHEETS_ID);
  if (['folder-created', 'creating-sheet', 'sheet-created', 'complete'].includes(input.phase) && !input.env.GOOGLE_DRIVE_FOLDER_ID
    || ['sheet-created', 'complete'].includes(input.phase) && !input.env.GOOGLE_SHEETS_ID) {
    fail('保存済みセットアップ情報に保存先がありません。');
  }
  return config;
}

/** Endpoints are fixed by this helper. No request accepts a caller-supplied URL or token. */
async function googleJson(client, url, options = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !['www.googleapis.com', 'sheets.googleapis.com', 'openidconnect.googleapis.com'].includes(endpoint.hostname)) {
    fail('Google接続先が不正です。');
  }
  try {
    const { token } = await client.getAccessToken();
    if (!token) fail('Google接続を更新できませんでした。');
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    if (!response.ok) { await response.body?.cancel(); fail(`Googleへの設定が完了しませんでした（HTTP ${response.status}）。保存済み情報を残しています。`); }
    return await response.json();
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail('Googleとの通信を完了できませんでした。保存先を確認してから再開してください。');
  }
}

function oauthClient(config) {
  return new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: REDIRECT_URI,
    transporterOptions: { timeout: 20_000, retryConfig: { retry: 0 } } });
}

async function checkOwner(client, config) {
  const { token } = await client.getAccessToken();
  if (!token) fail('Google接続を更新できませんでした。');
  const info = await client.getTokenInfo(token);
  const identity = await googleJson(client, 'https://openidconnect.googleapis.com/v1/userinfo');
  validateGrant(info, { ...identity, aud: info.aud }, config);
}

/** Checkpoint before each create. An unknown create outcome requires human inspection, never a blind retry. */
export async function provisionStorage(record, request, save) {
  if (record.phase === 'creating-folder' || record.phase === 'creating-sheet') {
    fail('前回の作成結果が不明です。Google Driveで作成済みフォルダ・シートを確認してください。自動で重複作成はしません。');
  }
  if (!record.env.GOOGLE_DRIVE_FOLDER_ID) {
    record.phase = 'creating-folder'; await save(record);
    const folder = await request('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST',
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder',
        description: '家族用学習アプリの教材保存先。アプリ専用。' }) });
    record.env.GOOGLE_DRIVE_FOLDER_ID = googleId(folder.id);
    record.phase = 'folder-created'; await save(record);
  }
  if (!record.env.GOOGLE_SHEETS_ID) {
    record.phase = 'creating-sheet'; await save(record);
    const sheet = await request('https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId', { method: 'POST',
      body: JSON.stringify({ properties: { title: SHEET_NAME }, sheets: [{ properties: { title: 'Events' },
        data: [{ rowData: [{ values: HEADERS.map((name) => ({ userEnteredValue: { stringValue: name } })) }] }] }] }) });
    record.env.GOOGLE_SHEETS_ID = googleId(sheet.spreadsheetId);
    record.phase = 'sheet-created'; await save(record);
  }
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${record.env.GOOGLE_SHEETS_ID}`;
  const sheet = await request(`${fileUrl}?fields=parents`);
  if (!Array.isArray(sheet.parents) || !sheet.parents.includes(record.env.GOOGLE_DRIVE_FOLDER_ID)) {
    const query = new URLSearchParams({ addParents: record.env.GOOGLE_DRIVE_FOLDER_ID, fields: 'id,parents' });
    if (Array.isArray(sheet.parents) && sheet.parents.length) query.set('removeParents', sheet.parents.map(googleId).join(','));
    await request(`${fileUrl}?${query}`, { method: 'PATCH', body: '{}' });
  }
  const header = await request(`https://sheets.googleapis.com/v4/spreadsheets/${record.env.GOOGLE_SHEETS_ID}/values/Events!A1:M1`);
  if (JSON.stringify(header.values?.[0]) !== JSON.stringify(HEADERS)) fail('記録シートの見出しを確認してください。既存の内容は変更していません。');
  record.phase = 'complete'; await save(record);
  return record;
}

function cookieValue(request) {
  const cookies = (request.headers.cookie ?? '').split(';').map((value) => value.trim().split('='));
  const matching = cookies.filter(([key]) => key === 'hibi_setup');
  return matching.length === 1 ? matching[0][1] : undefined;
}
function page(title, body, working = false) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${working ? '<meta http-equiv="refresh" content="3;url=/status">' : ''}<title>${title}</title><body><main><h1>${title}</h1>${body}</main></body></html>`;
}
function respond(response, code, content, extra = {}) {
  response.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'", ...extra });
  response.end(content);
}
async function readForm(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk.toString('utf8');
    if (Buffer.byteLength(data) > 2048) fail('入力が大きすぎます。');
  }
  return new URLSearchParams(data);
}

export async function startSetup(config, { output = OUTPUT, saved, log = console.log } = {}) {
  const client = oauthClient(config);
  const browserCookie = randomBytes(32).toString('base64url');
  const startToken = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const verifier = await client.generateCodeVerifierAsync();
  const expiresAt = Date.now() + 10 * 60_000;
  let status = 'ready';
  let message = '';
  let record = saved;
  let finished = false;
  const complete = async (code) => {
    try {
      if (!saved) {
        const { tokens } = await client.getToken({ code, codeVerifier: verifier.codeVerifier, redirect_uri: REDIRECT_URI });
        if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) fail('再接続に必要な情報がありません。Googleの許可画面からやり直してください。');
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
        validateGrant(await client.getTokenInfo(tokens.access_token), ticket.getPayload(), config, nonce);
        client.setCredentials(tokens);
        record = { version: 1, phase: 'authorized', env: { GOOGLE_CLIENT_ID: config.clientId,
          GOOGLE_CLIENT_SECRET: config.clientSecret, GOOGLE_DRIVE_OWNER_EMAIL: config.ownerEmail,
          GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_SHEETS_EVENTS_TAB: 'Events' } };
        await savePrivateJson(output, record, { create: true });
      } else {
        client.setCredentials({ refresh_token: saved.env.GOOGLE_DRIVE_REFRESH_TOKEN });
        await checkOwner(client, config);
      }
      await provisionStorage(record, (url, options) => googleJson(client, url, options),
        (value) => savePrivateJson(output, value));
      status = 'complete';
      log('Google保存先の設定が完了しました。秘密情報は .env.google-setup.json に保存しました。Vercelへの登録はまだ行っていません。');
    } catch (error) {
      status = 'failed';
      message = error instanceof SetupError ? error.message : '接続を完了できませんでした。Googleの設定と保存済み情報を確認してください。';
      log(message);
    } finally { finished = true; }
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== 'localhost:8765' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
        respond(response, 403, 'このセットアップはlocalhost専用です。'); return;
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) { respond(response, 400, '不正なリクエストです。'); return; }
      const url = new URL(request.url, ORIGIN);
      if (request.method === 'GET' && url.pathname === '/' && !url.search) {
        respond(response, 200, page('学習アプリのGoogle保存先を設定', `<p>保存先所有者：<strong>${escapeHtml(config.ownerEmail)}</strong></p>
          <p>${saved ? '前回保存した専用フォルダ・記録シートの設定を確認し、残りの作業を再開します。' : `このアカウントのマイドライブに「${FOLDER_NAME}」フォルダと「${SHEET_NAME}」を新しく作成します。`}</p>
          <p>アプリが作成したファイルだけを管理する権限（drive.file）を使います。家族の通常ログインに保存権限は追加しません。</p>
          <p>接続情報はこのMacの秘密ファイルに保存します。Vercelへの登録・公開、AIの呼び出しは行いません。</p>
          ${status === 'ready' ? `<form method="post" action="/start"><input type="hidden" name="confirm" value="${startToken}"><button type="submit">${saved ? '保存した設定で再開する' : 'Googleで接続し、専用の保存先を作成する'}</button></form>` : '<p><a href="/status">設定状況を見る</a></p>'}`),
        // no-referrer makes native form POSTs send Origin:null. Preserve the local
        // form origin while still withholding a referrer from other origins.
        { 'Referrer-Policy': 'same-origin',
          'Set-Cookie': `hibi_setup=${browserCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` }); return;
      }
      if (request.method === 'POST' && url.pathname === '/start' && !url.search) {
        if (status !== 'ready' || Date.now() >= expiresAt || request.headers.origin !== ORIGIN
          || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
          || !equal(cookieValue(request), browserCookie)) fail('開始画面からもう一度操作してください。');
        const form = await readForm(request);
        if (form.getAll('confirm').length !== 1 || !equal(form.get('confirm'), startToken)) fail('開始確認が一致しません。');
        // The body read yields: another request may already have claimed this one-shot flow.
        if (status !== 'ready' || Date.now() >= expiresAt) fail('このセットアップは既に開始されています。');
        status = saved ? 'working' : 'authorizing';
        if (saved) { respond(response, 303, '', { Location: '/status' }); void complete(); return; }
        const authorizationUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES,
          state, nonce, login_hint: config.ownerEmail, code_challenge: verifier.codeChallenge, code_challenge_method: 'S256' });
        respond(response, 303, '', { Location: authorizationUrl }); return;
      }
      if (request.method === 'GET' && url.pathname === '/oauth/callback') {
        if (status !== 'authorizing') fail('この接続確認は使用できません。');
        const code = validateCallback(url, state, cookieValue(request), browserCookie, expiresAt);
        status = 'working';
        respond(response, 303, '', { Location: '/status' }); void complete(code); return;
      }
      if (request.method === 'GET' && url.pathname === '/status' && !url.search && equal(cookieValue(request), browserCookie)) {
        const body = status === 'complete' ? '<p>専用フォルダと記録シートを作成・確認しました。接続情報はこのMacに保存しました。</p><p>このページを閉じて、ターミナルで Ctrl+C を押してください。次にVercelへ環境変数を登録します。</p>'
          : status === 'failed' ? `<p>${escapeHtml(message)}</p><p>秘密情報やGoogleの応答は、このページには表示しません。</p>`
            : '<p>Googleとの接続・保存先の作成を進めています。この画面は自動更新されます。</p>';
        respond(response, 200, page('Google保存先の設定状況', body, !finished)); return;
      }
      respond(response, 404, 'ページがありません。');
    } catch (error) {
      respond(response, 400, page('接続を確認できませんでした', `<p>${escapeHtml(error instanceof SetupError ? error.message : '最初からやり直してください。')}</p>`));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 30;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(8765, '127.0.0.1', accept); });
  const expiryTimer = setTimeout(() => { if (status === 'ready' || status === 'authorizing') server.close(); }, 10 * 60_000);
  expiryTimer.unref();
  server.once('close', () => clearTimeout(expiryTimer));
  log(`セットアップ画面：${ORIGIN} （個人用GoogleアカウントのChromeで開いてください）`);
  return server;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/setup-google.mjs [--config /private/path/config.json | --resume]\n秘密設定は GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_OWNER_EMAIL。未指定時は環境変数から読み込みます。\n保存先: .env.google-setup.json（上書きしません）。接続先: http://localhost:8765/oauth/callback'); return;
  }
  if (args.length === 1 && args[0] === '--resume') {
    const saved = await readPrivateJson(OUTPUT);
    await startSetup(validateSaved(saved), { saved }); return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--config')) fail('使い方は --help で確認してください。');
  let input = process.env;
  if (args.length) input = await readPrivateJson(resolve(args[1]));
  const config = validateConfig(input);
  try { const handle = await open(OUTPUT, 'r'); await handle.close(); fail('保存済み情報があります。--resume で再開してください。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await startSetup(config);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof SetupError ? error.message : 'セットアップを開始できませんでした。秘密設定ファイルの場所・権限とポート8765を確認してください。');
    process.exitCode = 1;
  });
}
