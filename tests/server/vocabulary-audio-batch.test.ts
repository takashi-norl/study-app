import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import { vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { approvedAudioSpec, hashAudioEntry, parseApprovedAudioBatch, runAudioBatch, type ApprovedAudioEntry } from '../../scripts/vocabulary-audio-batch-lib';

function entry(word = 'avoid'): VocabularyEntry {
  return { id: word, word, level: '2級', voice: 'female', ipa: '', ipaLabel: '', partOfSpeech: 'verb',
    definition: 'To keep away from something.', meaning: '避ける', usageTip: '',
    examples: ['We avoid busy roads.', 'Please avoid making noise.', 'This plan helps avoid delays.'].map((text, index) => ({ id: `example-${index + 1}`, text, context: '', translation: '' })),
    recall: { prompt: '', answers: ['avoid'], explanation: '' }, production: { prompt: '', modelAnswer: '', checkpoints: [] }, questions: [] };
}
function approved(word = 'avoid'): ApprovedAudioEntry {
  const value = entry(word);
  return { entry: value, review: { status: 'approved', contentSha256: hashAudioEntry(value) } };
}
function providerPayload(item: ApprovedAudioEntry, wrongAlignment = false) {
  const spec = approvedAudioSpec(item), text = wrongAlignment ? spec.body.text.replace('avoid', 'allow') : spec.body.text;
  return { audio_base64: Buffer.from([73, 68, 51, 4, 0, 0, 0]).toString('base64'), alignment: {
    characters: Array.from(text), character_start_times_seconds: Array.from(text, (_, index) => index * 0.1),
    character_end_times_seconds: Array.from(text, (_, index) => (index + 1) * 0.1),
  } };
}
const response = (item: ApprovedAudioEntry, wrongAlignment = false) => new Response(JSON.stringify(providerPayload(item, wrongAlignment)), { headers: { 'Content-Type': 'application/json' } });
async function temporary<T>(work: (output: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hibi-audio-batch-'));
  try { return await work(path.join(directory, 'private-assets')); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('approval binds the entire entry, accepts new grades, and retains the exact production cache identity', () => {
  const item = approved();
  assert.deepEqual(approvedAudioSpec(item), vocabularyAudioSpec(entry()));
  assert.deepEqual(parseApprovedAudioBatch({ schemaVersion: 1, entries: [item] }), [item]);
  const lower = approved('book'); lower.entry.level = '3級'; lower.review.contentSha256 = hashAudioEntry(lower.entry);
  assert.equal(parseApprovedAudioBatch({ schemaVersion: 1, entries: [lower] })[0].entry.level, '3級');
  const changed = structuredClone(item); changed.entry.examples[0].text = 'Do something else.';
  assert.throws(() => parseApprovedAudioBatch({ schemaVersion: 1, entries: [changed] }), /Approval hash/);
  assert.throws(() => approvedAudioSpec(changed), /approval/);
  const reordered = Object.fromEntries(Object.entries(item.entry).reverse());
  assert.equal(hashAudioEntry(reordered), item.review.contentSha256);
});

test('dry-run is offline, does not create output, and reports saved cloud audio separately', () => temporary(async output => {
  let calls = 0;
  const report = await runAudioBatch({ output, entries: [approved(), approved('learn')], existingEntries: [entry()], maxItems: 7500, fetcher: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(calls, 0); assert.equal(report.existing, 1); assert.equal(report.missing, 1); assert.equal(report.plannedRequests, 1);
  assert.equal(report.plannedUsd, approvedAudioSpec(approved('learn')).characters * 0.000182);
  await assert.rejects(stat(output), { code: 'ENOENT' });
}));

test('successful audio is reserved durably before POST, captured, validated, and reused without another charge', () => temporary(async output => {
  const item = approved(), spec = approvedAudioSpec(item);
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const reservation = JSON.parse(await readFile(path.join(output, 'reservations', `${spec.cacheKey}.json`), 'utf8'));
    assert.equal(reservation.characters, spec.characters);
    assert.equal(reservation.reservedMicroUsd, spec.characters * 182);
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'PRIVATE_TEST_KEY');
    assert.equal(String(url), `https://api.elevenlabs.io/v1/text-to-speech/${spec.voiceId}/with-timestamps?output_format=mp3_44100_128`);
    assert.deepEqual(JSON.parse(String(init?.body)), spec.body);
    assert.equal(init?.redirect, 'error');
    return response(item);
  };
  const first = await runAudioBatch({ output, entries: [item], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(first.generated, 1); assert.equal(first.ready, 1); assert.equal(first.failed, 0); assert.equal(calls, 1);
  const directory = path.join(output, 'assets', spec.cacheKey);
  const asset = JSON.parse(await readFile(path.join(directory, 'asset.json'), 'utf8'));
  assert.equal(asset.segments.length, 4); assert.equal(asset.cacheKey, spec.cacheKey);
  assert.equal((await stat(path.join(directory, 'audio.mp3'))).mode & 0o777, 0o600);
  assert.ok((await readFile(path.join(directory, 'provider-response.json'), 'utf8')).includes('audio_base64'));
  const second = await runAudioBatch({ output, entries: [item], run: true, fetcher });
  assert.equal(second.ready, 1); assert.equal(second.requests, 0); assert.equal(calls, 1);
}));

test('network uncertainty stops the entire ledger, including a later run with different input', () => temporary(async output => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('PRIVATE_PROVIDER_ERROR PRIVATE_TEST_KEY'); };
  const failed = await runAudioBatch({ output, entries: [approved(), approved('learn')], run: true, maxItems: 2, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(failed.stopped, 'uncertain_request'); assert.equal(failed.requests, 1); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/);
  const resumed = await runAudioBatch({ output, entries: [approved('learn')], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(resumed.stopped, 'uncertain_request'); assert.equal(resumed.requests, 0); assert.equal(calls, 1);
  assert.ok(resumed.reservedUsd > 0);
}));

test('credit/auth errors stop at one call and preserve raw failure without automatically retrying', () => temporary(async output => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'PRIVATE_PROVIDER_DETAIL' } }), { status: 402 }); };
  const result = await runAudioBatch({ output, entries: [approved(), approved('learn')], run: true, maxItems: 2, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(result.stopped, 'provider_auth_or_credit'); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const replay = await runAudioBatch({ output, entries: [approved(), approved('learn')], run: true, maxItems: 2, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(replay.requests, 0); assert.equal(calls, 1);
}));

test('alignment failures preserve paid MP3 and raw response; local repair recovers without another API call', () => temporary(async output => {
  const item = approved(), spec = approvedAudioSpec(item);
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response(item, true); };
  const result = await runAudioBatch({ output, entries: [item, approved('learn')], run: true, maxItems: 2, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(result.stopped, 'captured_response_invalid'); assert.equal(calls, 1);
  const directory = path.join(output, 'assets', spec.cacheKey);
  assert.ok((await readFile(path.join(directory, 'audio.mp3'))).length > 0);
  // Simulate an offline alignment reconciliation; no new synthesis is allowed for this key.
  await writeFile(path.join(directory, 'provider-response.json'), JSON.stringify(providerPayload(item)));
  const recovered = await runAudioBatch({ output, entries: [item], run: true, fetcher });
  assert.equal(recovered.recovered, 1); assert.equal(recovered.ready, 1); assert.equal(recovered.requests, 0); assert.equal(calls, 1);
}));

test('budget and request limits stop before sending or reserving unaffordable work', () => temporary(async output => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response(approved()); };
  const limited = await runAudioBatch({ output, entries: [approved(), approved('learn')], run: true, maxItems: 2, budgetUsd: 0.00001, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(limited.stopped, 'budget'); assert.equal(calls, 0); assert.equal(limited.reservedUsd, 0);
  await assert.rejects(() => runAudioBatch({ output, entries: [approved()], budgetUsd: 401 }), /no more than USD 400/);
  const firstOnly = await runAudioBatch({ output, entries: [approved(), approved('learn')], run: true, maxItems: 1, apiKey: 'PRIVATE_TEST_KEY', fetcher });
  assert.equal(firstOnly.requests, 1); assert.equal(firstOnly.missing, 1); assert.equal(calls, 1);
}));

test('missing secret, duplicate lemmas, or changed existing audio never produce a paid reservation', () => temporary(async output => {
  await assert.rejects(() => runAudioBatch({ output, entries: [approved()], run: true }), /API_KEY/);
  const files = await readdir(output);
  assert.equal(files.includes('reservations'), false);
  await assert.rejects(() => runAudioBatch({ output, entries: [approved(), approved()] }), /duplicate/);
  const changed = approved(); changed.entry.examples[0].text = 'A replacement must not be generated.'; changed.review.contentSha256 = hashAudioEntry(changed.entry);
  await assert.rejects(() => runAudioBatch({ output, entries: [changed], existingEntries: [entry()] }), /must be preserved/);
}));

test('an exclusive worker lock prevents overlapping paid batch workers', () => temporary(async output => {
  let started!: () => void, finish!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const running = runAudioBatch({ output, entries: [approved()], run: true, apiKey: 'PRIVATE_TEST_KEY', fetcher: async () => { started(); await release; return response(approved()); } });
  await pending;
  try { await assert.rejects(() => runAudioBatch({ output, entries: [approved('learn')], run: true, apiKey: 'PRIVATE_TEST_KEY' }), /lock exists/); }
  finally { finish(); await running; }
}));

test('bounded concurrency never exceeds its worker limit or max-items and reserves each key once', async () => {
  for (const concurrency of [1, 2, 3]) await temporary(async output => {
    const entries = Array.from({ length: 7 }, (_, index) => approved(`word${index}`));
    const byScript = new Map(entries.map(item => [approvedAudioSpec(item).body.text, item]));
    let calls = 0, active = 0, maximum = 0;
    const seen = new Set<string>();
    const fetcher: typeof fetch = async (_url, init) => {
      calls++; active++; maximum = Math.max(maximum, active);
      const text = JSON.parse(String(init?.body)).text;
      assert.equal(seen.has(text), false); seen.add(text);
      const item = byScript.get(text)!;
      const record = JSON.parse(await readFile(path.join(output, 'reservations', `${approvedAudioSpec(item).cacheKey}.json`), 'utf8'));
      assert.equal(record.characters, approvedAudioSpec(item).characters);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--; return response(item);
    };
    const result = await runAudioBatch({ output, entries, run: true, apiKey: 'PRIVATE_TEST_KEY', maxItems: 5, concurrency, fetcher });
    assert.equal(result.concurrency, concurrency); assert.equal(maximum, concurrency);
    assert.equal(calls, 5); assert.equal(result.requests, 5); assert.equal(result.generated, 5); assert.equal(result.missing, 2);
    assert.equal((await readdir(path.join(output, 'reservations'))).length, 5);
  });
});

test('a parallel provider failure stops new waves but retains successful in-flight responses before unlocking', () => temporary(async output => {
  const entries = Array.from({ length: 6 }, (_, index) => approved(`word${index}`));
  let calls = 0, finished = false;
  let release!: () => void, reportFailure!: () => void;
  const inFlight = new Promise<void>(resolve => { release = resolve; });
  const failureSeen = new Promise<void>(resolve => { reportFailure = resolve; });
  const byScript = new Map(entries.map(item => [approvedAudioSpec(item).body.text, item]));
  const fetcher: typeof fetch = async (_url, init) => {
    const position = calls++;
    if (position === 0) return new Response(JSON.stringify({ detail: { status: 'quota_exceeded' } }), { status: 402 });
    const item = byScript.get(JSON.parse(String(init?.body)).text)!;
    await inFlight;
    return response(item);
  };
  const running = runAudioBatch({ output, entries, run: true, apiKey: 'PRIVATE_TEST_KEY', maxItems: 6, concurrency: 3, fetcher,
    onProgress: report => { if (report.stopped === 'provider_auth_or_credit') reportFailure(); },
  }).then(value => { finished = true; return value; });
  await failureSeen;
  try {
    assert.equal(calls, 3); assert.equal(finished, false);
    assert.ok((await stat(path.join(output, 'batch.lock'))).isFile());
  } finally { release(); }
  const result = await running;
  assert.equal(result.stopped, 'provider_auth_or_credit'); assert.equal(result.requests, 3);
  assert.equal(result.ready, 2); assert.equal(result.failed, 1); assert.equal(result.missing, 3); assert.equal(calls, 3);
  for (const item of entries.slice(1, 3)) assert.ok((await stat(path.join(output, 'assets', approvedAudioSpec(item).cacheKey, 'audio.mp3'))).size > 0);
  await assert.rejects(stat(path.join(output, 'batch.lock')), { code: 'ENOENT' });
  const retry = await runAudioBatch({ output, entries: entries.slice(3), run: true, apiKey: 'PRIVATE_TEST_KEY', concurrency: 3, fetcher });
  assert.equal(retry.stopped, 'uncertain_request'); assert.equal(retry.requests, 0); assert.equal(calls, 3);
}));

test('concurrent reservations share one hard budget even when only part of a wave is affordable', () => temporary(async output => {
  const entries = Array.from({ length: 6 }, (_, index) => approved(`word${index}`));
  const oneCost = approvedAudioSpec(entries[0]).characters * 182;
  const budgetUsd = (oneCost * 2 + 1) / 1e6;
  const byScript = new Map(entries.map(item => [approvedAudioSpec(item).body.text, item]));
  let calls = 0;
  const result = await runAudioBatch({ output, entries, run: true, apiKey: 'PRIVATE_TEST_KEY', maxItems: 6, concurrency: 3, budgetUsd,
    fetcher: async (_url, init) => { calls++; return response(byScript.get(JSON.parse(String(init?.body)).text)!); },
  });
  assert.equal(result.stopped, 'budget'); assert.equal(calls, 2); assert.equal(result.ready, 2); assert.equal(result.missing, 4);
  assert.equal(result.reservedUsd, oneCost * 2 / 1e6); assert.ok(result.reservedUsd <= budgetUsd);
  assert.equal((await readdir(path.join(output, 'reservations'))).length, 2);
  for (const concurrency of [0, 4, -1, 1.5]) await assert.rejects(() => runAudioBatch({ output, entries, concurrency }), /from 1 to 3/);
}));
