import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, readJson } from './storage.mjs';
import { hashVocabularyEntry } from './schema.mjs';

test('adding inventory cannot regroup or duplicate a prepared partial generation batch', async () => {
  const output = await mkdtemp(join(tmpdir(), 'hibi-frozen-group-'));
  const seed = word => ({ id: `vocab-${word}`, word, partOfSpeech: '名詞', meaning: word, grade: 'grade3', cefr: 'A1', domains: ['daily-life'], frozen: false, status: 'inventoried' });
  try {
    const words = ['apple', 'book', 'car', 'desk', 'egg', 'fish'].map(seed);
    const state = { schemaVersion: 1, frozenSha256: hashVocabularyEntry([]), words, inventoryRounds: {}, batches: {} };
    await atomicJson(join(output, 'frozen-100.json'), []);
    await atomicJson(join(output, 'manifest.json'), state);
    const run = () => promisify(execFile)(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'build.mjs'), 'batch-prepare', '--out', output, '--model', 'claude-sonnet-5-5', '--max-batches', '10'], { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    await run();
    const original = await readdir(join(output, 'prepared'));
    assert.equal(original.length, 2);
    const receipts = await Promise.all(original.map(file => readJson(join(output, 'prepared', file))));
    state.words.push(...['garden', 'hat', 'ice', 'juice'].map(seed));
    await atomicJson(join(output, 'manifest.json'), state);
    await run();
    const names = await readdir(join(output, 'prepared'));
    assert.equal(names.length, 3);
    for (let i = 0; i < original.length; i++) assert.deepEqual(await readJson(join(output, 'prepared', original[i])), receipts[i]);
    const requested = [];
    for (const file of names) requested.push(...JSON.parse((await readJson(join(output, 'prepared', file))).params.messages[0].content).entries.map(entry => entry.word));
    assert.equal(requested.length, 10);
    assert.equal(new Set(requested).size, 10);
    assert.equal(await readJson(join(output, 'ledger.json'), null), null);
  } finally { await rm(output, { recursive: true, force: true }); }
});
