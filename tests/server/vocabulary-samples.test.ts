import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import type { Profile } from '../../src/lib/types';
import { audioCacheKey, audioRecord } from '../../src/server/audio';
import { getFamilyId } from '../../src/server/env';
import { foldEvents, loadEvents, type StudyEvent } from '../../src/server/google-store';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { prepareVocabularyAudio, readVocabularyAudio, vocabularyEntry, vocabularyPreview } from '../../src/server/vocabulary-samples';

const parent: Profile = { id: 'test-parent', name: 'Parent', role: 'parent', familyId: getFamilyId() };
const bytes = new Uint8Array([73, 68, 51, 4]);
const token = '3c62d3ca-9f79-46eb-a2c3-556f998fbe4c';

/** Both providers are replaced. A missed endpoint fails instead of making a real network request. */
async function withStore(action: (state: {
  rows: unknown[][];
  paidCalls: () => number;
  seed: (event: StudyEvent) => void;
  failProvider: () => void;
  omitKey: () => void;
}) => Promise<void>) {
  const environment: Record<string, string> = {
    NEXTAUTH_SECRET: 'unit-test-secret-with-at-least-thirty-two-characters',
    GOOGLE_CLIENT_ID: 'unit-client', GOOGLE_CLIENT_SECRET: 'unit-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN: `unit-refresh-${Math.random()}`,
    GOOGLE_DRIVE_FOLDER_ID: 'unit-folder', GOOGLE_SHEETS_ID: 'unit-sheet',
    GOOGLE_SHEETS_EVENTS_TAB: 'Events', ELEVENLABS_API_KEY: 'UNIT_TEST_KEY',
  };
  const keys = [...Object.keys(environment), 'GOOGLE_DRIVE_OWNER_EMAIL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  delete process.env.GOOGLE_DRIVE_OWNER_EMAIL;
  const accessToken = mock.method(OAuth2Client.prototype, 'getAccessToken', async () => ({ token: 'UNIT_TEST_TOKEN' }));
  const tokenInfo = mock.method(OAuth2Client.prototype, 'getTokenInfo', async () => ({
    aud: 'unit-client', scopes: ['https://www.googleapis.com/auth/drive.file'], expiry_date: Date.now() + 60000,
  }));
  const rows: unknown[][] = [];
  let paid = 0, failing = false;
  let savedMetadata: { id: string; appProperties: { cacheKey: string } } | undefined;
  const network = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/unit-sheet/values/')) {
      if (init?.method === 'POST') {
        rows.push(...JSON.parse(String(init.body)).values);
        return Response.json({ updates: { updatedRows: 1 } });
      }
      return Response.json({ values: structuredClone(rows) });
    }
    if (url.startsWith('https://api.elevenlabs.io/')) {
      paid += 1;
      if (failing) return new Response('PRIVATE_PROVIDER_DETAILS UNIT_TEST_KEY', { status: 500 });
      const body = JSON.parse(String(init?.body));
      const characters = Array.from(body.text as string);
      return Response.json({ audio_base64: Buffer.from(bytes).toString('base64'), alignment: {
        characters,
        character_start_times_seconds: characters.map((_, index) => index * 0.05),
        character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.05),
      } });
    }
    if (url === 'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files') return Response.json({ ids: ['unit-audio-file'] });
    if (url === 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id') {
      const body = Buffer.from(init!.body as Uint8Array).toString('utf8');
      savedMetadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);
      return Response.json({ id: savedMetadata!.id });
    }
    if (url === 'https://www.googleapis.com/drive/v3/files/unit-audio-file?fields=id,mimeType,size,parents,appProperties,trashed') {
      return Response.json({ id: 'unit-audio-file', mimeType: 'audio/mpeg', size: String(bytes.length), parents: ['unit-folder'],
        appProperties: { purpose: 'hibi-study-audio', cacheKey: savedMetadata?.appProperties.cacheKey } });
    }
    if (url === 'https://www.googleapis.com/drive/v3/files/unit-audio-file?alt=media') return new Response(bytes);
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  });
  try {
    await action({ rows, paidCalls: () => paid, failProvider: () => { failing = true; },
      omitKey: () => { delete process.env.ELEVENLABS_API_KEY; },
      seed: event => { rows.push([event.id, event.type, event.actorId, getFamilyId(), event.createdAt, JSON.stringify(event.payload)]); },
    });
  } finally {
    network.mock.restore(); accessToken.mock.restore(); tokenInfo.mock.restore();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('vocabulary content, generation and playback all reject student and other-family accounts before network access', async () => {
  const network = mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be reached'); });
  try {
    for (const profile of [{ ...parent, role: 'student' as const }, { ...parent, familyId: 'other-family' }]) {
      await assert.rejects(() => vocabularyPreview(profile), { code: 'FORBIDDEN' });
      await assert.rejects(() => prepareVocabularyAudio(profile, 'avoid'), { code: 'FORBIDDEN' });
      await assert.rejects(() => readVocabularyAudio(profile, 'avoid'), { code: 'FORBIDDEN' });
    }
    for (const id of ['', '../avoid', 'arbitrary spoken text', 'Avoid']) {
      assert.throws(() => vocabularyEntry(id), { code: 'SAMPLE_NOT_FOUND' });
      await assert.rejects(() => prepareVocabularyAudio(parent, id), { code: 'SAMPLE_NOT_FOUND' });
    }
    assert.equal(network.mock.callCount(), 0);
  } finally { network.mock.restore(); }
});

test('one paid vocabulary recording persists four sections; replay and repeated prepare reuse the private saved asset', async () => {
  await withStore(async state => {
    await assert.rejects(() => readVocabularyAudio(parent, 'avoid'), { code: 'SAMPLE_NOT_READY' });
    assert.equal(state.paidCalls(), 0, 'GET/playback must never generate audio');
    await prepareVocabularyAudio(parent, 'avoid');
    assert.equal(state.paidCalls(), 1);
    const events = await loadEvents();
    const spec = vocabularyAudioSpec(vocabularyEntry('avoid'));
    const record = audioRecord(events, spec.cacheKey)!;
    assert.equal(record.fileId, 'unit-audio-file');
    assert.deepEqual(record.segments?.map(section => section.id), ['word', 'example-1', 'example-2', 'example-3']);
    assert.equal(record.request.payload.characters, spec.characters);
    assert.deepEqual(await prepareVocabularyAudio(parent, 'avoid'), { ready: true });
    assert.deepEqual(await readVocabularyAudio(parent, 'avoid'), bytes);
    assert.deepEqual(await readVocabularyAudio(parent, 'avoid'), bytes);
    assert.equal(state.paidCalls(), 1);
    const preview = await vocabularyPreview(parent);
    assert.equal(preview.audio.find(item => item.wordId === 'avoid')?.state, 'ready');
    assert.equal(preview.entries.length, 100);
    assert.doesNotMatch(JSON.stringify(preview), /unit-audio-file|requestToken|cacheKey|UNIT_TEST_KEY/);
    assert.equal(state.rows.filter(row => row[1] === 'audio.requested').length, 1);
  });
});

test('concurrent preparation cannot pay twice for the same vocabulary recording', async () => {
  await withStore(async state => {
    const results = await Promise.allSettled([prepareVocabularyAudio(parent, 'afford'), prepareVocabularyAudio(parent, 'afford')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'AUDIO_PENDING');
    assert.equal(state.paidCalls(), 1);
    const events = await loadEvents();
    assert.equal(events.filter(event => event.type === 'audio.requested').length, 1, 'duplicate append rows have one canonical reservation');
    assert.ok(audioRecord(events, vocabularyAudioSpec(vocabularyEntry('afford')).cacheKey)?.segments);
  });
});

test('failed provider request remains reserved; refresh and another prepare do not retry or reveal provider details', async () => {
  await withStore(async state => {
    state.failProvider();
    await assert.rejects(() => prepareVocabularyAudio(parent, 'reluctant'), error => {
      assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_DETAILS|UNIT_TEST_KEY/);
      return true;
    });
    assert.equal(state.paidCalls(), 1);
    assert.equal((await vocabularyPreview(parent)).audio.find(item => item.wordId === 'reluctant')?.state, 'failed');
    await assert.rejects(() => prepareVocabularyAudio(parent, 'reluctant'), { code: 'SAMPLE_AUDIO_FAILED' });
    await assert.rejects(() => readVocabularyAudio(parent, 'reluctant'), { code: 'SAMPLE_NOT_READY' });
    assert.equal(state.paidCalls(), 1);
    assert.equal(state.rows.filter(row => row[1] === 'audio.requested').length, 1);
  });
});

test('missing API key and exhausted shared audio quota refuse generation before reserving or paying', async () => {
  await withStore(async state => {
    state.omitKey();
    await assert.rejects(() => prepareVocabularyAudio(parent, 'contribute'));
    assert.equal(state.rows.length, 0);
    assert.equal(state.paidCalls(), 0);
  });
  await withStore(async state => {
    for (let index = 0; index < 30; index++) state.seed({ id: `past-${index}`, type: 'audio.requested', actorId: parent.id,
      createdAt: new Date().toISOString(), payload: { cacheKey: index.toString(16).padStart(64, '0'), requestToken: token, characters: 100 } });
    await assert.rejects(() => prepareVocabularyAudio(parent, 'contribute'), { code: 'AUDIO_LIMIT' });
    assert.equal(state.rows.length, 30);
    assert.equal(state.paidCalls(), 0);
  });
});

test('uncompleted reservations and ready records with a different token never trigger another paid request', async () => {
  await withStore(async state => {
    const cacheKey = vocabularyAudioSpec(vocabularyEntry('undermine')).cacheKey;
    state.seed({ id: 'existing-reservation', type: 'audio.requested', actorId: parent.id,
      createdAt: new Date().toISOString(), payload: { cacheKey, requestToken: token, characters: 100 } });
    state.seed({ id: 'unrelated-ready', type: 'audio.ready', actorId: parent.id,
      createdAt: new Date().toISOString(), payload: { cacheKey, requestToken: '5105ed26-813a-4b0b-a322-51f75547ae91', fileId: 'unrelated-file' } });
    assert.equal((await vocabularyPreview(parent)).audio.find(item => item.wordId === 'undermine')?.state, 'pending');
    await assert.rejects(() => prepareVocabularyAudio(parent, 'undermine'), { code: 'AUDIO_PENDING' });
    await assert.rejects(() => readVocabularyAudio(parent, 'undermine'), { code: 'SAMPLE_NOT_READY' });
    assert.equal(state.paidCalls(), 0);
  });
});

test('legacy audio.ready rows without sections remain valid and do not collide with vocabulary assets', async () => {
  await withStore(async state => {
    const cacheKey = audioCacheKey('An existing English question.', 'JBFqnCBsd6RMkjVDRZzb');
    const createdAt = new Date().toISOString();
    state.seed({ id: 'legacy-reservation', type: 'audio.requested', actorId: parent.id, createdAt,
      payload: { cacheKey, requestToken: token, characters: 29 } });
    state.seed({ id: 'legacy-ready', type: 'audio.ready', actorId: parent.id, createdAt,
      payload: { cacheKey, requestToken: token, fileId: 'existing-audio-file' } });
    const events = await loadEvents();
    assert.equal(audioRecord(events, cacheKey)?.fileId, 'existing-audio-file');
    assert.equal(audioRecord(events, cacheKey)?.segments, undefined);
    assert.doesNotThrow(() => foldEvents(events));
    const preview = await vocabularyPreview(parent);
    assert.ok(preview.audio.every(item => item.state === 'missing'));
    assert.doesNotMatch(JSON.stringify(preview), /existing-audio-file/);
    assert.equal(state.paidCalls(), 0);
  });
});
