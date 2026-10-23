import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInventoryRound, completeInventoryPrefix, inventoryChunkSize, savedInventoryResult } from './inventory.mjs';
import { hashVocabularyEntry } from './schema.mjs';
import { responseCost } from './provider.mjs';
import { atomicJson, readJson } from './storage.mjs';

const execute = promisify(execFile);
const fixtureWord = (word, overrides = {}) => ({ word, partOfSpeech: '名詞', meaning: '意味', cefr: 'A1', domains: ['daily-life'], ...overrides });
const baseState = () => ({ schemaVersion: 1, frozenSha256: hashVocabularyEntry([]), words: [{ id: 'apple', word: 'apple', grade: 'grade2', frozen: true, status: 'preserved' }], inventoryRounds: {} });
const rawResult = (words, truncated = false) => ({ value: { words }, truncated, completeObjects: words.length, requestHash: 'a'.repeat(64) });
const roundArgs = result => ({ grade: 'grade3', round: 0, requestId: 'inventory-grade3-0000', needed: 100, result, domainIds: ['daily-life', 'food'] });
async function temporary(action) { const output = await mkdtemp(join(tmpdir(), 'hibi-inventory-test-')); try { return await action(output); } finally { await rm(output, { recursive: true, force: true }); } }
async function savedFixture(output, text, { stop = 'max_tokens', status = 'complete' } = {}) {
  const response = { id: 'msg-test', model: 'claude-haiku-5-5', stop_reason: stop, usage: { input_tokens: 200, output_tokens: 10000 }, content: [{ type: 'text', text }] };
  const raw = { id: 'inventory-grade3-0000', requestHash: 'a'.repeat(64), response };
  const ledger = { schemaVersion: 1, calls: [{ id: raw.id, requestHash: raw.requestHash, model: response.model, status, reservedUsd: 0.01, actualUsd: responseCost(response) }] };
  await atomicJson(join(output, 'raw', `${raw.id}.json`), raw); await atomicJson(join(output, 'ledger.json'), ledger);
  return { raw, ledger };
}

test('inventory salvage retains exact fully closed objects with strings, escapes, and nested arrays', () => {
  const first = fixtureWord('pear', { meaning: '「果物」 {a}, [b], \\ "quoted"' });
  assert.deepEqual(completeInventoryPrefix(`{"words":[${JSON.stringify(first)},{"word":"cut`), [first]);
  assert.deepEqual(completeInventoryPrefix('{"words":[{"word":"cut'), []);
  assert.deepEqual(completeInventoryPrefix(`{"words":[${JSON.stringify(first)},`), [first]);
  assert.throws(() => completeInventoryPrefix('some prose {"words":[]}'), /words array/);
  assert.throws(() => completeInventoryPrefix('{"words":[{"word":"bad"]'), /Mismatched/);
  assert.throws(() => completeInventoryPrefix('{"words":[{"word":"bad"},oops'), /Unexpected/);
});

test('canonical domains, excluded lemmas, schema, IDs and requested count stay enforced on recovered data', () => {
  const state = baseState(), preserved = structuredClone(state.words[0]);
  const result = rawResult([fixtureWord('apple'), fixtureWord('bad', { domains: ['made-up-domain'] }), fixtureWord('badform', { cefr: 'unknown' }), fixtureWord('pear'), fixtureWord('pear'), fixtureWord('plum'), fixtureWord('melon')], true);
  const summary = applyInventoryRound(state, { ...roundArgs(result), needed: 2 });
  assert.deepEqual(state.words.map(item => item.word), ['apple', 'pear', 'plum']);
  assert.deepEqual(state.words[0], preserved); assert.equal(summary.added, 2);
  assert.equal(inventoryChunkSize(state, 'grade3'), 10);
  assert.equal(state.inventoryRounds.grade3, 1);
  assert.throws(() => applyInventoryRound(state, { ...roundArgs(result), needed: 2 }), /consumed|mismatched/);
});

test('truncation halves the persistent chunk with a floor; successful recovery never resets it', () => {
  const state = baseState();
  for (const [round, needed, nextSize, word] of [[0, 100, 50, 'pear'], [1, 50, 25, 'plum'], [2, 25, 12, 'melon'], [3, 12, 10, 'berry'], [4, 10, 10, 'orange']]) {
    const summary = applyInventoryRound(state, { ...roundArgs(rawResult([fixtureWord(word)], true)), round, requestId: `inventory-grade3-${String(round).padStart(4, '0')}`, needed });
    assert.equal(summary.nextChunkSize, nextSize);
  }
  applyInventoryRound(state, { ...roundArgs(rawResult([fixtureWord('grape')])), round: 5, requestId: 'inventory-grade3-0005', needed: 10 });
  assert.equal(inventoryChunkSize(state, 'grade3'), 10);
});

