import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { VocabularyEntry } from '../src/lib/vocabulary-types';
import { audioSegmentsSchema } from '../src/server/audio-segments';
import { extractVocabularySegments, vocabularyAudioSpec, VOCABULARY_AUDIO_LIMITS, type VocabularyAudioSpec } from '../src/server/vocabulary-audio';

export const AUDIO_BATCH_BUDGET_USD = 400;
// The current Creator additional-credit rate is more conservative than the API pricing headline.
// This reservation is a spending estimate, not an ElevenLabs billing limit.
export const AUDIO_BATCH_USD_PER_1000_CHARACTERS = 0.182;
const MICRO_USD_PER_CHARACTER = 182;
const MAX_ITEMS = 7500;
const HEX = /^[a-f0-9]{64}$/;
const levelSchema = z.enum(['3級', '準2級', '2級', '準1級']);
const entrySchema = z.object({
  id: z.string().min(1).max(160), word: z.string().trim().min(1).max(120), level: levelSchema,
  voice: z.enum(['female', 'male']).optional(),
  examples: z.array(z.object({ text: z.string().trim().min(1).max(1400) }).passthrough()).length(3),
}).passthrough();
const approvedSchema = z.object({
  entry: entrySchema,
  review: z.object({ status: z.literal('approved'), contentSha256: z.string().regex(HEX) }).passthrough(),
  provenance: z.unknown().optional(),
}).passthrough();
const documentSchema = z.object({ schemaVersion: z.literal(1), batchId: z.string().optional(), entries: z.array(approvedSchema).max(MAX_ITEMS) }).passthrough();
export type ApprovedAudioEntry = z.infer<typeof approvedSchema>;
type Reservation = { schemaVersion: 1; cacheKey: string; requestId: string; characters: number; reservedMicroUsd: number; createdAt: string };
const reservationSchema = z.object({
  schemaVersion: z.literal(1), cacheKey: z.string().regex(HEX), requestId: z.string().uuid(),
  characters: z.number().int().positive().max(VOCABULARY_AUDIO_LIMITS.characters),
  reservedMicroUsd: z.number().int().positive(), createdAt: z.string().datetime(),
}).strict();
const assetSchema = z.object({
  schemaVersion: z.literal(1), cacheKey: z.string().regex(HEX), wordId: z.string(), word: z.string(),
  contentSha256: z.string().regex(HEX), voiceId: z.string(), voiceLabel: z.string(), model: z.literal('eleven_multilingual_v2'),
  characters: z.number().int(), mp3Sha256: z.string().regex(HEX), segments: audioSegmentsSchema,
  generatedAt: z.string().datetime(),
}).strict();
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Same canonical object-key ordering used by the text approval pipeline. Arrays retain their order. */
export function canonicalAudioJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAudioJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAudioJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Approval content must be JSON serializable.');
  return encoded;
}
export const hashAudioEntry = (entry: unknown) => sha256(canonicalAudioJson(entry));

export function parseApprovedAudioBatch(value: unknown): ApprovedAudioEntry[] {
  // Hash the original entry before schema parsing: never approve a silently transformed entry.
  const result = documentSchema.safeParse(value);
  if (!result.success) throw new Error('Expected a version 1 approved vocabulary batch with three examples per entry.');
  const original = value as { entries: ApprovedAudioEntry[] };
  for (const [index, item] of original.entries.entries()) {
    if (hashAudioEntry(item.entry) !== item.review.contentSha256) throw new Error(`Approval hash does not match entry ${item.entry.id}.`);
    if (canonicalAudioJson(item.entry) !== canonicalAudioJson(result.data.entries[index].entry)) throw new Error(`Entry ${item.entry.id} requires normalization before approval.`);
  }
  return original.entries;
}

export function approvedAudioSpec(item: ApprovedAudioEntry): VocabularyAudioSpec {
  if (item.review.status !== 'approved' || hashAudioEntry(item.entry) !== item.review.contentSha256) throw new Error('The audio input has not passed content approval.');
  // The shared implementation reads only word, voice, and examples; grade tags do not affect audio.
  return vocabularyAudioSpec(item.entry as unknown as VocabularyEntry);
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateWrite(file: string, content: string | Uint8Array, exclusive = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const target = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(target, file);
  await syncDirectory(path.dirname(file));
}
const writeJson = (file: string, value: unknown, exclusive = false) => privateWrite(file, `${JSON.stringify(value, null, 2)}\n`, exclusive);
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));
const assetDirectory = (output: string, key: string) => path.join(output, 'assets', key);
const reservationFile = (output: string, key: string) => path.join(output, 'reservations', `${key}.json`);

