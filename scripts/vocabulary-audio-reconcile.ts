import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

// A rejection is not a billing receipt. The original reservation remains fully counted.
// One separately reserved retry is possible only after explicit operator reconciliation.
const HEX = /^[a-f0-9]{64}$/;
const MAX_BUDGET_USD = 400;
const MICRO_USD_PER_CHARACTER = 182;
const FILES = ['input.json', 'http-status.json', 'provider-response.json', 'state.json', 'reservation.json'] as const;
type EvidenceFile = typeof FILES[number];
const reservationSchema = z.object({
  schemaVersion: z.literal(1), cacheKey: z.string().regex(HEX), requestId: z.string().uuid(),
  characters: z.number().int().positive(), reservedMicroUsd: z.number().int().positive(), createdAt: z.string().datetime(),
}).strict();
const retrySchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('explicit-quota-retry'),
  cacheKey: z.string().regex(HEX), originalRequestId: z.string().uuid(), requestId: z.string().uuid(),
  characters: z.number().int().positive(), reservedMicroUsd: z.number().int().positive(), createdAt: z.string().datetime(),
  evidenceSha256: z.object({
    'input.json': z.string().regex(HEX), 'http-status.json': z.string().regex(HEX),
    'provider-response.json': z.string().regex(HEX), 'state.json': z.string().regex(HEX),
    'reservation.json': z.string().regex(HEX),
  }).strict(),
  billingDisposition: z.literal('original-reservation-retained'),
}).strict();
export type AudioQuotaRetryReservation = z.infer<typeof retrySchema>;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: Uint8Array): unknown => JSON.parse(Buffer.from(value).toString('utf8'));
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const directory = (output: string, cacheKey: string) => path.join(output, 'assets', cacheKey);
const retryFile = (output: string, cacheKey: string) => path.join(output, 'retry-reservations', `${cacheKey}.json`);
const archive = (output: string, retry: Pick<AudioQuotaRetryReservation, 'cacheKey' | 'originalRequestId'>) => path.join(directory(output, retry.cacheKey), 'attempts', retry.originalRequestId);
const startedFile = (output: string, retry: AudioQuotaRetryReservation) => path.join(directory(output, retry.cacheKey), 'attempts', retry.requestId, 'started.json');

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function readEvidence(file: string): Promise<Buffer> {
  const info = await lstat(file);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 256000, 'Reconciliation evidence is missing or not a bounded regular file.');
  return readFile(file);
}
async function syncDirectory(target: string) {
  const handle = await open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeImmutable(file: string, bytes: Uint8Array, allowIdentical = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    try { await link(temp, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !allowIdentical || !(await readEvidence(file)).equals(Buffer.from(bytes))) throw error;
    }
    await syncDirectory(path.dirname(file));
  } finally { await unlink(temp); }
}
const encoded = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function validateQuotaEvidence(evidence: Record<EvidenceFile, Buffer>, key: string) {
  const reservation = reservationSchema.parse(json(evidence['reservation.json']));
  const http = z.object({ status: z.union([z.literal(401), z.literal(402)]), contentType: z.string(), receivedAt: z.string().datetime() }).parse(json(evidence['http-status.json']));
  requireThat(http.contentType.toLowerCase().includes('application/json'), 'Expected a complete JSON quota rejection.');
  const failure = z.object({ state: z.literal('failed'), reason: z.literal('provider_auth_or_credit'), httpStatus: z.number(), updatedAt: z.string().datetime() }).parse(json(evidence['state.json']));
  requireThat(failure.httpStatus === http.status, 'Quota evidence statuses do not match.');
  const response = z.object({ detail: z.object({ status: z.literal('quota_exceeded') }).passthrough() }).strict().parse(json(evidence['provider-response.json']));
  // Do not infer safety from a broad auth/credit regex or the message text.
  requireThat(!['audio_base64', 'audio', 'alignment', 'normalized_alignment'].some(field => field in response.detail), 'A response with audio evidence cannot be reconciled as a quota rejection.');
  const input = z.object({ spec: z.object({ cacheKey: z.string().regex(HEX), characters: z.number().int().positive() }) }).passthrough().parse(json(evidence['input.json']));
  requireThat(reservation.cacheKey === key && input.spec.cacheKey === key && input.spec.characters === reservation.characters, 'Quota evidence does not match the reservation.');
  requireThat(reservation.reservedMicroUsd >= reservation.characters * MICRO_USD_PER_CHARACTER, 'The original reservation is underfunded.');
  return { reservation, httpStatus: http.status };
}

