import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { hashVocabularyEntry as hash } from './schema.mjs';
import { applyCatalogDispositions, planCatalogDispositions } from './catalog-disposition.mjs';
import { assertDispositionContent, catalogCounts, publicCatalogGroups } from './catalog-policy.mjs';
import { baseCount, isBaseCandidate, requestTouchesHeldInventory } from './holds.mjs';
import { loadRegistry } from '../english-expansion/loaders.mjs';
import { planningStatus } from '../english-expansion/planner.mjs';

const at = '2026-10-24T00:00:00.000Z';
const put = async (file, data) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data)); };
const read = async file => JSON.parse(await readFile(file, 'utf8'));
function fixtureData() {
  const words = ['wroth', 'annexe', 'andrenaline', 'annex'].map((word, index) => ({ id: `vocab-${word}`, word, grade: 'grade2',
    status: index === 1 || index === 2 ? 'rejected' : 'approved', batchId: `grade2-${word}-r2`, attempt: 2, frozen: false }));
  const records = new Map(words.map(seed => {
    const entry = { id: seed.id, word: seed.word, meaning: '元の内容', examples: [{ text: 'Original paid sentence.' }] };
    return [seed.id, { entry, review: { status: seed.status, contentSha256: hash(entry), requestId: `review-${seed.batchId}`, issues: seed.status === 'approved' ? [] : ['Original rejection evidence.'] } }];
  }));
  const decisions = words.slice(0, 3).map((seed, index) => ({ id: seed.id, seedSha256: hash(seed), contentSha256: hash(records.get(seed.id).entry), contentReviewSha256: hash(records.get(seed.id).review),
    kind: ['expansion-only', 'alias-only', 'invalid-lemma'][index], reason: '基本教材の集計・公開対象から外し、保存済み資料は保全する。',
    ...(index === 1 ? { targetId: 'vocab-annex' } : {}), ...(index === 2 ? { canonicalLemma: 'adrenaline' } : {}) }));
  const proposal = { schemaVersion: 1, id: 'catalog-review-001', createdBy: 'author', decisions };
  const review = { schemaVersion: 1, proposalSha256: hash(proposal), reviewedBy: 'independent-reviewer', reviewedAt: at, verdicts: decisions.map(d => ({ id: d.id, approved: true, issues: [] })) };
  return { state: { schemaVersion: 1, words }, records, proposal, review };
}
function reviewedMutation(data, fn) { fn(data.proposal); data.review.proposalSha256 = hash(data.proposal); }
function applied(data) {
  const plan = planCatalogDispositions({ ...data, appliedAt: at });
  return data.state.words.map(seed => ({ ...seed, ...(plan.changes.find(c => c.id === seed.id) ? { catalogDisposition: plan.changes.find(c => c.id === seed.id).catalogDisposition } : {}) }));
}
async function filesystemFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-disposition-')), data = fixtureData();
  const output = join(root, 'assets'), proposalPath = join(root, 'proposal.json'), reviewPath = join(root, 'review.json');
  const frozen = []; data.state.frozenSha256 = hash(frozen);
  const assetFiles = [];
  try {
    await put(join(output, 'manifest.json'), data.state); await put(join(output, 'frozen-100.json'), frozen);
    await put(join(output, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'paid-original', status: 'complete', actualUsd: 1, reservedUsd: 2 }] });
    for (const seed of data.state.words) {
      const file = seed.status === 'approved' ? join(output, 'approved', seed.grade, `${seed.batchId}.json`) : join(output, 'rejected', `${seed.batchId}.json`);
      await put(file, { schemaVersion: 1, batchId: seed.batchId, entries: [data.records.get(seed.id)] }); assetFiles.push(file);
    }
    for (const [name, value] of [['raw/saved-provider.json', { paid: true }], ['audio/assets/cache/asset.json', { cacheKey: 'unchanged' }], ['audio/reservations/cache.json', { reservedMicroUsd: 123 }]]) {
      const file = join(output, name); await put(file, value); assetFiles.push(file);
    }
    assetFiles.push(join(output, 'ledger.json'), join(output, 'frozen-100.json'));
    await put(proposalPath, data.proposal); await put(reviewPath, data.review);
    return await action({ ...data, root, output, proposalPath, reviewPath, assetFiles });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('reviewed disposition excludes base/public counts without changing status, ordering or paid content', () => {
  const data = fixtureData(), words = applied(data);
  assert.deepEqual(words.map(({ catalogDisposition, ...seed }) => seed), data.state.words);
  assert.equal(baseCount(words), 1); assert.equal(catalogCounts(words).baseCompleted, 1);
  assert.equal(catalogCounts(words).allApprovedNew, 2); assert.equal(catalogCounts(words).catalogExcluded, 3);
  assert.equal(isBaseCandidate(words[0]), false);
  const request = { params: { messages: [{ role: 'user', content: JSON.stringify({ entries: [{ word: 'annexe' }] }) }] } };
  assert.equal(requestTouchesHeldInventory(request, words), true);
  assertDispositionContent(words[0], data.records.get(words[0].id));
  const altered = structuredClone(data.records.get(words[0].id)); altered.entry.meaning = 'changed';
  assert.throws(() => assertDispositionContent(words[0], altered), /content or original review/);
  words[0].status = 'inventoried'; assert.throws(() => baseCount(words), /immutable seed/);
});
test('approval must bind exact proposal, every decision, seed, content and prior review', () => {
  const mutations = [d => { d.review.reviewedBy = d.proposal.createdBy; }, d => { d.proposal.decisions[0].reason = 'changed'; },
    d => d.review.verdicts.pop(), d => { d.state.words[0].attempt = 3; }, d => { d.records.get('vocab-wroth').entry.meaning = 'changed'; },
    d => { d.records.get('vocab-wroth').review.issues.push('changed'); }, d => { d.state.words[0].frozen = true; }];
  for (const mutate of mutations) { const data = fixtureData(); mutate(data); assert.throws(() => planCatalogDispositions(data)); }
});
test('aliases require retained approved targets; invalid lemmas require rejected evidence and explicit correction', () => {
  for (const change of [p => { p.decisions[1].targetId = 'vocab-wroth'; }, p => { delete p.decisions[1].targetId; },
    p => { p.decisions[2].canonicalLemma = 'andrenaline'; }, p => { p.decisions[0].kind = 'invalid-lemma'; p.decisions[0].canonicalLemma = 'wrath'; }]) {
    const data = fixtureData(); reviewedMutation(data, change); assert.throws(() => planCatalogDispositions(data));
  }
});
test('stable export groups keep later set numbers when an entire early set is excluded', () => {
  const data = fixtureData(), excluded = applied(data)[0];
  const words = Array.from({ length: 101 }, (_, i) => ({ id: `word-${i}`, word: `word-${i}`, grade: 'grade2', status: 'approved' }));
  words[0] = excluded;
  for (let i = 1; i < 100; i++) words[i].inventoryHold = { reviewId: 'test-only' };
  const approved = new Map(words.map(word => [word.id, { id: word.id }]));
  assert.deepEqual(publicCatalogGroups(words, approved, 'grade2'), [{ ordinal: 2, entries: [{ id: 'word-100' }] }]);
});
test('dry run is read only; apply preserves every paid file; exact replay is idempotent', async () => filesystemFixture(async f => {
  const before = await readFile(join(f.output, 'manifest.json'), 'utf8');
  const paidBefore = await Promise.all(f.assetFiles.map(file => readFile(file, 'utf8')));
  const options = { output: f.output, proposalPath: f.proposalPath, reviewPath: f.reviewPath };
  assert.equal((await applyCatalogDispositions(options)).mode, 'dry-run');
  assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), before);
  assert.equal((await applyCatalogDispositions({ ...options, write: true })).after.baseCompleted, 1);
  const after = await readFile(join(f.output, 'manifest.json'), 'utf8');
  const replay = await applyCatalogDispositions({ ...options, write: true }); assert.equal(replay.replayed, true);
  assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), after);
  assert.deepEqual(await Promise.all(f.assetFiles.map(file => readFile(file, 'utf8'))), paidBefore);
  const receipt = await read(join(f.output, 'catalog-dispositions', f.proposal.id, 'receipt.json'));
  assert.equal(receipt.paidCalls, 0); assert.equal(receipt.changes.length, 3);
  const registry = await loadRegistry({ phaseOneOutput: f.output });
  assert.equal(planningStatus(registry).baseApprovedDistinct, 1);
  assert.equal(planningStatus(registry).registeredDistinct, 1);
  for (const word of ['wroth', 'annexe', 'andrenaline', 'adrenaline']) assert.ok(registry.forms.has(word));
  assert.equal(registry.units.get('vocab-wroth').source, 'retained-excluded');
}));
test('pending or unknown billing blocks application and does not change manifest', async () => filesystemFixture(async f => {
  const before = await readFile(join(f.output, 'manifest.json'), 'utf8');
  for (const status of ['batch_pending', 'requested', 'uncertain']) {
    await put(join(f.output, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'unsettled', status, reservedUsd: 1 }] });
    await assert.rejects(applyCatalogDispositions({ ...f, write: true }), /settle all text requests/);
    assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), before);
  }
}));
test('changed evidence or missing immutable receipt cannot replace an applied disposition', async () => filesystemFixture(async f => {
  await applyCatalogDispositions({ ...f, write: true });
  const before = await readFile(join(f.output, 'manifest.json'), 'utf8');
  await rm(join(f.output, 'catalog-dispositions', f.proposal.id, 'receipt.json'));
  await assert.rejects(applyCatalogDispositions({ ...f, write: true }), /receipt is missing/);
  assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), before);
}));