async function reservations(output: string): Promise<Map<string, Reservation>> {
  const directory = path.join(output, 'reservations');
  if (!await exists(directory)) return new Map();
  const result = new Map<string, Reservation>();
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.json')) continue;
    const record = reservationSchema.parse(await readJson(path.join(directory, name)));
    if (name !== `${record.cacheKey}.json` || record.reservedMicroUsd < record.characters * MICRO_USD_PER_CHARACTER) throw new Error('The audio spending ledger is invalid.');
    result.set(record.cacheKey, record);
  }
  return result;
}

function decodeMp3(value: unknown): Buffer {
  const maxBase64 = 4 * Math.ceil(VOCABULARY_AUDIO_LIMITS.audioBytes / 3);
  if (typeof value !== 'string' || !value.length || value.length > maxBase64 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid_audio');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > VOCABULARY_AUDIO_LIMITS.audioBytes || bytes.toString('base64') !== value) throw new Error('invalid_audio');
  if (bytes.subarray(0, 3).toString('ascii') !== 'ID3' && !(bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224)) throw new Error('invalid_audio');
  return bytes;
}

async function cachedAssetReady(output: string, item: ApprovedAudioEntry, spec: VocabularyAudioSpec): Promise<boolean> {
  const directory = assetDirectory(output, spec.cacheKey), file = path.join(directory, 'asset.json');
  if (!await exists(file)) return false;
  const asset = assetSchema.parse(await readJson(file));
  const bytes = await readFile(path.join(directory, 'audio.mp3'));
  if (asset.cacheKey !== spec.cacheKey || asset.voiceId !== spec.voiceId || asset.characters !== spec.characters || asset.mp3Sha256 !== sha256(bytes)) throw new Error(`Cached audio ${item.entry.id} failed its integrity check; it will not be regenerated.`);
  return true;
}

/** Reprocessing a captured response is local and never invokes TTS. Preserve MP3 before timing validation. */
async function recoverCapturedAudio(output: string, item: ApprovedAudioEntry, spec: VocabularyAudioSpec): Promise<void> {
  const directory = assetDirectory(output, spec.cacheKey);
  const payload = await readJson(path.join(directory, 'provider-response.json'));
  if (!payload || typeof payload !== 'object') throw new Error('invalid_response');
  const response = payload as Record<string, unknown>;
  const bytes = decodeMp3(response.audio_base64);
  await privateWrite(path.join(directory, 'audio.mp3'), bytes);
  const segments = audioSegmentsSchema.parse(extractVocabularySegments(spec, response.alignment, response.normalized_alignment));
  await writeJson(path.join(directory, 'asset.json'), {
    schemaVersion: 1, cacheKey: spec.cacheKey, wordId: item.entry.id, word: item.entry.word,
    contentSha256: item.review.contentSha256, voiceId: spec.voiceId, voiceLabel: spec.voiceLabel,
    model: spec.body.model_id, characters: spec.characters, mp3Sha256: sha256(bytes), segments,
    generatedAt: new Date().toISOString(),
  });
  await writeJson(path.join(directory, 'state.json'), { state: 'ready', updatedAt: new Date().toISOString() });
}

/** Persist each response chunk before interpreting it. A partial response is never paid for again automatically. */
async function captureResponse(response: Response, directory: string): Promise<void> {
  const partial = path.join(directory, 'provider-response.partial');
  const handle = await open(partial, 'wx', 0o600);
  const reader = response.body?.getReader();
  let size = 0;
  try {
    if (!reader) throw new Error('empty_response');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VOCABULARY_AUDIO_LIMITS.responseBytes) { await reader.cancel(); throw new Error('oversized_response'); }
      await handle.writeFile(value);
      await handle.sync();
    }
    await handle.sync();
  } finally { reader?.releaseLock(); await handle.close(); }
  await rename(partial, path.join(directory, 'provider-response.json'));
  await syncDirectory(directory);
}

export type AudioBatchReport = {
  mode: 'dry-run' | 'run'; total: number; ready: number; existing: number; missing: number; failed: number;
  generated: number; recovered: number; requests: number; charactersRequested: number;
  plannedRequests: number; plannedCharacters: number; plannedUsd: number;
  reservedUsd: number; budgetUsd: number; elapsedSeconds: number; concurrency: number;
  stopped?: 'budget' | 'provider_auth_or_credit' | 'provider_error' | 'uncertain_request' | 'captured_response_invalid' | 'local_storage_error';
};
export type AudioBatchOptions = {
  output: string; entries: ApprovedAudioEntry[]; run?: boolean; maxItems?: number; budgetUsd?: number; concurrency?: number;
  /** Existing cloud assets are preserved by matching their immutable audio spec, without a Drive download. */
  existingEntries?: readonly VocabularyEntry[];
  apiKey?: string; fetcher?: typeof fetch; onProgress?: (report: AudioBatchReport) => void;
};

