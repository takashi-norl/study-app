import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInventoryHolds, baseCount, requestTouchesHeldInventory } from './holds.mjs';
import { hashVocabularyEntry } from './schema.mjs';
const seed = word => ({ id: `vocab-${word}`, word, grade: 'grade2', status: 'inventoried', frozen: false });

test('hold preserves paid groups and seed order, excludes base counts, and fences old prepared calls', () => {
  const state = { words: ['rare', 'safe', 'extra'].map(seed) };
  const before = structuredClone(state);
  const records = applyInventoryHolds(state, [{ id: 'vocab-rare', reason: 'Specialist filler', seedHash: hashVocabularyEntry(state.words[0]) }], [{ batchId: 'old', entries: [{ word: 'rare' }, { word: 'safe' }] }], 'independent-review');
  assert.deepEqual(records.map(record => record.id), ['vocab-rare', 'vocab-safe']);
  assert.equal(baseCount(state.words, 'grade2'), 1);
  assert.deepEqual(state.words.map(({ inventoryHold, ...word }) => word), before.words);
  const request = names => ({ params: { messages: [{ role: 'user', content: JSON.stringify({ entries: names.map(word => ({ word })) }) }] } });
  assert.equal(requestTouchesHeldInventory(request(['safe']), state.words), true);
  assert.equal(requestTouchesHeldInventory(request(['extra']), state.words), false);
  assert.throws(() => requestTouchesHeldInventory({ params: {} }, state.words));
});

test('stale or completed-group decisions fail atomically', () => {
  for (const completed of [false, true]) {
    const state = { words: ['rare', 'safe'].map(seed) };
    if (completed) state.words[1].status = 'approved';
    const before = structuredClone(state);
    assert.throws(() => applyInventoryHolds(state, [{ id: 'vocab-rare', reason: 'Hold', seedHash: completed ? hashVocabularyEntry(state.words[0]) : 'stale' }], [{ batchId: 'old', entries: [{ word: 'rare' }, { word: 'safe' }] }], 'review'));
    assert.deepEqual(state, before);
  }
});
