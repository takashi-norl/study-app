import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GRADES, hashVocabularyEntry } from './schema.mjs';
import { applyCatalogFamilies, planCatalogFamilies } from './catalog-family.mjs';
import { assertCatalogFamilies, assertFamilyContent } from './canonical-policy.mjs';
import { catalogCounts, isPublicCandidate, publicCatalogGroups } from './catalog-policy.mjs';
import { baseCount } from './holds.mjs';
import { planCuratedInventory } from './curated-inventory.mjs';
import { planCatalogDispositions } from './catalog-disposition.mjs';
import { withSharedSpendingFence } from '../shared-spending-fence.mjs';

const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function fixtureState({ crossGrade = false, frozenCanonical = false } = {}) {
  const words = [{ id: 'vocab-analog', word: 'analog', grade: crossGrade ? 'grade3' : 'grade2', status: frozenCanonical ? 'preserved' : 'approved', frozen: frozenCanonical, ...(frozenCanonical ? {} : { batchId: 'approved-one' }) },
    { id: 'vocab-analogue', word: 'analogue', grade: 'grade2', status: 'approved', frozen: false, batchId: 'approved-two' }];
  const records = new Map(words.map((seed, i) => {
    const entry = { id: seed.id, word: seed.word, partOfSpeech: i ? '名詞' : '形容詞', examples: [{ text: i ? 'The device has an analogue.' : 'The clock is analog.' }] };
    return [seed.id, seed.frozen ? { entry, contentSha256: hashVocabularyEntry(entry), grade: seed.grade } : { entry, review: { status: 'approved', contentSha256: hashVocabularyEntry(entry), reviewedBy: '/content-reviewer' } }];
  }));
  const state = { schemaVersion: 1, gradeTargets: GRADES, words, batches: {} };
  const proposal = { schemaVersion: 1, id: 'reviewed-families-one', createdBy: '/lexical-auditor', auditSourceSha256: 'a'.repeat(64), auditEvidenceSha256: 'b'.repeat(64), groups: [{ familyId: 'analog-family', canonicalId: words[0].id, reason: '米英表記の語族を一つとして数え、異なる品詞・語義の教材は残します。', members: words.map(seed => ({ id: seed.id, seedSha256: hashVocabularyEntry(seed), contentSha256: hashVocabularyEntry(records.get(seed.id).entry), contentReviewSha256: seed.frozen ? null : hashVocabularyEntry(records.get(seed.id).review), sourceKind: seed.frozen ? 'frozen' : 'approved' })) }] };
  const review = { schemaVersion: 1, proposalSha256: hashVocabularyEntry(proposal), reviewedBy: '/independent-reviewer', reviewedAt: '2026-10-24T00:00:00.000Z', verdicts: [{ familyId: 'analog-family', approved: true, issues: [] }] };
  return { state, records, proposal, review };
}
function planned(options) { const f = fixtureState(options); const plan = planCatalogFamilies(f); return { ...f, ...plan, state: { ...f.state, words: plan.nextWords } }; }
async function diskFixture(action, settings) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-canonical-family-')), output = join(root, 'assets'), runtimeDirectory = join(root, 'runtime'), proposalPath = join(root, 'proposal.json'), reviewPath = join(root, 'review.json');
  try {
    const f = fixtureState(settings), frozen = f.state.words.filter(w => w.frozen).map(w => f.records.get(w.id));
    f.state.frozenSha256 = hashVocabularyEntry(frozen);
    await put(join(output, 'manifest.json'), f.state); await put(join(output, 'frozen-100.json'), frozen); await put(proposalPath, f.proposal); await put(reviewPath, f.review);
    await put(join(output, 'ledger.json'), { calls: [{ id: 'paid-one', status: 'complete', actualUsd: 0.5 }] }); await put(join(output, 'raw', 'paid-one.json'), { immutable: 'provider evidence' });
    for (const word of f.state.words.filter(w => !w.frozen)) await put(join(output, 'approved', word.grade, `${word.batchId}.json`), { schemaVersion: 1, batchId: word.batchId, entries: [f.records.get(word.id)] });
    await mkdir(runtimeDirectory); await writeFile(join(runtimeDirectory, 'stop-production'), 'checkpoint');
    return await action({ ...f, root, output, runtimeDirectory, proposalPath, reviewPath });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('canonical families count once but retain both paid sense cards and stable public sets', () => {
  const f = planned(); assert.equal(baseCount(f.state.words), 1); assert.equal(catalogCounts(f.state.words).baseCompleted, 1); assert.equal(catalogCounts(f.state.words).allApprovedNew, 2);
  assert.equal(catalogCounts(f.state.words).publicCardCount, 2); assert.equal(catalogCounts(f.state.words).canonicalMerges, 1); assert.ok(f.state.words.every(isPublicCandidate));
  assert.deepEqual(publicCatalogGroups(f.state.words, new Map([...f.records].map(([id, row]) => [id, row.entry])), 'grade2').flatMap(g => g.entries), [...f.records.values()].map(row => row.entry));
  for (const word of f.state.words) assert.deepEqual(Object.fromEntries(Object.entries(word).filter(([key]) => key !== 'catalogFamily')), fixtureState().state.words.find(w => w.id === word.id));
});
test('cross-grade grouping frees only the redundant grade slot without reallocating targets', () => {
  const f = planned({ crossGrade: true }); assert.equal(baseCount(f.state.words, 'grade3'), 1); assert.equal(baseCount(f.state.words, 'grade2'), 0);
  assert.equal(catalogCounts(f.state.words, 'grade2').publicCardCount, 1); assert.equal(catalogCounts(f.state.words, 'grade3').canonicalMerges, 0);
  assert.deepEqual(f.state.gradeTargets, GRADES); assert.equal(f.state.words[1].grade, 'grade2');
});
test('existing curated importer permits exactly the freed slots and still deduplicates retained cards', () => {
  const f = planned(); f.state.words.push(...Array.from({ length: 1498 }, (_, i) => ({ id: `old-${i}`, word: `old${i}`, grade: 'grade2', status: 'approved' })));
  const source = { schemaVersion: 1, id: 'one-replacement', grade: 'grade2', createdBy: '/author', words: [{ word: 'resilient', partOfSpeech: '形容詞', meaning: '回復力がある', cefr: 'B2', domains: ['society'] }] };
  const review = s => ({ sourceSha256: hashVocabularyEntry(s), reviewedBy: '/reviewer', verdicts: s.words.map(w => ({ word: w.word, approved: true, issues: [] })) });
  const plan = s => planCuratedInventory({ state: f.state, source: s, review: review(s), knownEntries: [...f.records.values()].map(r => r.entry), domainIds: ['society'] });
  assert.equal(plan(source).currentCount, 1499); assert.equal(plan(source).seeds.length, 1);
  assert.throws(() => plan({ ...source, words: [...source.words, { ...source.words[0], word: 'coherent' }] }), /exceed the grade/);
  assert.throws(() => plan({ ...source, words: [{ ...source.words[0], word: 'analogue' }] }), /Duplicate|overlap/);
});
test('a frozen canonical retains its bytes and groups the new sense without increasing approved new count', () => {
  const f = planned({ frozenCanonical: true, crossGrade: true }); assert.equal(catalogCounts(f.state.words).baseApprovedNew, 0); assert.equal(catalogCounts(f.state.words).allApprovedNew, 1);
  for (const seed of f.state.words) assertFamilyContent(seed, f.records.get(seed.id));
});
test('every family needs independent exact proposal approval and no overlapping membership', () => {
  let f = fixtureState(); assert.throws(() => planCatalogFamilies({ ...f, review: { ...f.review, reviewedBy: f.proposal.createdBy } }), /independent/);
  assert.throws(() => planCatalogFamilies({ ...f, review: { ...f.review, verdicts: [] } }));
  f.proposal.groups[0].reason = 'changed'; assert.throws(() => planCatalogFamilies(f), /exact family/);
  f = fixtureState(); f.proposal.groups.push({ ...f.proposal.groups[0], familyId: 'second' }); f.review.proposalSha256 = hashVocabularyEntry(f.proposal); f.review.verdicts.push({ familyId: 'second', approved: true, issues: [] }); assert.throws(() => planCatalogFamilies(f), /overlapping/);
});
test('stale seed, status, approval, content and held cards cannot free quota', () => {
  for (const mutate of [f => f.state.words[1].word = 'changed', f => f.state.words[1].status = 'rejected', f => f.state.words[1].inventoryHold = { reason: 'held' }, f => f.records.get('vocab-analogue').entry.examples[0].text = 'changed', f => f.records.get('vocab-analogue').review.reviewedBy = '/changed']) {
    const f = fixtureState(); mutate(f); assert.throws(() => planCatalogFamilies(f));
  }
});
test('missing members, forged canonical grades and changed metadata fail closed in counting and export', () => {
  let f = planned(); assert.throws(() => catalogCounts(f.state.words.slice(1)), /target|missing/);
  f = planned(); delete f.state.words[1].catalogFamily; assert.throws(() => catalogCounts(f.state.words), /missing/); assert.throws(() => publicCatalogGroups(f.state.words, new Map(), 'grade2'), /missing/);
  f = planned(); f.state.words[1].catalogFamily.canonicalGrade = 'pre1'; assert.throws(() => assertCatalogFamilies(f.state.words), /grade|conflicting/);
  f = planned(); f.records.get('vocab-analog').review.reviewedBy = '/changed'; assert.throws(() => assertFamilyContent(f.state.words[0], f.records.get('vocab-analog')), /content or original review/);
});
test('grouped cards cannot be individually excluded with a disposition', () => {
  const f = planned(), seed = f.state.words[1], row = f.records.get(seed.id);
  const proposal = { schemaVersion: 1, id: 'exclude-grouped', createdBy: '/writer', decisions: [{ id: seed.id, seedSha256: hashVocabularyEntry(seed), contentSha256: hashVocabularyEntry(row.entry), contentReviewSha256: hashVocabularyEntry(row.review), kind: 'expansion-only', reason: 'different scope' }] };
  const review = { schemaVersion: 1, proposalSha256: hashVocabularyEntry(proposal), reviewedBy: '/reviewer', reviewedAt: '2026-10-24T00:00:00.000Z', verdicts: [{ id: seed.id, approved: true, issues: [] }] };
  assert.throws(() => planCatalogDispositions({ state: f.state, proposal, review, records: f.records }), /family migration/);
});
test('dry-run changes no manifest, original assets or provider evidence; write is metadata-only and idempotent', async () => diskFixture(async f => {
  const paths = ['manifest.json', 'ledger.json', 'raw/paid-one.json', 'approved/grade2/approved-one.json', 'approved/grade2/approved-two.json', 'frozen-100.json'];
  const before = await Promise.all(paths.map(path => readFile(join(f.output, path), 'utf8')));
  const dry = await applyCatalogFamilies(f); assert.equal(dry.after.baseEligible, 1); assert.equal(dry.paidCalls, 0);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(f.output, path), 'utf8'))), before);
  const result = await applyCatalogFamilies({ ...f, write: true }); assert.equal(result.after.completedCardCount, 2);
  assert.deepEqual(await Promise.all(paths.slice(1).map(path => readFile(join(f.output, path), 'utf8'))), before.slice(1));
  const manifestBytes = await readFile(join(f.output, 'manifest.json'), 'utf8'); assert.equal((await applyCatalogFamilies({ ...f, write: true })).replayed, true); assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), manifestBytes);
}));
test('write requires stop checkpoint, no active workers, exact shared lock and settled paid outcomes', async () => diskFixture(async f => {
  await rm(join(f.runtimeDirectory, 'stop-production')); await assert.rejects(applyCatalogFamilies({ ...f, write: true }), /checkpoint/); await writeFile(join(f.runtimeDirectory, 'stop-production'), 'stopped');
  await mkdir(join(f.runtimeDirectory, 'production.lock')); await assert.rejects(applyCatalogFamilies({ ...f, write: true }), /still active/); await rm(join(f.runtimeDirectory, 'production.lock'), { recursive: true });
  await withSharedSpendingFence({ output: f.output, sharedLockDirectory: join(f.runtimeDirectory, 'shared-spending.lock'), ownerKind: 'phase-one' }, async () => assert.rejects(applyCatalogFamilies({ ...f, write: true }), /already held/));
  await put(join(f.output, 'ledger.json'), { calls: [{ status: 'unknown' }] }); await assert.rejects(applyCatalogFamilies({ ...f, write: true }), /settled/);
}));
test('crash after evidence resumes only with the same manifest baseline; missing evidence never recreated', async () => diskFixture(async f => {
  const original = await json(join(f.output, 'manifest.json')); await applyCatalogFamilies({ ...f, write: true }); await put(join(f.output, 'manifest.json'), original);
  assert.equal((await applyCatalogFamilies({ ...f, write: true })).replayed, false);
  const applied = await json(join(f.output, 'manifest.json')); await put(join(f.output, 'manifest.json'), { ...original, updatedAt: 'changed' });
  await assert.rejects(applyCatalogFamilies({ ...f, write: true }), /baseline changed/);
  await put(join(f.output, 'manifest.json'), applied); await rm(join(f.output, 'catalog-families', f.proposal.id, 'receipt.json'));
  await assert.rejects(applyCatalogFamilies({ ...f, write: true }), /receipt is missing/);
}));
test('frozen canonical grouping persists metadata without rewriting the frozen asset', async () => diskFixture(async f => {
  const before = await readFile(join(f.output, 'frozen-100.json'), 'utf8'); await applyCatalogFamilies({ ...f, write: true });
  assert.equal(await readFile(join(f.output, 'frozen-100.json'), 'utf8'), before); assert.equal((await applyCatalogFamilies(f)).after.baseEligible, 1);
}, { frozenCanonical: true, crossGrade: true }));