export async function runAudioBatch(options: AudioBatchOptions): Promise<AudioBatchReport> {
  const started = Date.now(), output = path.resolve(options.output), maxItems = options.maxItems ?? 1;
  const budgetUsd = options.budgetUsd ?? AUDIO_BATCH_BUDGET_USD;
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS) throw new Error('maxItems must be between 1 and 7500.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('concurrency must be an integer from 1 to 3.');
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > AUDIO_BATCH_BUDGET_USD) throw new Error('The audio budget must be positive and no more than USD 400.');
  if (options.entries.length > MAX_ITEMS) throw new Error('The batch exceeds 7500 entries.');
  const ids = new Set<string>(), lemmas = new Set<string>();
  const existing = new Map((options.existingEntries ?? []).map(entry => [entry.word.normalize('NFKC').toLowerCase(), vocabularyAudioSpec(entry)]));
  const items = options.entries.map(item => {
    const normalized = item.entry.word.normalize('NFKC').toLowerCase();
    if (ids.has(item.entry.id) || lemmas.has(normalized)) throw new Error('The approved audio input contains duplicate IDs or lemmas.');
    ids.add(item.entry.id); lemmas.add(normalized);
    const spec = approvedAudioSpec(item), previous = existing.get(normalized);
    if (previous && previous.cacheKey !== spec.cacheKey) throw new Error(`Existing audio for ${item.entry.id} must be preserved; automatic replacement is disabled.`);
    return { item, spec, existing: !!previous };
  });
  const report: AudioBatchReport = { mode: options.run ? 'run' : 'dry-run', total: items.length, ready: 0, existing: 0, missing: 0, failed: 0, generated: 0, recovered: 0, requests: 0, charactersRequested: 0, plannedRequests: 0, plannedCharacters: 0, plannedUsd: 0, reservedUsd: 0, budgetUsd, elapsedSeconds: 0, concurrency };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const lockPath = path.join(output, 'batch.lock');
  try {
    if (options.run) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('An audio batch lock exists. Confirm its worker is stopped before manually removing batch.lock.'); throw error; }
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })); await lock.sync();
    }
    const ledger = await reservations(output);
    let reservedMicroUsd = [...ledger.values()].reduce((sum, record) => sum + record.reservedMicroUsd, 0);
    report.reservedUsd = reservedMicroUsd / 1e6;
    const states = [];
    for (const info of items) {
      const state = info.existing ? 'existing' : await cachedAssetReady(output, info.item, info.spec) ? 'ready' : ledger.has(info.spec.cacheKey) ? 'failed' : 'missing';
      report[state]++; states.push({ ...info, state });
    }
    const planned = states.filter(info => info.state === 'missing').slice(0, maxItems);
    report.plannedRequests = planned.length;
    report.plannedCharacters = planned.reduce((sum, info) => sum + info.spec.characters, 0);
    report.plannedUsd = report.plannedCharacters * MICRO_USD_PER_CHARACTER / 1e6;
    if (!options.run) return report;
    const update = () => { report.reservedUsd = reservedMicroUsd / 1e6; report.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10; options.onProgress?.({ ...report }); };
    // Recover already-paid captures before considering any new billable work.
    for (const info of states.filter(item => item.state === 'failed')) {
      const { item, spec } = info;
      const directory = assetDirectory(output, spec.cacheKey);
      if (!await exists(path.join(directory, 'provider-response.json'))) continue;
      try {
        const status = await readJson(path.join(directory, 'http-status.json')) as { status?: number };
        if (status.status !== 200) continue;
        await recoverCapturedAudio(output, item, spec);
        info.state = 'ready'; report.failed--; report.ready++; report.recovered++; update();
      } catch { /* Keep the immutable reservation. Never regenerate an uncertain or rejected response. */ }
    }
    // A changed input file cannot bypass a previous quota/network failure. An operator must
    // reconcile the reserved request with its provider history before continuing this ledger.
    for (const reservation of ledger.values()) {
      if (!await exists(path.join(assetDirectory(output, reservation.cacheKey), 'asset.json'))) {
        report.stopped = 'uncertain_request'; update();
        await writeJson(path.join(output, 'last-report.json'), { ...report, finishedAt: new Date().toISOString() });
        return report;
      }
    }
    const stop = (reason: NonNullable<AudioBatchReport['stopped']>) => {
      // A provider/storage failure is more actionable than reaching the planned budget.
      if (!report.stopped || report.stopped === 'budget') report.stopped = reason;
    };
    type ReservedTask = { item: ApprovedAudioEntry; spec: VocabularyAudioSpec; directory: string; key: string };
    const performRequest = async ({ item, spec, directory, key }: ReservedTask) => {
      let response: Response;
      try {
        response = await (options.fetcher ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${spec.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
          method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(spec.body), signal: AbortSignal.timeout(60000), redirect: 'error', cache: 'no-store',
        });
        await writeJson(path.join(directory, 'http-status.json'), { status: response.status, contentType: response.headers.get('content-type'), receivedAt: new Date().toISOString() });
        await captureResponse(response, directory);
      } catch {
        stop('uncertain_request');
        await writeJson(path.join(directory, 'state.json'), { state: 'uncertain', reason: 'network_or_capture_failure', updatedAt: new Date().toISOString() });
        update(); return;
      }
      if (!response.ok) {
        let quota = false;
        try { const detail = await readJson(path.join(directory, 'provider-response.json')) as { detail?: { status?: string } }; quota = /quota|credit|billing|subscription/i.test(detail.detail?.status ?? ''); } catch { /* No provider text in logs. */ }
        const reason = [401, 402].includes(response.status) || quota ? 'provider_auth_or_credit' : 'provider_error';
        stop(reason);
        await writeJson(path.join(directory, 'state.json'), { state: 'failed', reason, httpStatus: response.status, updatedAt: new Date().toISOString() });
        update(); return;
      }
      try {
        await recoverCapturedAudio(output, item, spec);
        report.failed--; report.ready++; report.generated++;
      } catch {
        stop('captured_response_invalid');
        await writeJson(path.join(directory, 'state.json'), { state: 'failed', reason: 'captured_response_invalid', updatedAt: new Date().toISOString() });
      }
      update();
    };
    const pending = states.filter(info => info.state === 'missing').slice(0, maxItems);
    for (let offset = 0; offset < pending.length && !report.stopped; offset += concurrency) {
      const wave: ReservedTask[] = [];
      // Budget allocation and durable reservations stay serial. No provider request begins
      // until the wave is fully reserved, so concurrent responses cannot overspend the ledger.
      for (const { item, spec } of pending.slice(offset, offset + concurrency)) {
        const cost = spec.characters * MICRO_USD_PER_CHARACTER;
        if (reservedMicroUsd + cost > Math.floor(budgetUsd * 1e6)) { stop('budget'); update(); break; }
        const key = options.apiKey?.trim();
        if (!key) throw new Error('ELEVENLABS_API_KEY is required for --run. No request was sent for the next item.');
        const directory = assetDirectory(output, spec.cacheKey);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, 'input.json'), { entry: item.entry, review: item.review, provenance: item.provenance, spec });
        const reservation: Reservation = { schemaVersion: 1, cacheKey: spec.cacheKey, requestId: randomUUID(), characters: spec.characters, reservedMicroUsd: cost, createdAt: new Date().toISOString() };
        await writeJson(reservationFile(output, spec.cacheKey), reservation, true);
        ledger.set(spec.cacheKey, reservation); reservedMicroUsd += cost;
        report.requests++; report.charactersRequested += spec.characters; report.missing--; report.failed++;
        wave.push({ item, spec, directory, key });
      }
      // Always await every in-flight capture before releasing the process lock. A failure
      // stops the next wave; already-started paid responses are retained, never abandoned.
      const outcomes = await Promise.allSettled(wave.map(performRequest));
      if (outcomes.some(outcome => outcome.status === 'rejected')) { stop('local_storage_error'); update(); }
    }
    await writeJson(path.join(output, 'last-report.json'), { ...report, finishedAt: new Date().toISOString() });
    return report;
  } finally {
    report.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
    if (lock) { await lock.close(); await unlink(lockPath); await syncDirectory(output); }
  }
}

export async function readApprovedAudioInputs(input: string): Promise<ApprovedAudioEntry[]> {
  const absolute = path.resolve(input), info = await stat(absolute);
  if (info.isFile()) return parseApprovedAudioBatch(await readJson(absolute));
  if (!info.isDirectory()) throw new Error('The approved input must be a JSON file or a directory.');
  const result: ApprovedAudioEntry[] = [];
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.json'))) result.push(...await readApprovedAudioInputs(path.join(absolute, entry.name)));
    if (result.length > MAX_ITEMS) throw new Error('The approved input exceeds 7500 entries.');
  }
  return result;
}
