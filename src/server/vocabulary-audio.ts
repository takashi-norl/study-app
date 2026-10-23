import 'server-only';
import { createHash } from 'node:crypto';
import type { VocabularyEntry } from '@/lib/vocabulary-types';
import { ApiError } from './config';

export const VOCABULARY_AUDIO_LIMITS = { characters: 1500, audioBytes: 2 * 1024 * 1024, responseBytes: 4 * 1024 * 1024 } as const;
const MODEL = 'eleven_multilingual_v2';
const SETTINGS = { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.95 } as const;
const SARAH = { voiceId: 'EXAVITQu4vr4xnSDxMaL', voiceLabel: 'Sarah（女性）' } as const;
const GEORGE = { voiceId: 'JBFqnCBsd6RMkjVDRZzb', voiceLabel: 'George（男性）' } as const;
const VOICES: Record<string, typeof SARAH | typeof GEORGE> = { avoid: SARAH, contribute: SARAH, plausible: SARAH, afford: GEORGE, reluctant: GEORGE, undermine: GEORGE };
const PART_IDS = ['word', 'example-1', 'example-2', 'example-3'] as const;

export interface VocabularyAudioSegment { id: string; startSeconds: number; endSeconds: number }
export interface VocabularyAudioSpec {
  body: { text: string; model_id: typeof MODEL; voice_settings: typeof SETTINGS };
  voiceId: string;
  voiceLabel: string;
  cacheKey: string;
  characters: number;
  parts: { id: string; text: string }[];
}

const cacheKey = (voiceId: string, text: string) => createHash('sha256').update(JSON.stringify(['vocabulary-audio-v1', MODEL, voiceId, SETTINGS, text])).digest('hex');
const invalidSpec = () => new ApiError(422, 'この単語の音声設定を確認してください。', 'VOCABULARY_AUDIO_INVALID');
const invalidAlignment = () => new ApiError(503, '音声の区切りを確認できませんでした。', 'VOCABULARY_AUDIO_ALIGNMENT');
const unavailable = () => new ApiError(503, '音声を作成できませんでした。', 'VOCABULARY_AUDIO_UNAVAILABLE');

/** The browser selects a vocabulary entry; it never supplies provider text or settings. */
export function vocabularyAudioSpec(entry: VocabularyEntry): VocabularyAudioSpec {
  const voice = Object.hasOwn(VOICES, entry.word) ? VOICES[entry.word] : undefined;
  if (!voice || entry.examples.length !== 3) throw invalidSpec();
  const parts = [{ id: 'word', text: `${entry.word}.` }, ...entry.examples.map((example, index) => ({ id: PART_IDS[index + 1], text: example.text.trim() }))];
  if (parts.some(part => !part.text)) throw invalidSpec();
  const text = parts.map(part => part.text).join('\n\n');
  if (text.length > VOCABULARY_AUDIO_LIMITS.characters) throw invalidSpec();
  return { body: { text, model_id: MODEL, voice_settings: SETTINGS }, ...voice, cacheKey: cacheKey(voice.voiceId, text), characters: text.length, parts };
}

function validateSpec(spec: VocabularyAudioSpec): void {
  if (![SARAH.voiceId, GEORGE.voiceId].some(id => id === spec.voiceId)
    || spec.parts.length !== 4 || spec.parts.some((part, index) => part.id !== PART_IDS[index] || !part.text || part.text.trim() !== part.text)
    || spec.body.text !== spec.parts.map(part => part.text).join('\n\n')
    || spec.body.text.length > VOCABULARY_AUDIO_LIMITS.characters || spec.characters !== spec.body.text.length
    || spec.body.model_id !== MODEL || JSON.stringify(spec.body.voice_settings) !== JSON.stringify(SETTINGS)
    || spec.cacheKey !== cacheKey(spec.voiceId, spec.body.text)) throw invalidSpec();
}

type AlignedUnit = { text: string; token: number; start: number; end: number };
function alignedUnits(value: unknown): AlignedUnit[] {
  if (!value || typeof value !== 'object') throw invalidAlignment();
  const input = value as Record<string, unknown>;
  const chars = input.characters, starts = input.character_start_times_seconds, ends = input.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) || !chars.length || chars.length > 6000 || chars.length !== starts.length || chars.length !== ends.length) throw invalidAlignment();
  const units: AlignedUnit[] = [];
  let previousStart = 0, previousEnd = 0;
  for (let index = 0; index < chars.length; index++) {
    const text = chars[index], start = starts[index], end = ends[index];
    if (typeof text !== 'string' || !text || text.length > 6000
      || typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end < start || end > 600 || start < previousStart || end < previousEnd) throw invalidAlignment();
    for (const character of text) units.push({ text: character, token: index, start, end });
    if (units.length > 6000) throw invalidAlignment();
    previousStart = start; previousEnd = end;
  }
  return units;
}

