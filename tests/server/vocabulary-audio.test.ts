import assert from 'node:assert/strict';
import test from 'node:test';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import { createVocabularyProviderAudio, extractVocabularySegments, vocabularyAudioSpec, VOCABULARY_AUDIO_LIMITS } from '../../src/server/vocabulary-audio';

const exampleTexts = ['We avoid busy roads.', 'Please avoid making noise.', 'This plan helps avoid delays.'];
const entry = (word = 'avoid'): VocabularyEntry => ({ id: word, word, level: '2級', ipa: '', ipaLabel: '', partOfSpeech: 'verb', definition: '', meaning: '', usageTip: '', examples: exampleTexts.map((text, index) => ({ id: `example-${index + 1}`, text, context: '', translation: '' })), questions: [] });
const spec = vocabularyAudioSpec(entry());
type Alignment = { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
function alignment(text: string, grouped = false): Alignment {
  const characters = grouped ? text.match(/\S+|\s+/g)! : Array.from(text);
  let cursor = 0.2;
  const starts: number[] = [], ends: number[] = [];
  for (const character of characters) {
    starts.push(cursor);
    cursor += /^\s+$/.test(character) ? 0.3 : 0.04 * Array.from(character).length;
    ends.push(cursor);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}
const aligned = alignment(spec.body.text);
const mp3 = Buffer.from([73, 68, 51, 4, 0, 0, 0]);
const payload = (overrides: Record<string, unknown> = {}) => ({ audio_base64: mp3.toString('base64'), alignment: aligned, ...overrides });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('each fixed voice speaks a word and its three examples, with stable content/settings cache identity', () => {
  assert.equal(spec.body.text, `avoid.\n\n${exampleTexts.join('\n\n')}`);
  assert.deepEqual(spec.parts.map(part => part.id), ['word', 'example-1', 'example-2', 'example-3']);
  assert.equal(spec.characters, spec.body.text.length);
  assert.equal(spec.body.voice_settings.speed, 0.95);
  assert.equal(spec.body.model_id, 'eleven_multilingual_v2');
  for (const word of ['avoid', 'contribute', 'plausible']) assert.equal(vocabularyAudioSpec(entry(word)).voiceId, 'EXAVITQu4vr4xnSDxMaL');
  for (const word of ['afford', 'reluctant', 'undermine']) assert.equal(vocabularyAudioSpec(entry(word)).voiceId, 'JBFqnCBsd6RMkjVDRZzb');
  assert.equal(vocabularyAudioSpec(entry()).cacheKey, spec.cacheKey);
  const changed = entry(); changed.examples[0].text = 'Avoid the crowded train.';
  assert.notEqual(vocabularyAudioSpec(changed).cacheKey, spec.cacheKey);
  assert.throws(() => vocabularyAudioSpec(entry('unknown')), { code: 'VOCABULARY_AUDIO_INVALID' });
  assert.throws(() => vocabularyAudioSpec(entry('toString')), { code: 'VOCABULARY_AUDIO_INVALID' });
  const long = entry(); long.examples[0].text = 'a'.repeat(1500);
  assert.throws(() => vocabularyAudioSpec(long), { code: 'VOCABULARY_AUDIO_INVALID' });
});

test('four independent intervals retain the entire sentence and padding without neighboring speech', () => {
  const segments = extractVocabularySegments(spec, aligned);
  assert.deepEqual(segments.map(segment => segment.id), ['word', 'example-1', 'example-2', 'example-3']);
  let offset = 0;
  for (const [index, segment] of segments.entries()) {
    if (index) offset += 2;
    const last = offset + spec.parts[index].text.length - 1;
    const speechStart = aligned.character_start_times_seconds[offset];
    const speechEnd = aligned.character_end_times_seconds[last];
    assert.ok(segment.startSeconds < speechStart, 'Keep a short lead-in before the first phoneme');
    assert.ok(segment.endSeconds >= speechEnd, 'Never cut the final phoneme');
    assert.ok(segment.startSeconds >= 0);
    if (index) assert.ok(segment.startSeconds >= segments[index - 1].endSeconds);
    if (index < 3) {
      const nextSpeechStart = aligned.character_start_times_seconds[last + 3];
      assert.ok(segment.endSeconds < nextSpeechStart, 'Do not play the next example');
      assert.ok(segment.endSeconds > speechEnd, 'Include a short tail within the silence');
    }
    offset = last + 1;
  }
});

test('multi-character alignment tokens work when a token stays within one spoken part', () => {
  const grouped = alignment(spec.body.text, true);
  assert.equal(extractVocabularySegments(spec, grouped).length, 4);
  const oneToken = { characters: [spec.body.text], character_start_times_seconds: [0], character_end_times_seconds: [5] };
  assert.throws(() => extractVocabularySegments(spec, oneToken), { code: 'VOCABULARY_AUDIO_ALIGNMENT' });
});

test('normalized fallback permits only whitespace and equivalent punctuation, and prefers original timing', () => {
  const fallback = alignment(spec.body.text.replaceAll('\n\n', ' '));
  assert.equal(extractVocabularySegments(spec, null, fallback).length, 4);
  const wrongFallback = alignment(spec.body.text.replace('avoid', 'allow'));
  assert.deepEqual(extractVocabularySegments(spec, aligned, wrongFallback), extractVocabularySegments(spec, aligned));
  const quotedEntry = entry(); quotedEntry.examples[0].text = '“Avoid delays,” she said.';
  const quoted = vocabularyAudioSpec(quotedEntry);
  assert.equal(extractVocabularySegments(quoted, null, alignment(quoted.body.text.replaceAll('“', '"').replaceAll('”', '"').replaceAll('\n\n', ' '))).length, 4);
  assert.throws(() => extractVocabularySegments(spec, null, wrongFallback), { code: 'VOCABULARY_AUDIO_ALIGNMENT' });
  const apostrophe = entry(); apostrophe.examples[0].text = "I can't avoid this.";
  const contracted = vocabularyAudioSpec(apostrophe);
  assert.throws(() => extractVocabularySegments(contracted, null, alignment(contracted.body.text.replace("can't", 'cant'))), { code: 'VOCABULARY_AUDIO_ALIGNMENT' });
});

test('invalid, reversed, non-finite, mismatched and cross-part overlapping timelines fail closed', () => {
  const invalids: unknown[] = [null, {}, { ...aligned, characters: [] }, { ...aligned, character_start_times_seconds: [0] }, alignment(spec.body.text.replace('busy', 'easy'))];
  for (const value of [NaN, Infinity, -1, '0']) {
    const copy = structuredClone(aligned); (copy.character_start_times_seconds as unknown[])[5] = value; invalids.push(copy);
  }
  const reverse = structuredClone(aligned); reverse.character_start_times_seconds[8] = 0; invalids.push(reverse);
  const reverseEnds = structuredClone(aligned); reverseEnds.character_end_times_seconds[8] = 0; invalids.push(reverseEnds);
  const backwards = structuredClone(aligned); backwards.character_end_times_seconds[0] = 0; invalids.push(backwards);
  const overlapping = structuredClone(aligned);
  const boundary = spec.parts[0].text.length - 1;
  for (let index = boundary; index < boundary + 4; index++) overlapping.character_end_times_seconds[index] = overlapping.character_end_times_seconds[boundary + 3];
  invalids.push(overlapping);
  for (const value of invalids) assert.throws(() => extractVocabularySegments(spec, value), { code: 'VOCABULARY_AUDIO_ALIGNMENT' });
});

test('provider sends one fixed request, uses the server secret, and returns validated audio/timings', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.ELEVENLABS_API_KEY;
  let calls = 0;
  process.env.ELEVENLABS_API_KEY = 'PRIVATE_TEST_KEY';
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps?output_format=mp3_44100_128');
      assert.equal(new Headers(init?.headers).get('xi-api-key'), 'PRIVATE_TEST_KEY');
      assert.deepEqual(JSON.parse(String(init?.body)), spec.body);
      assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
      return response(payload());
    };
    const result = await createVocabularyProviderAudio(spec);
    assert.deepEqual(result.bytes, new Uint8Array(mp3)); assert.equal(result.segments.length, 4); assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = originalKey;
  }
});

