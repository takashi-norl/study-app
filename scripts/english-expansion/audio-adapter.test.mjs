import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAudioReservations } from './audio-adapter.mjs';
import { loadBudgetSnapshot } from './loaders.mjs';
import { assessSharedBudget } from './budget.mjs';

const key = 'a'.repeat(64), originalId = 'original-audio-request', retryId = 'retry-audio-request';
const record = { schemaVersion: 1, cacheKey: key, requestId: originalId, characters: 100, reservedMicroUsd: 18200, createdAt: '2026-10-23T00:00:00.000Z' };
const sha = value => createHash('sha256').update(value).digest('hex');
const encoded = value => `${JSON.stringify(value, null, 2)}\n`;
async function put(file, value) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, encoded(value)); }
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-expansion-audio-')), audio = join(root, 'audio'), asset = join(audio, 'assets', key);
  try {
    await mkdir(asset, { recursive: true }); await mkdir(join(audio, 'retry-reservations'));
    await put(join(audio, 'reservations', `${key}.json`), record);
    return await run({ root, audio, asset });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function quota(asset) {
  await put(join(asset, 'input.json'), { spec: { cacheKey: key, characters: 100 } });
  await put(join(asset, 'http-status.json'), { status: 401, contentType: 'application/json', receivedAt: '2026-10-23T00:00:01.000Z' });
  await put(join(asset, 'state.json'), { state: 'failed', reason: 'provider_auth_or_credit', httpStatus: 401, updatedAt: '2026-10-23T00:00:01.000Z' });
  await put(join(asset, 'provider-response.json'), { detail: { status: 'quota_exceeded', message: 'Credits unavailable.' } });
}
async function ready(asset) {
  const timestamp = '2026-10-23T00:00:03.000Z';
  await put(join(asset, 'state.json'), { state: 'ready', updatedAt: timestamp });
  await put(join(asset, 'http-status.json'), { status: 200, contentType: 'application/json', receivedAt: timestamp });
  await put(join(asset, 'asset.json'), { cacheKey: key, characters: 100, mp3Sha256: sha('ID3fake-test-audio'), generatedAt: timestamp });
  await writeFile(join(asset, 'audio.mp3'), 'ID3fake-test-audio');
}
async function addRetry(audio, asset) {
  const archive = join(asset, 'attempts', originalId), evidenceSha256 = {};
  await mkdir(archive, { recursive: true });
  for (const file of ['input.json', 'http-status.json', 'provider-response.json', 'state.json', 'reservation.json']) {
    const content = await readFile(file === 'reservation.json' ? join(audio, 'reservations', `${key}.json`) : join(asset, file));
    await writeFile(join(archive, file), content); evidenceSha256[file] = sha(content);
  }
  await put(join(audio, 'retry-reservations', `${key}.json`), { ...record, kind: 'explicit-quota-retry', originalRequestId: originalId, requestId: retryId, evidenceSha256, billingDisposition: 'original-reservation-retained' });
}
test('actual per-asset ready metadata normalizes without parsing audio provider payloads', async () => fixture(async ({ audio, asset }) => {
  await ready(asset); const records = await loadAudioReservations(audio);
  assert.equal(records[0].outcome, 'ready'); assert.equal(records[0].reservedMicroUsd, 18200);
}));
test('missing outcome and partial response remain uncertain and fully reserved', async () => fixture(async ({ audio, asset }) => {
  assert.equal((await loadAudioReservations(audio))[0].outcome, 'uncertain');
  await quota(asset); await writeFile(join(asset, 'provider-response.partial'), '{');
  assert.equal((await loadAudioReservations(audio))[0].outcome, 'uncertain');
}));
test('only exact complete quota rejection is known; auth and network outcomes block', async () => fixture(async ({ audio, asset }) => {
  await quota(asset); assert.equal((await loadAudioReservations(audio))[0].outcome, 'known-quota-rejection');
  await put(join(asset, 'provider-response.json'), { detail: { status: 'invalid_api_key' } });
  assert.equal((await loadAudioReservations(audio))[0].outcome, 'uncertain');
}));
test('original quota and explicit retry retain separate reservations and require the retry start marker', async () => fixture(async ({ audio, asset }) => {
  await quota(asset); await addRetry(audio, asset);
  let records = await loadAudioReservations(audio); assert.deepEqual(records.map(r => r.outcome), ['known-quota-rejection', 'reserved-not-sent']);
  assert.equal(records.reduce((sum, r) => sum + r.reservedMicroUsd, 0), 36400);
  await put(join(asset, 'attempts', retryId, 'started.json'), { cacheKey: key, requestId: retryId, startedAt: '2026-10-23T00:00:02.000Z' });
  // The previous rejected response predates the retry; it cannot settle the new call.
  records = await loadAudioReservations(audio); assert.equal(records[1].outcome, 'uncertain');
  await ready(asset); records = await loadAudioReservations(audio); assert.deepEqual(records.map(r => r.outcome), ['known-quota-rejection', 'ready']);
}));
test('changed immutable quota evidence blocks both original and retry outcome reconciliation', async () => fixture(async ({ audio, asset }) => {
  await quota(asset); await addRetry(audio, asset);
  await put(join(asset, 'attempts', originalId, 'provider-response.json'), { detail: { status: 'quota_exceeded', message: 'changed' } });
  assert.deepEqual((await loadAudioReservations(audio)).map(r => r.outcome), ['uncertain', 'uncertain']);
}));
test('budget loader requires base accounting and explicit permission for a new empty expansion ledger', async () => fixture(async ({ root, audio, asset }) => {
  const options = { phaseOneOutput: root, expansionLedgerPath: join(root, 'expansion-ledger.json') };
  await assert.rejects(loadBudgetSnapshot(options), /ENOENT/);
  await put(join(root, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'base', status: 'complete', actualUsd: 1, reservedUsd: 2 }] });
  await assert.rejects(loadBudgetSnapshot(options), /ENOENT/);
  await ready(asset);
  const s = await loadBudgetSnapshot({ ...options, allowNewExpansion: true });
  assert.equal(s.expansion.calls.length, 0); assert.equal(assessSharedBudget(s).committedUsd, 1.0182); assert.equal(assessSharedBudget(s).canCommitExpansion, false);
  await rm(join(audio, 'reservations'), { recursive: true });
  await assert.rejects(loadBudgetSnapshot({ ...options, allowNewExpansion: true }), /ENOENT/);
}));