/** Ignore only whitespace and equivalent punctuation glyphs, never words, case, or apostrophes. */
function canonicalCharacter(character: string): string {
  if (/\s/u.test(character)) return '';
  if (/[‘’]/u.test(character)) return "'";
  if (/[“”]/u.test(character)) return '"';
  if (/[‐‑–—]/u.test(character)) return '-';
  return character;
}

function segmentAlignment(spec: VocabularyAudioSpec, input: unknown, normalized: boolean): VocabularyAudioSegment[] {
  const original = alignedUnits(input);
  const transform = (text: string) => normalized ? canonicalCharacter(text) : text;
  const units = original.filter(unit => transform(unit.text));
  if (units.map(unit => transform(unit.text)).join('') !== Array.from(spec.body.text).map(transform).join('')) throw invalidAlignment();
  const ranges: { id: string; start: number; end: number; firstToken: number; lastToken: number }[] = [];
  let offset = 0;
  for (const [index, part] of spec.parts.entries()) {
    if (index && !normalized) offset += 2; // Two newlines separate the fixed script parts.
    const length = Array.from(part.text).map(transform).filter(Boolean).length;
    const first = units[offset], last = units[offset + length - 1];
    if (!first || !last || first.start >= last.end) throw invalidAlignment();
    const previous = ranges.at(-1);
    // A token spanning two spoken parts cannot safely be split into separate clips.
    if (previous && (first.token <= previous.lastToken || first.start < previous.end)) throw invalidAlignment();
    ranges.push({ id: part.id, start: first.start, end: last.end, firstToken: first.token, lastToken: last.token });
    offset += length;
  }
  const duration = original.at(-1)!.end;
  return ranges.map((range, index) => {
    const previous = ranges[index - 1], next = ranges[index + 1];
    // Share a silence gap at its midpoint. Padding never includes another spoken part.
    const leftBoundary = previous ? (previous.end + range.start) / 2 : 0;
    const rightBoundary = next ? (range.end + next.start) / 2 : duration;
    return { id: range.id, startSeconds: Math.max(leftBoundary, range.start - 0.12, 0), endSeconds: Math.min(rightBoundary, range.end + 0.18) };
  });
}

export function extractVocabularySegments(spec: VocabularyAudioSpec, alignment: unknown, normalizedAlignment?: unknown): VocabularyAudioSegment[] {
  validateSpec(spec);
  try { return segmentAlignment(spec, alignment, false); }
  catch { return segmentAlignment(spec, normalizedAlignment, true); }
}

function decodeAudio(value: unknown): Uint8Array {
  const maxBase64Length = 4 * Math.ceil(VOCABULARY_AUDIO_LIMITS.audioBytes / 3);
  if (typeof value !== 'string' || !value.length || value.length > maxBase64Length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > VOCABULARY_AUDIO_LIMITS.audioBytes || bytes.toString('base64') !== value) throw unavailable();
  const mp3 = bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224);
  if (!mp3) throw unavailable();
  return new Uint8Array(bytes);
}

async function boundedResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > VOCABULARY_AUDIO_LIMITS.responseBytes)) {
    await response.body?.cancel(); throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > VOCABULARY_AUDIO_LIMITS.responseBytes) { await reader.cancel(); throw unavailable(); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw unavailable(); }
  finally { reader.releaseLock(); }
}

/** Official timestamps API; exactly one paid request and no automatic retries. */
export async function createVocabularyProviderAudio(spec: VocabularyAudioSpec): Promise<{ bytes: Uint8Array; segments: VocabularyAudioSegment[] }> {
  validateSpec(spec);
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ApiError(503, '音声の接続設定が必要です。', 'VOCABULARY_AUDIO_NOT_CONFIGURED');
  let response: Response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${spec.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(spec.body), signal: AbortSignal.timeout(60000), redirect: 'error', cache: 'no-store',
    });
  } catch { throw unavailable(); }
  if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
    await response.body?.cancel(); throw unavailable();
  }
  const payload = await boundedResponse(response);
  if (!payload || typeof payload !== 'object') throw unavailable();
  const result = payload as Record<string, unknown>;
  const bytes = decodeAudio(result.audio_base64);
  const segments = extractVocabularySegments(spec, result.alignment, result.normalized_alignment);
  return { bytes, segments };
}