test('provider failures, malformed payloads and oversize audio never retry or expose provider details', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'PRIVATE_TEST_KEY';
  const cases = [
    () => new Response('PRIVATE_PROVIDER_DETAIL PRIVATE_TEST_KEY', { status: 429 }),
    () => { throw new Error('PRIVATE_PROVIDER_DETAIL PRIVATE_TEST_KEY'); },
    () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    () => response(payload({ audio_base64: 'invalid!' })),
    () => response(payload({ audio_base64: '' })),
    () => response(payload({ audio_base64: Buffer.from('not audio').toString('base64') })),
    () => response(payload({ audio_base64: Buffer.alloc(VOCABULARY_AUDIO_LIMITS.audioBytes + 1).toString('base64') })),
    () => response(payload({ alignment: alignment(spec.body.text.replace('avoid', 'allow')) })),
  ];
  try {
    for (const createResponse of cases) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return createResponse(); };
      await assert.rejects(() => createVocabularyProviderAudio(spec), error => {
        assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_DETAIL|PRIVATE_TEST_KEY/); return true;
      });
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = originalKey;
  }
});

test('response streams are bounded even without Content-Length, and generation has no implicit configuration fallback', async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.ELEVENLABS_API_KEY;
  let calls = 0, cancelled = false;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    globalThis.fetch = async () => { calls++; throw new Error('should not call'); };
    await assert.rejects(() => createVocabularyProviderAudio(spec), { code: 'VOCABULARY_AUDIO_NOT_CONFIGURED' });
    assert.equal(calls, 0);
    process.env.ELEVENLABS_API_KEY = 'PRIVATE_TEST_KEY';
    globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(VOCABULARY_AUDIO_LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(() => createVocabularyProviderAudio(spec), { code: 'VOCABULARY_AUDIO_UNAVAILABLE' });
    assert.equal(calls, 1); assert.equal(cancelled, true);
    const changedSpec = { ...spec, voiceId: 'arbitrary-voice' };
    await assert.rejects(() => createVocabularyProviderAudio(changedSpec), { code: 'VOCABULARY_AUDIO_INVALID' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = originalKey;
  }
});