test('an empty usable prefix is checkpointed, and remaining grade capacity is never exceeded', () => {
  const state = baseState();
  const summary = applyInventoryRound(state, roundArgs(rawResult([fixtureWord('apple')], true)));
  assert.equal(summary.added, 0); assert.equal(state.inventoryRounds.grade3, 1); assert.equal(summary.nextChunkSize, 50);
  assert.ok(state.inventoryReceipts['inventory-grade3-0000']);
  const nearTarget = baseState();
  nearTarget.words.push(...Array.from({ length: 2099 }, (_, i) => ({ id: `preserved-${i}`, word: `preserved-${i}`, grade: 'grade3', frozen: true })));
  assert.throws(() => applyInventoryRound(nearTarget, roundArgs(rawResult([fixtureWord('pear')]))), /remaining target/);
  applyInventoryRound(nearTarget, { ...roundArgs(rawResult([fixtureWord('pear'), fixtureWord('plum')])), needed: 1 });
  assert.equal(nearTarget.words.filter(item => item.grade === 'grade3').length, 2100);
});

test('offline raw recovery preserves the paid ledger and raw bytes, with exact complete objects only', async () => temporary(async output => {
  const text = `{"words":[${JSON.stringify(fixtureWord('pear'))},{"word":"cut`;
  const { raw, ledger } = await savedFixture(output, text);
  const result = await savedInventoryResult(output, raw.id);
  assert.deepEqual(result.value.words, [fixtureWord('pear')]); assert.equal(result.truncated, true);
  assert.deepEqual(await readJson(join(output, 'ledger.json')), ledger);
  assert.deepEqual(await readJson(join(output, 'raw', `${raw.id}.json`)), raw);
  assert.deepEqual(await savedInventoryResult(output, raw.id), result);
}));

test('unresolved receipts, mismatched identities, and unverified charges cannot be salvaged', async () => temporary(async output => {
  const { raw, ledger } = await savedFixture(output, '{"words":[]}', { status: 'uncertain' });
  await assert.rejects(savedInventoryResult(output, raw.id), /unresolved|mismatched/);
  ledger.calls[0].status = 'complete'; ledger.calls[0].actualUsd = 1;
  await atomicJson(join(output, 'ledger.json'), ledger);
  await assert.rejects(savedInventoryResult(output, raw.id), /pricing/);
  ledger.calls[0].actualUsd = responseCost(raw.response); raw.id = 'inventory-pre1-0000';
  await atomicJson(join(output, 'ledger.json'), ledger);
  await atomicJson(join(output, 'raw', 'inventory-grade3-0000.json'), raw);
  await assert.rejects(savedInventoryResult(output, 'inventory-grade3-0000'), /mismatched/);
}));

test('a truncated thinking-only response is consumed as zero words without inventing output', async () => temporary(async output => {
  const { raw } = await savedFixture(output, '');
  const result = await savedInventoryResult(output, raw.id);
  assert.deepEqual(result.value.words, []); assert.equal(result.truncated, true);
}));

test('CLI offline resume advances a truncated round once without API credentials or ledger changes', async () => temporary(async output => {
  const { ledger, raw } = await savedFixture(output, `{"words":[${JSON.stringify(fixtureWord('pear'))},{"word":"cut`);
  await atomicJson(join(output, 'manifest.json'), baseState()); await atomicJson(join(output, 'frozen-100.json'), []);
  const command = join(dirname(fileURLToPath(import.meta.url)), 'build.mjs');
  const run = () => execute(process.execPath, [command, 'inventory-recover', '--out', output, '--max-calls', '2'], { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  const first = await run(); assert.match(first.stdout, /Recovered complete objects/); assert.match(first.stdout, /No saved result/);
  const saved = await readFile(join(output, 'manifest.json'), 'utf8');
  const state = JSON.parse(saved); assert.deepEqual(state.words.map(item => item.word), ['apple', 'pear']);
  assert.equal(state.inventoryRounds.grade3, 1); assert.equal(state.inventoryChunkSizes.grade3, 50);
  await run(); assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), saved);
  assert.deepEqual(await readJson(join(output, 'ledger.json')), ledger);
  assert.deepEqual(await readJson(join(output, 'raw', `${raw.id}.json`)), raw);
}));
