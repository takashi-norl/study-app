import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import catalog from '../../content/eiken-audio-samples.json';
import type { EikenSample, SampleAudio } from '@/lib/eiken-sample-types';
import type { Profile } from '@/lib/types';
import { ApiError, requiredEnv } from './config';
import { assertExternalEffectAllowed, externalEffectEnabled } from './environment';
import { assertSuperUser, getWorkspaceId } from './env';
import { audioRecord, audioSlotId, checkAudioQuota } from './audio';
import { appendEvent, downloadAudioCache, loadEvents, MAX_AUDIO_BYTES, saveAudioCache } from './google-store';

const voices = { male: { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George（男性）' }, female: { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah（女性）' } } as const;
const model = 'eleven_v3';
const samples = catalog.samples as EikenSample[];

export function assertSampleAccess(profile: Profile) {
  if (profile.workspaceId !== getWorkspaceId()) throw new ApiError(403, 'ログインして教材を利用してください。', 'FORBIDDEN');
}

/** Only curated, versioned text can incur generation charges; no arbitrary browser input. */
export function sampleAudioSpec(sampleId: string) {
  const sample = samples.find(item => item.id === sampleId && item.skill !== 'Writing');
  if (!sample) throw new ApiError(404, '音声の見本が見つかりません。', 'SAMPLE_NOT_FOUND');
  const script = sample.skill === 'Listening' ? sample.script! : [{ speaker: sample.level === '2級' ? 'male' as const : 'female' as const, text: sample.passage! }];
  const inputs = script.map(turn => ({ text: turn.text, voice_id: voices[turn.speaker].id }));
  const characters = inputs.reduce((sum, input) => sum + input.text.length, 0);
  if (!characters || characters > 1500) throw new ApiError(413, '見本の音声が長すぎます。', 'SAMPLE_TOO_LONG');
  const body = { inputs, model_id: model, language_code: 'en', seed: 17 };
  const cacheKey = createHash('sha256').update(JSON.stringify(['eiken-samples-v1', body])).digest('hex');
  const voiceLabel = [...new Set(script.map(turn => voices[turn.speaker].name))].join('・');
  return { body, cacheKey, characters, voiceLabel };
}

export async function samplePreview(profile: Profile) {
  assertSampleAccess(profile);
  const events = await loadEvents();
  const audio: SampleAudio[] = samples.filter(sample => sample.skill !== 'Writing').map(sample => {
    const spec = sampleAudioSpec(sample.id);
    const record = audioRecord(events, spec.cacheKey);
    return { sampleId: sample.id, url: `/api/admin/eiken-samples/audio?sampleId=${sample.id}`, voiceLabel: spec.voiceLabel, durationSeconds: 0,
      state: record?.fileId ? 'ready' : record?.failed ? 'failed' : record ? 'pending' : 'missing' };
  });
  return { samples, audio, canPrepareAudio: profile.accessLevel === 'superuser' && externalEffectEnabled('audio') };
}

/** Official multi-speaker API. Saved once; repeat listening never invokes the provider. */
export async function createSampleProviderAudio(spec: ReturnType<typeof sampleAudioSpec>): Promise<Uint8Array> {
  assertExternalEffectAllowed('audio');
  const key = requiredEnv('ELEVENLABS_API_KEY').trim();
  const response = await fetch('https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(spec.body), signal: AbortSignal.timeout(90000), redirect: 'error', cache: 'no-store',
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('audio/') || !response.body) {
    console.error('Eiken sample provider status:', response.status);
    await response.body?.cancel(); throw new ApiError(503, '音声を準備できませんでした。自動で再生成はしません。', 'SAMPLE_AUDIO_UNAVAILABLE');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_AUDIO_BYTES) { await reader.cancel(); throw new ApiError(413, '音声が長すぎます。', 'AUDIO_TOO_LARGE'); }
    chunks.push(next.value);
  }
  if (!size) throw new ApiError(503, '音声を受信できませんでした。', 'SAMPLE_AUDIO_UNAVAILABLE');
  return new Uint8Array(Buffer.concat(chunks));
}

export async function prepareSampleAudio(profile: Profile, sampleId: string) {
  assertSampleAccess(profile);
  assertSuperUser(profile);
  const spec = sampleAudioSpec(sampleId);
  const events = await loadEvents();
  const previous = audioRecord(events, spec.cacheKey);
  if (previous?.fileId) return { ready: true };
  if (previous) throw new ApiError(409, previous.failed ? '準備に失敗しています。内容を確認してから再試行します。' : '音声を準備中です。状況を確認してください。', previous.failed ? 'SAMPLE_AUDIO_FAILED' : 'AUDIO_PENDING');
  assertExternalEffectAllowed('audio');
  requiredEnv('ELEVENLABS_API_KEY');
  checkAudioQuota(events, spec.characters);
  const slotId = audioSlotId(events); const requestToken = randomUUID();
  await appendEvent({ id: slotId, type: 'audio.requested', actorId: profile.id, createdAt: new Date().toISOString(), payload: {
    cacheKey: spec.cacheKey, requestToken, characters: spec.characters,
  } });
  const canonical = await loadEvents();
  if (canonical.find(event => event.id === slotId)?.payload.requestToken !== requestToken) throw new ApiError(409, 'ほかの音声を準備中です。状況を確認してください。', 'AUDIO_PENDING');
  try {
    const bytes = await createSampleProviderAudio(spec);
    const fileId = await saveAudioCache(spec.cacheKey, bytes);
    await appendEvent({ id: `audio-ready:${spec.cacheKey}`, type: 'audio.ready', actorId: profile.id, createdAt: new Date().toISOString(), payload: { cacheKey: spec.cacheKey, requestToken, fileId } });
    return { ready: true };
  } catch (error) {
    try { await appendEvent({ id: `audio-failed:${spec.cacheKey}`, type: 'audio.failed', actorId: profile.id, createdAt: new Date().toISOString(), payload: { cacheKey: spec.cacheKey, requestToken } }); } catch { /* Keep reservation on uncertain outcomes; no automatic paid retries. */ }
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, '音声の準備が中断しました。自動で再生成はしません。', 'SAMPLE_AUDIO_UNAVAILABLE');
  }
}

export async function readSampleAudio(profile: Profile, sampleId: string) {
  assertSampleAccess(profile);
  const spec = sampleAudioSpec(sampleId);
  const previous = audioRecord(await loadEvents(), spec.cacheKey);
  if (!previous?.fileId) throw new ApiError(404, 'この音声はまだ準備されていません。', 'SAMPLE_NOT_READY');
  return downloadAudioCache(previous.fileId, spec.cacheKey);
}

/** Safari requests byte ranges for native audio controls and seeking. Authorization precedes this. */
export function sampleAudioResponse(bytes: Uint8Array, range: string | null, head = false): Response {
  const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
  let start = 0; let end = bytes.byteLength - 1; let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { ...Object.fromEntries(headers), 'Content-Range': `bytes */${bytes.byteLength}` } });
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    else start = Math.max(0, bytes.byteLength - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { ...Object.fromEntries(headers), 'Content-Range': `bytes */${bytes.byteLength}` } });
    status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${bytes.byteLength}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  return new Response(head ? null : new Uint8Array(bytes.slice(start, end + 1)), { status, headers });
}
