import test from 'node:test';
import assert from 'node:assert/strict';
import { hashVocabularyEntry, inventorySchema, jsonSchema } from './schema.mjs';
import { auditInventoryCandidates, futureInventoryRequestSchema, inventoryFocusForRound, INVENTORY_QUALITY_INSTRUCTIONS, planInventoryQuarantine } from './inventory-quality.mjs';

const seed = (word, extra = {}) => ({ id: `vocab-${word}`, word, grade: 'grade2', status: 'inventoried', frozen: false,
  partOfSpeech: '名詞', meaning: '教材用の意味', cefr: 'B2', domains: ['science'], ...extra });
const candidate = word => { const { id, grade, status, frozen, ...entry } = seed(word); return entry; };
const domains = ['science', 'daily-life'];
const decision = word => ({ id: word.id, contentSha256: hashVocabularyEntry(word), reason: 'Specialist sense requires curricular review before generation.' });

test('future inventory schema constrains tags without changing the legacy request schema/hash', () => {
  const before = hashVocabularyEntry(jsonSchema(inventorySchema));
  const future = futureInventoryRequestSchema(domains);
  const value = { words: [{ ...candidate('angular'), domains: ['geometry', 'science'] }] };
  assert.equal(inventorySchema.safeParse(value).success, true);
  assert.equal(future.safeParse(value).success, false);
  assert.equal(future.safeParse({ words: [] }).success, true);
  assert.equal(inventorySchema.safeParse({ words: [] }).success, false);
  assert.equal(hashVocabularyEntry(jsonSchema(inventorySchema)), before);
});

test('zero-yield audit counts overlapping duplicate/domain failures without silently mapping tags', () => {
  const words = [candidate('known'), { ...candidate('knownalso'), domains: ['geometry'] }, { ...candidate('angular'), domains: ['geometry', 'science'] }];
  const report = auditInventoryCandidates({ words }, { knownLemmas: new Set(['known', 'knownalso']), domainIds: domains, needed: 50 });
  assert.equal(report.duplicateCount, 2); assert.equal(report.invalidDomainCount, 2);
  assert.equal(report.selectedCount, 0); assert.equal(report.action, 'stop-for-inventory-review');
  assert.equal(report.paidRetryAuthorized, false); assert.deepEqual(words[2].domains, ['geometry', 'science']);
});

test('low yield stays a stop even when a few novel candidates survive; no automatic semantic approval', () => {
  const old = 'abcdefghijklmnopqrst'.split('').map(letter => `known${letter}`);
  const report = auditInventoryCandidates({ words: [...old.map(candidate), candidate('newword')] }, { knownLemmas: new Set(old), domainIds: domains, needed: 50 });
  assert.equal(report.selectedCount, 1); assert.equal(report.action, 'stop-for-inventory-review');
  assert.equal(report.paidRetryAuthorized, false);
  assert.match(INVENTORY_QUALITY_INSTRUCTIONS.join(' '), /ceiling, not a quota/);
});

test('new-request focus rotates across all initials and canonical domains without creating quota pressure', () => {
  const tags = Array.from({ length: 23 }, (_, i) => `domain-${i}`), initials = new Set(), primary = new Set();
  for (let round = 0; round < 26; round++) {
    const focus = inventoryFocusForRound(round, tags);
    assert.deepEqual(focus, inventoryFocusForRound(round, tags));
    initials.add(focus.preferredInitialLetters[0]); primary.add(focus.preferredDomains[0]);
    assert.equal(new Set(focus.preferredInitialLetters).size, 6);
    assert.ok(focus.preferredDomains.every(tag => tags.includes(tag)));
    assert.match(focus.policy, /not quotas/);
  }
  assert.equal(initials.size, 26); assert.equal(primary.size, 23);
  assert.notDeepEqual(inventoryFocusForRound(64, tags), inventoryFocusForRound(65, tags));
});

test('quarantine proposal preserves completed generation groups and their good siblings without mutation', () => {
  const rare = seed('rareword'), good = seed('generalword'), fresh = seed('specialword');
  const state = { words: [rare, good, fresh] }, before = JSON.stringify(state);
  const plan = planInventoryQuarantine(state, [decision(rare), decision(fresh)], [{ requestId: 'generate-saved', requestHash: 'a'.repeat(64), status: 'complete', entries: [rare, good] }]);
  assert.deepEqual(plan.untouchedSeedIds, [fresh.id]);
  assert.deepEqual(plan.preserveAndHoldGroups[0].preserveAllGroupWords, ['rareword', 'generalword']);
  assert.equal(plan.preserveAndHoldGroups[0].requiresProviderReconciliation, false);
  assert.equal(plan.status, 'proposal-not-applied'); assert.equal(plan.paidCallsAuthorized, false);
  assert.equal(JSON.stringify(state), before);
});

test('quarantine proposal refuses approved/frozen or stale revisions', () => {
  for (const word of [seed('word', { status: 'approved' }), seed('word', { frozen: true })]) {
    assert.throws(() => planInventoryQuarantine({ words: [word] }, [decision(word)]), /Only current/);
  }
  const word = seed('word');
  assert.throws(() => planInventoryQuarantine({ words: [word] }, [{ ...decision(word), contentSha256: '0'.repeat(64) }]), /stale/);
});

test('in-flight request membership requires reconciliation and is never treated as an untouched seed', () => {
  const word = seed('word');
  for (const status of ['batch_pending', 'requested', 'uncertain']) {
    const plan = planInventoryQuarantine({ words: [word] }, [decision(word)], [{ requestId: 'generate-current', requestHash: 'b'.repeat(64), status, entries: [word] }]);
    assert.deepEqual(plan.untouchedSeedIds, []);
    assert.equal(plan.preserveAndHoldGroups[0].requiresProviderReconciliation, true);
    assert.equal(plan.paidCallsAuthorized, false);
  }
});