async function liveEvidence(output: string, cacheKey: string): Promise<Record<EvidenceFile, Buffer>> {
  const target = directory(output, cacheKey);
  for (const name of ['asset.json', 'audio.mp3', 'provider-response.partial']) requireThat(!await exists(path.join(target, name)), 'Existing audio or an incomplete response forbids quota reconciliation.');
  const evidence = {} as Record<EvidenceFile, Buffer>;
  for (const name of FILES) evidence[name] = await readEvidence(name === 'reservation.json' ? path.join(output, 'reservations', `${cacheKey}.json`) : path.join(target, name));
  validateQuotaEvidence(evidence, cacheKey);
  return evidence;
}

/** Loads retry spending even after success; verifies the archived rejection and original reservation. */
export async function loadAudioQuotaRetryReservations(output: string): Promise<Map<string, AudioQuotaRetryReservation>> {
  const target = path.join(output, 'retry-reservations'), records = new Map<string, AudioQuotaRetryReservation>();
  if (!await exists(target)) return records;
  for (const name of (await readdir(target)).sort()) {
    if (!name.endsWith('.json')) continue;
    const retry = retrySchema.parse(json(await readEvidence(path.join(target, name))));
    requireThat(name === `${retry.cacheKey}.json` && retry.originalRequestId !== retry.requestId, 'Invalid retry reservation identity.');
    const evidence = {} as Record<EvidenceFile, Buffer>;
    for (const file of FILES) {
      evidence[file] = await readEvidence(path.join(archive(output, retry), file));
      requireThat(hash(evidence[file]) === retry.evidenceSha256[file], 'Archived quota evidence has changed.');
    }
    const { reservation } = validateQuotaEvidence(evidence, retry.cacheKey);
    requireThat(reservation.requestId === retry.originalRequestId && reservation.characters === retry.characters && reservation.reservedMicroUsd === retry.reservedMicroUsd, 'Retry is not bound to the original reservation.');
    requireThat(hash(await readEvidence(path.join(output, 'reservations', `${retry.cacheKey}.json`))) === retry.evidenceSha256['reservation.json'], 'The immutable original reservation has changed.');
    records.set(retry.cacheKey, retry);
  }
  return records;
}

/** Only an unused explicit reservation whose live rejected response still matches may run once. */
export async function audioQuotaRetryPending(output: string, retry: AudioQuotaRetryReservation): Promise<boolean> {
  if (await exists(startedFile(output, retry))) return false;
  const evidence = await liveEvidence(output, retry.cacheKey);
  for (const name of FILES) requireThat(hash(evidence[name]) === retry.evidenceSha256[name], 'Live quota evidence has changed since reconciliation.');
  return true;
}

/** Must be called under the normal batch lock, before any request. A crash consumes the retry. */
export async function beginAudioQuotaRetry(output: string, retry: AudioQuotaRetryReservation): Promise<void> {
  requireThat(await audioQuotaRetryPending(output, retry), 'This quota retry has already started; automatic repetition is forbidden.');
  await writeImmutable(startedFile(output, retry), encoded({ schemaVersion: 1, cacheKey: retry.cacheKey, requestId: retry.requestId, originalRequestId: retry.originalRequestId, startedAt: new Date().toISOString() }));
}

