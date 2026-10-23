import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Profile } from '../../src/lib/types';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import { VOCABULARY_IMPORT_BODY_BYTES, vocabularyImportBundleSchema } from '../../src/lib/vocabulary-import';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { importVocabularyAudio, readVocabularyImport, validateVocabularyImportClip } from '../../src/server/vocabulary-import';

const entry: VocabularyEntry = {
  id: 'grade3-study', word: 'study', level: '3級', voice: 'female', ipa: '/ˈstʌdi/', ipaLabel: '米音', partOfSpeech: '動詞', definition: 'To learn about a subject.', meaning: '勉強する', usageTip: 'study English',
  examples: ['I study English.', 'We study after school.', 'She likes to study history.'].map((text, index) => ({ id: `example-${index + 1}`, context: '学習', text, translation: '勉強する。' })),
  recall: { prompt: 'I ___ English.', answers: ['study'], explanation: 'study English' }, production: { prompt: 'Write a sentence.', modelAnswer: 'I study English.', checkpoints: ['study'] }, questions: [],
};
const bytes = Buffer.from([73, 68, 51, 4, 0, 0, 0]);
const clip = { wordId: entry.id, cacheKey: vocabularyAudioSpec(entry).cacheKey, segments: ['word', 'example-1', 'example-2', 'example-3'].map((id, index) => ({ id: id as 'word' | 'example-1' | 'example-2' | 'example-3', startSeconds: index * 2, endSeconds: index * 2 + 1 })), audioBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
const input = { schemaVersion: 2, batchId: 'grade3-001', clips: [clip] };
const profile: Profile = { id: 'super', name: 'Owner', role: 'parent', familyId: 'import-test-family', accessLevel: 'superuser' };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://study.example/api/admin/vocabulary-import', { method: 'POST', headers: { origin: 'https://study.example', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function withMembers(work: () => Promise<void>) {
  const previous = { family: process.env.FAMILY_ID, members: process.env.ALLOWED_FAMILY_MEMBERS_JSON };
  process.env.FAMILY_ID = 'import-test-family';
  process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify([{ id: 'super', name: 'Owner', email: 'takashi.oikawa@gmail.com', role: 'parent' }, { id: 'manager', name: 'Manager', email: 'manager@example.com', role: 'parent' }, { id: 'student', name: 'Student', email: 'student@example.com', role: 'student' }]);
  try { await work(); } finally {
    if (previous.family === undefined) delete process.env.FAMILY_ID; else process.env.FAMILY_ID = previous.family;
    if (previous.members === undefined) delete process.env.ALLOWED_FAMILY_MEMBERS_JSON; else process.env.ALLOWED_FAMILY_MEMBERS_JSON = previous.members;
  }
}

test('an imported clip must match its indexed text, bytes, MP3 format, and four ordered sections', () => {
  assert.deepEqual(validateVocabularyImportClip(clip, entry).bytes, bytes);
  for (const changed of [
    { ...clip, wordId: 'another-word' }, { ...clip, cacheKey: '0'.repeat(64) }, { ...clip, sha256: '0'.repeat(64) },
    { ...clip, audioBase64: `${clip.audioBase64} ` }, { ...clip, segments: [...clip.segments].reverse() },
  ]) assert.throws(() => validateVocabularyImportClip(changed, entry));
  const invalidAudio = Buffer.from('not an mp3');
  assert.throws(() => validateVocabularyImportClip({ ...clip, audioBase64: invalidAudio.toString('base64'), sha256: createHash('sha256').update(invalidAudio).digest('hex') }, entry));
  assert.throws(() => vocabularyImportBundleSchema.parse({ ...input, clips: [clip, clip] }));
});

test('import reader rejects cross-origin, absent-origin, oversize header, and streamed overflow', async () => {
  assert.deepEqual(await readVocabularyImport(request(input)), input);
  await assert.rejects(() => readVocabularyImport(request(input, { origin: 'https://attacker.example' })), { status: 403 });
  await assert.rejects(() => readVocabularyImport(request(input, { origin: '' })), { status: 403 });
  await assert.rejects(() => readVocabularyImport(request(input, { 'content-length': String(VOCABULARY_IMPORT_BODY_BYTES + 1) })), { status: 413 });
  let cancelled = false;
  const streamed = new Request('https://study.example/api/admin/vocabulary-import', {
    method: 'POST', headers: { origin: 'https://study.example', 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(VOCABULARY_IMPORT_BODY_BYTES + 1)); }, cancel() { cancelled = true; } }),
  } as RequestInit & { duplex: string });
  await assert.rejects(() => readVocabularyImport(streamed), { status: 413 }); assert.equal(cancelled, true);
  await assert.rejects(() => readVocabularyImport(request({ ...input, clips: [clip, clip] })));
});

test('only current Super User can import; manager/student or unindexed word cannot touch storage', () => withMembers(async () => {
  let calls = 0;
  const store = { entries: () => [entry], find: async () => { calls++; return null; }, save: async () => { calls++; return 'private-file-id'; }, download: async () => bytes };
  for (const id of ['manager', 'student', 'unknown']) await assert.rejects(() => importVocabularyAudio({ ...profile, id }, input, store), { status: 403 });
  await assert.rejects(() => importVocabularyAudio(profile, { ...input, clips: [{ ...clip, wordId: 'not-indexed' }] }, store), { status: 400 });
  await assert.rejects(() => importVocabularyAudio(profile, { ...input, batchId: 'legacy-100' }, store), { status: 409 });
  assert.equal(calls, 0);
}));

test('successful import saves once and repeated import verifies/reuses the private cache without Sheets or TTS', () => withMembers(async () => {
  let stored: string | null = null, saves = 0, downloads = 0;
  const store = { entries: () => [entry], find: async () => stored, save: async (key: string, data: Uint8Array) => { assert.equal(key, clip.cacheKey); assert.deepEqual(Buffer.from(data), bytes); saves++; stored = 'private-file-id'; return stored; }, download: async () => { downloads++; return bytes; } };
  const first = await importVocabularyAudio(profile, input, store);
  assert.equal(first.reused, false); assert.equal(first.audio[0].fileId, 'private-file-id');
  assert.equal(first.audio[0].voiceLabel, vocabularyAudioSpec(entry).voiceLabel);
  const second = await importVocabularyAudio(profile, input, store);
  assert.equal(second.reused, true); assert.deepEqual(second.audio, first.audio); assert.equal(saves, 1); assert.equal(downloads, 1);
  await assert.rejects(() => importVocabularyAudio(profile, input, { ...store, download: async () => Buffer.from('different audio') }), { status: 409 });
  assert.equal(saves, 1);
}));
