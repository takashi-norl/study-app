import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { StudyEvent } from '../../src/server/google-store';
import { foldVocabularyLookups, saveVocabularyLookup } from '../../src/server/vocabulary-lookups';
function store() {
  const events: StudyEvent[] = [];
  let timestamp = Date.parse('2026-10-23T00:00:00Z');
  return { events, load: async () => events, append: async (items: StudyEvent[]) => { events.push(...items); }, now: () => new Date(timestamp += 1000) };
}
test('lookup history is per user, idempotent across retries, and tracks voluntary review without claiming mastery', async () => {
  const s = store(), ids = new Set(['avoid', 'basic-in-order-to']);
  const lookup = { requestId: randomUUID(), termId: 'avoid', action: 'lookup' };
  assert.equal((await saveVocabularyLookup('a', lookup, ids, s)).record.status, 'looked-up');
  await saveVocabularyLookup('a', lookup, ids, s);
  await saveVocabularyLookup('b', { ...lookup, requestId: randomUUID() }, ids, s);
  assert.equal(s.events.length, 2);
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].lookupCount, 1);
  assert.equal(foldVocabularyLookups(s.events, 'c').length, 0);
  const practice = await saveVocabularyLookup('a', { ...lookup, requestId: randomUUID(), action: 'practice' }, ids, s);
  assert.equal(practice.record.status, 'practice');
  await saveVocabularyLookup('a', { ...lookup, requestId: randomUUID() }, ids, s);
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].status, 'practice');
  await saveVocabularyLookup('a', { ...lookup, requestId: randomUUID(), action: 'known' }, ids, s);
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].status, 'known');
  await saveVocabularyLookup('a', { ...lookup, requestId: randomUUID() }, ids, s);
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].status, 'looked-up');
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].lookupCount, 3);
});
test('foreign owner input, unknown words, reused requests, and status changes before looking up are rejected', async () => {
  const s = store(), ids = new Set(['avoid']);
  const lookup = { requestId: randomUUID(), termId: 'avoid', action: 'lookup' };
  await assert.rejects(() => saveVocabularyLookup('a', { ...lookup, ownerId: 'b' }, ids, s));
  await assert.rejects(() => saveVocabularyLookup('a', { ...lookup, termId: 'arbitrary' }, ids, s), { code: 'GLOSSARY_NOT_FOUND' });
  await assert.rejects(() => saveVocabularyLookup('a', { ...lookup, action: 'known' }, ids, s), { code: 'LOOKUP_REQUIRED' });
  await saveVocabularyLookup('a', lookup, ids, s);
  await assert.rejects(() => saveVocabularyLookup('a', { ...lookup, action: 'known' }, ids, s), { code: 'REQUEST_CONFLICT' });
  s.events.push({ ...s.events[0] });
  assert.equal(foldVocabularyLookups(s.events, 'a')[0].lookupCount, 1);
});