type ReconcileOptions = { output: string; cacheKey: string; originalRequestId: string; apply?: boolean; budgetUsd?: number };
export async function reconcileAudioQuota(options: ReconcileOptions) {
  requireThat(HEX.test(options.cacheKey) && z.string().uuid().safeParse(options.originalRequestId).success, 'A valid cache key and exact original request ID are required.');
  const output = path.resolve(options.output), budget = options.budgetUsd ?? MAX_BUDGET_USD;
  requireThat(Number.isFinite(budget) && budget > 0 && budget <= MAX_BUDGET_USD, 'Budget must be positive and at most USD 400.');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const lockPath = path.join(output, 'batch.lock');
  try {
    if (options.apply) {
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), purpose: 'explicit-quota-reconciliation', createdAt: new Date().toISOString() }));
      await lock.sync();
    }
    const retries = await loadAudioQuotaRetryReservations(output);
    const existing = retries.get(options.cacheKey);
    if (existing) {
      requireThat(existing.originalRequestId === options.originalRequestId, 'Retry belongs to a different original request.');
      return { status: 'already-reserved', cacheKey: existing.cacheKey, retryRequestId: existing.requestId, reservedRetryUsd: existing.reservedMicroUsd / 1e6, retryStarted: await exists(startedFile(output, existing)), billingDisposition: existing.billingDisposition };
    }
    const evidence = await liveEvidence(output, options.cacheKey), { reservation, httpStatus } = validateQuotaEvidence(evidence, options.cacheKey);
    requireThat(reservation.requestId === options.originalRequestId, 'Exact original request ID does not match.');
    let originalMicroUsd = 0;
    for (const name of (await readdir(path.join(output, 'reservations'))).filter(name => name.endsWith('.json'))) {
      const record = reservationSchema.parse(json(await readEvidence(path.join(output, 'reservations', name))));
      requireThat(name === `${record.cacheKey}.json` && record.reservedMicroUsd >= record.characters * MICRO_USD_PER_CHARACTER, 'Invalid original spending ledger.');
      originalMicroUsd += record.reservedMicroUsd;
    }
    const total = originalMicroUsd + [...retries.values()].reduce((sum, record) => sum + record.reservedMicroUsd, 0) + reservation.reservedMicroUsd;
    requireThat(total <= Math.floor(budget * 1e6), 'Adding the retry reservation would exceed the audio budget.');
    const retry = retrySchema.parse({
      schemaVersion: 1, kind: 'explicit-quota-retry', cacheKey: reservation.cacheKey, originalRequestId: reservation.requestId, requestId: randomUUID(),
      characters: reservation.characters, reservedMicroUsd: reservation.reservedMicroUsd, createdAt: new Date().toISOString(),
      evidenceSha256: Object.fromEntries(FILES.map(name => [name, hash(evidence[name])])), billingDisposition: 'original-reservation-retained',
    });
    if (options.apply) {
      for (const name of FILES) await writeImmutable(path.join(archive(output, retry), name), evidence[name], true);
      await writeImmutable(retryFile(output, retry.cacheKey), encoded(retry));
    }
    return { status: options.apply ? 'retry-reserved' : 'eligible-not-applied', cacheKey: retry.cacheKey, originalRequestId: retry.originalRequestId,
      ...(options.apply ? { retryRequestId: retry.requestId } : {}), httpStatus, providerStatus: 'quota_exceeded', capturedAudio: false,
      originalReservationUsd: reservation.reservedMicroUsd / 1e6, reservedRetryUsd: retry.reservedMicroUsd / 1e6,
      totalReservedUsdAfterRetry: total / 1e6, billingDisposition: retry.billingDisposition };
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); await syncDirectory(output); }
  }
}

async function main() {
  const args = process.argv.slice(2), value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const allowed = new Set(['--output', '--cache-key', '--request-id', '--budget-usd', '--apply']);
  try {
    for (let index = 0; index < args.length; index++) { requireThat(allowed.has(args[index]), 'Unknown option.'); if (args[index] !== '--apply') index++; }
    const output = value('--output'), cacheKey = value('--cache-key'), originalRequestId = value('--request-id');
    requireThat(output && cacheKey && originalRequestId, 'Usage: --output DIR --cache-key KEY --request-id ORIGINAL_ID [--budget-usd 400] [--apply]');
    console.log(JSON.stringify(await reconcileAudioQuota({ output, cacheKey, originalRequestId, budgetUsd: Number(value('--budget-usd') ?? MAX_BUDGET_USD), apply: args.includes('--apply') }), null, 2));
  } catch { console.error('Quota reconciliation refused. No provider request was sent. Check the exact request identity, complete quota evidence, existing lock, prior retry, and budget.'); process.exitCode = 1; }
}
if (['vocabulary-audio-reconcile.ts', 'vocabulary-audio-reconcile.js'].includes(path.basename(process.argv[1] ?? ''))) void main();
