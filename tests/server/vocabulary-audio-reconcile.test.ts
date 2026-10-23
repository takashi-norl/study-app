import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { approvedAudioSpec, hashAudioEntry, runAudioBatch, type ApprovedAudioEntry } from '../../scripts/vocabulary-audio-batch-lib';
import { audioQuotaRetryPending, loadAudioQuotaRetryReservations, reconcileAudioQuota } from '../../scripts/vocabulary-audio-reconcile';

function approved(word = 'avoid'): ApprovedAudioEntry {
  const entry = { id: word, word, level: '2級' as const, voice: 'female' as const,
    examples: ['We avoid busy roads.', 'Please avoid making noise.', 'This plan helps avoid delays.'].map(text => ({ text })) };
  return { entry, review: { status: 'approved', contentSha256: hashAudioEntry(entry) } };
}
const quota = () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'Insufficient remaining credits.' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const good = (item: ApprovedAudioEntry) => {
  const text = approvedAudioSpec(item).body.text;
  return new Response(JSON.stringify({ audio_base64: Buffer.from([73, 68, 51, 4, 0, 0, 0]).toString('base64'), alignment: {
    characters: Array.from(text), character_start_times_seconds: Array.from(text, (_, i) => i * 0.1),
    character_end_times_seconds: Array.from(text, (_, i) => (i + 1) * 0.1),
  } }), { headers: { 'Content-Type': 'application/json' } });
};
async function temporary(work: (output: string) => Promise<void>) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'hibi-quota-reconcile-'));
  try { await work(output); } finally { await rm(output, { recursive: true, force: true }); }
}
async function rejected(output: string, fetcher: typeof fetch = async () => quota()) {
  const item = approved(), spec = approvedAudioSpec(item);
  await runAudioBatch({ output, entries: [item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  const reservationBytes = await readFile(path.join(output, 'reservations', `${spec.cacheKey}.json`));
  const reservation = JSON.parse(reservationBytes.toString('utf8'));
  return { item, spec, reservation, reservationBytes, options: { output, cacheKey: spec.cacheKey, originalRequestId: reservation.requestId } };
}

test('dry-run confirms a complete exact quota rejection without modifying any ledger', () => temporary(async output => {
  const fixture = await rejected(output), result = await reconcileAudioQuota(fixture.options);
  assert.equal(result.status, 'eligible-not-applied');
  assert.equal(result.billingDisposition, 'original-reservation-retained');
  assert.ok('totalReservedUsdAfterRetry' in result);
  assert.equal(result.totalReservedUsdAfterRetry, fixture.reservation.reservedMicroUsd * 2 / 1e6);
  assert.deepEqual(await readFile(path.join(output, 'reservations', `${fixture.spec.cacheKey}.json`)), fixture.reservationBytes);
  await assert.rejects(stat(path.join(output, 'retry-reservations')), { code: 'ENOENT' });
}));

test('explicit reconciliation archives immutable evidence and reserves one additional attempt, idempotently', () => temporary(async output => {
  const fixture = await rejected(output), assetDir = path.join(output, 'assets', fixture.spec.cacheKey);
  const originalResponse = await readFile(path.join(assetDir, 'provider-response.json'));
  const first = await reconcileAudioQuota({ ...fixture.options, apply: true });
  const second = await reconcileAudioQuota({ ...fixture.options, apply: true });
  assert.equal(first.status, 'retry-reserved'); assert.equal(second.status, 'already-reserved');
  assert.equal(first.retryRequestId, second.retryRequestId);
  const records = await loadAudioQuotaRetryReservations(output), retry = records.get(fixture.spec.cacheKey)!;
  assert.equal(records.size, 1); assert.equal(retry.reservedMicroUsd, fixture.reservation.reservedMicroUsd);
  assert.equal(await audioQuotaRetryPending(output, retry), true);
  assert.deepEqual(await readFile(path.join(assetDir, 'attempts', fixture.reservation.requestId, 'provider-response.json')), originalResponse);
  assert.deepEqual(await readFile(path.join(output, 'reservations', `${fixture.spec.cacheKey}.json`)), fixture.reservationBytes);
  assert.deepEqual(await readFile(path.join(assetDir, 'provider-response.json')), originalResponse);
}));

test('one retry is already reserved before POST, preserves original spend and successful cache reuse', () => temporary(async output => {
  const fixture = await rejected(output);
  await reconcileAudioQuota({ ...fixture.options, apply: true });
  const retry = (await loadAudioQuotaRetryReservations(output)).get(fixture.spec.cacheKey)!;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    assert.equal(await audioQuotaRetryPending(output, retry), false);
    assert.deepEqual(await readFile(path.join(output, 'reservations', `${fixture.spec.cacheKey}.json`)), fixture.reservationBytes);
    return good(fixture.item);
  };
  const first = await runAudioBatch({ output, entries: [fixture.item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(calls, 1); assert.equal(first.generated, 1); assert.equal(first.ready, 1); assert.equal(first.failed, 0);
  assert.equal(first.reservedUsd, fixture.reservation.reservedMicroUsd * 2 / 1e6);
  const cachePath = path.join(output, 'assets', fixture.spec.cacheKey, 'asset.json'), originalCache = await readFile(cachePath);
  const second = await runAudioBatch({ output, entries: [fixture.item], run: true, fetcher });
  assert.equal(calls, 1); assert.equal(second.requests, 0); assert.equal(second.ready, 1);
  assert.equal(second.reservedUsd, first.reservedUsd); assert.deepEqual(await readFile(cachePath), originalCache);
  const inspect = await reconcileAudioQuota({ ...fixture.options, apply: true });
  assert.equal(inspect.status, 'already-reserved'); assert.equal(inspect.retryStarted, true);
}));

test('auth errors, other failures and unknown network outcomes are not quota-retry eligible', async () => {
  for (const fetcher of [
    async () => new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); },
  ] satisfies (typeof fetch)[]) await temporary(async output => {
    const fixture = await rejected(output, fetcher);
    await assert.rejects(reconcileAudioQuota({ ...fixture.options, apply: true }));
    await assert.rejects(stat(path.join(output, 'retry-reservations')), { code: 'ENOENT' });
    let calls = 0;
    const resumed = await runAudioBatch({ output, entries: [fixture.item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher: async () => { calls++; return good(fixture.item); } });
    assert.equal(calls, 0); assert.equal(resumed.stopped, 'uncertain_request');
  });
});

test('partial or audio-bearing failures refuse reconciliation even if quota_exceeded is present', async () => {
  for (const artifact of ['partial', 'mp3', 'payload']) await temporary(async output => {
    const fixture = await rejected(output), target = path.join(output, 'assets', fixture.spec.cacheKey);
    if (artifact === 'partial') await writeFile(path.join(target, 'provider-response.partial'), '{}');
    else if (artifact === 'mp3') await writeFile(path.join(target, 'audio.mp3'), 'captured audio');
    else await writeFile(path.join(target, 'provider-response.json'), JSON.stringify({ detail: { status: 'quota_exceeded' }, audio_base64: 'SURz' }));
    await assert.rejects(reconcileAudioQuota({ ...fixture.options, apply: true }));
    await assert.rejects(stat(path.join(output, 'retry-reservations')), { code: 'ENOENT' });
  });
});

test('a retry whose result is unknown or rejected again can never automatically repeat', async () => {
  for (const fetcher of [async () => { throw new Error('unknown outcome'); }, async () => quota()] satisfies (typeof fetch)[]) await temporary(async output => {
    const fixture = await rejected(output);
    await reconcileAudioQuota({ ...fixture.options, apply: true });
    const first = await runAudioBatch({ output, entries: [fixture.item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher });
    assert.equal(first.requests, 1);
    let calls = 0;
    const second = await runAudioBatch({ output, entries: [approved('learn')], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher: async () => { calls++; return good(approved('learn')); } });
    assert.equal(calls, 0); assert.equal(second.requests, 0); assert.equal(second.stopped, 'uncertain_request');
    const repeated = await reconcileAudioQuota({ ...fixture.options, apply: true });
    assert.equal(repeated.status, 'already-reserved'); assert.equal(repeated.retryStarted, true);
  });
});

test('retry allocation and execution respect the combined original-plus-retry budget', () => temporary(async output => {
  const fixture = await rejected(output), originalUsd = fixture.reservation.reservedMicroUsd / 1e6;
  await assert.rejects(reconcileAudioQuota({ ...fixture.options, apply: true, budgetUsd: originalUsd }), /budget/);
  await reconcileAudioQuota({ ...fixture.options, apply: true });
  let calls = 0;
  const result = await runAudioBatch({ output, entries: [fixture.item], run: true, budgetUsd: originalUsd, apiKey: 'PRIVATE_TEST_KEY', fetcher: async () => { calls++; return good(fixture.item); } });
  assert.equal(calls, 0); assert.equal(result.stopped, 'budget'); assert.equal(result.reservedUsd, originalUsd * 2);
  assert.equal(await audioQuotaRetryPending(output, (await loadAudioQuotaRetryReservations(output)).get(fixture.spec.cacheKey)!), true);
}));

test('changed evidence or a mismatched original request never releases a failed request', () => temporary(async output => {
  const fixture = await rejected(output);
  await assert.rejects(reconcileAudioQuota({ ...fixture.options, originalRequestId: '00000000-0000-4000-8000-000000000001', apply: true }), /does not match/);
  await reconcileAudioQuota({ ...fixture.options, apply: true });
  await writeFile(path.join(output, 'assets', fixture.spec.cacheKey, 'provider-response.json'), JSON.stringify({ detail: { status: 'quota_exceeded', message: 'Changed evidence.' } }));
  let calls = 0;
  await assert.rejects(runAudioBatch({ output, entries: [fixture.item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher: async () => { calls++; return good(fixture.item); } }), /evidence has changed/);
  assert.equal(calls, 0);
}));

test('an active worker lock prevents operator reconciliation from racing a batch', () => temporary(async output => {
  const fixture = await rejected(output);
  await writeFile(path.join(output, 'batch.lock'), 'active worker');
  await assert.rejects(reconcileAudioQuota({ ...fixture.options, apply: true }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(output, 'batch.lock'), 'utf8'), 'active worker');
  await assert.rejects(stat(path.join(output, 'retry-reservations')), { code: 'ENOENT' });
}));
