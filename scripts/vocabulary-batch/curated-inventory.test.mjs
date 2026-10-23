import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GRADES, hashVocabularyEntry } from './schema.mjs';
import { withLock } from './storage.mjs';
import { importCuratedInventory, inventoryForms, planCuratedInventory } from './curated-inventory.mjs';

const put = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const lemma = (word = 'resilient', extra = {}) => ({ word, partOfSpeech: '形容詞', meaning: '困難から回復できる', cefr: 'B2', domains: ['society'], ...extra });
const source = (words = [lemma()]) => ({ schemaVersion: 1, id: 'curated-pre1-pilot', grade: 'pre1', createdBy: '/writer', words });
const review = (src, decisions = {}) => ({ sourceSha256: hashVocabularyEntry(src), reviewedBy: '/reviewer', verdicts: src.words.map(w => ({ word: w.word, approved: decisions[w.word] !== false, issues: decisions[w.word] === false ? ['この学習帯では優先しません。'] : [] })) });
function state(words = []) { return { schemaVersion: 1, gradeTargets: GRADES, words, inventoryRounds: { grade2: 68 }, batches: {} }; }
const plan = (src = source(), rev = review(src), manifest = state(), knownEntries = []) => planCuratedInventory({ state: manifest, source: src, review: rev, knownEntries, domainIds: ['society', 'education'] });
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-curated-import-')), output = join(root, 'assets'), sourcePath = join(root, 'source.json'), reviewPath = join(root, 'review.json');
  try {
    const entry = { id: 'go', word: 'go', partOfSpeech: '動詞', verbForms: { base: ['go'], past: ['went'], pastParticiple: ['gone'], presentParticiple: ['going'], thirdPersonSingular: ['goes'] } };
    const frozen = [{ grade: 'grade2', entry, contentSha256: hashVocabularyEntry(entry) }];
    const manifest = { ...state([{ id: 'go', word: 'go', partOfSpeech: '動詞', grade: 'grade2', status: 'preserved', frozen: true }]), frozenSha256: hashVocabularyEntry(frozen) };
    await put(join(output, 'manifest.json'), manifest); await put(join(output, 'frozen-100.json'), frozen);
    const color = { id: 'vocab-color', word: 'color', aliases: ['colour'], partOfSpeech: '名詞' };
    await put(join(output, 'approved', 'grade3', 'fixture.json'), { schemaVersion: 1, entries: [{ entry: color, review: { status: 'approved', contentSha256: hashVocabularyEntry(color) } }] });
    await put(join(output, 'ledger.json'), { schemaVersion: 1, calls: [{ id: 'prior-paid', status: 'complete', actualUsd: 1 }] });
    await put(join(output, 'raw', 'prior-paid.json'), { evidence: 'must remain byte-for-byte unchanged' });
    const src = source(); await put(sourcePath, src); await put(reviewPath, review(src));
    return await action({ root, output, sourcePath, reviewPath, manifest, src });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('each accepted source word needs an independent verdict bound to exact canonical source content', () => {
  const src = source([lemma(), lemma('coherent')]);
  assert.equal(plan(src).seeds.length, 2);
  const wrong = review(src); wrong.sourceSha256 = 'a'.repeat(64); assert.throws(() => plan(src, wrong), /exact source/);
  assert.throws(() => plan(src, { ...review(src), reviewedBy: ' /WRITER ' }), /independent/);
  assert.throws(() => plan(src, { ...review(src), verdicts: review(src).verdicts.slice(0, 1) }), /every source/);
  assert.throws(() => plan(src, { ...review(src), verdicts: [review(src).verdicts[0], review(src).verdicts[0]] }), /every source/);
  const inconsistent = review(src); inconsistent.verdicts[0].issues = ['未解決の問題']; assert.throws(() => plan(src, inconsistent), /disagree/);
});
test('rejected words remain in source evidence but are never added to inventory', () => {
  const src = source([lemma(), lemma('coherent')]), result = plan(src, review(src, { coherent: false }));
  assert.deepEqual(result.seeds.map(s => s.word), ['resilient']); assert.equal(result.source.words.length, 2);
});
test('canonical domains, Japanese meanings, unique lemmas and optional form metadata are validated', () => {
  for (const words of [[lemma(), lemma()], [lemma('resilient', { domains: ['invented'] })], [lemma('resilient', { meaning: 'able to recover' })], [lemma('resilient', { domains: ['society', 'society'] })], [lemma('resilient', { aliases: ['x'], verbForms: { base: ['different'], past: [], pastParticiple: [], presentParticiple: [], thirdPersonSingular: [] } })]]) assert.throws(() => plan(source(words)));
  assert.throws(() => plan({ ...source(), id: '../escape' }));
});
test('existing canonical, alias, irregular and regular inflection collisions are rejected', () => {
  const known = [{ word: 'go', partOfSpeech: '動詞', verbForms: { past: ['went'], pastParticiple: ['gone'] } }, { word: 'color', partOfSpeech: '名詞', aliases: ['colour'] }, { word: 'study', partOfSpeech: '動詞' }, { word: 'child', partOfSpeech: '名詞' }, { word: 'happy', partOfSpeech: '形容詞' }];
  for (const word of ['go', 'went', 'gone', 'colour', 'studied', 'studies', 'studying', 'children', 'happier']) assert.throws(() => plan(source([lemma(word)]), undefined, state(), known), /overlap/);
  assert.throws(() => plan(source([lemma('coloured', { aliases: ['color'] })]), undefined, state(), known), /overlap/);
  // A derivational family relation does not automatically collapse distinct lemmas.
  assert.equal(plan(source([lemma('happiness', { partOfSpeech: '名詞' })]), undefined, state(), known).seeds.length, 1);
});
test('candidate-to-candidate aliases and inflections cannot inflate the import count', () => {
  const src = source([lemma('colour', { aliases: ['color'] }), lemma('color')]); assert.throws(() => plan(src), /overlap/);
  assert.throws(() => plan(source([lemma('recover', { partOfSpeech: '動詞' }), lemma('recovered')])), /overlap/);
  assert.ok(inventoryForms({ word: 'stop', partOfSpeech: '動詞' }).has('stopped'));
});
test('held seeds remain dedup exclusions but do not occupy the grade quota', () => {
  const manifest = state([{ id: 'vocab-resilient', word: 'resilient', grade: 'pre1', inventoryHold: { reason: 'review' }, status: 'inventoried' }]);
  assert.throws(() => plan(source(), undefined, manifest), /Duplicate|overlap/);
  assert.equal(plan(source([lemma('coherent')]), undefined, manifest).currentCount, 0);
});
test('grade quota is checked before append and cannot be silently reallocated', () => {
  const manifest = state(Array.from({ length: 2400 }, (_, i) => ({ id: `old-${i}`, word: `old${i}`, grade: 'pre1', status: 'approved' })));
  assert.throws(() => plan(source(), undefined, manifest), /exceed the grade/);
  assert.throws(() => plan(source(), undefined, { ...state(), gradeTargets: { pre1: { target: 3000 } } }), /target differs/);
});
test('dry-run is the default and leaves manifest, paid evidence and content byte-identical', async () => fixture(async options => {
  const paths = ['manifest.json', 'ledger.json', 'raw/prior-paid.json', 'approved/grade3/fixture.json']; const before = await Promise.all(paths.map(p => readFile(join(options.output, p), 'utf8')));
  const result = await importCuratedInventory(options); assert.equal(result.mode, 'dry-run'); assert.equal(result.added, 0); assert.equal(result.approvedCount, 1); assert.equal(result.paidCalls, 0);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(join(options.output, p), 'utf8'))), before);
  await assert.rejects(readFile(join(options.output, 'curated-inventory', options.src.id, 'receipt.json')), /ENOENT/);
}));
test('write appends reviewed seeds with copied evidence before manifest and never touches prior provider history', async () => fixture(async options => {
  const ledgerBefore = await readFile(join(options.output, 'ledger.json'), 'utf8'), rawBefore = await readFile(join(options.output, 'raw', 'prior-paid.json'), 'utf8');
  const result = await importCuratedInventory({ ...options, write: true }); assert.equal(result.added, 1);
  const manifest = await json(join(options.output, 'manifest.json')); assert.deepEqual(manifest.words.slice(0, 1), options.manifest.words); assert.deepEqual(manifest.inventoryRounds, options.manifest.inventoryRounds);
  const added = manifest.words[1]; assert.equal(added.status, 'inventoried'); assert.equal(added.inventoryProvenance.kind, 'curated-offline');
  const directory = join(options.output, 'curated-inventory', options.src.id); assert.deepEqual(await json(join(directory, 'source.json')), options.src);
  assert.deepEqual(await json(join(directory, 'receipt.json')), manifest.curatedInventoryReceipts[options.src.id]);
  assert.equal(await readFile(join(options.output, 'ledger.json'), 'utf8'), ledgerBefore); assert.equal(await readFile(join(options.output, 'raw', 'prior-paid.json'), 'utf8'), rawBefore);
}));
test('identical replay is idempotent even after normal generation progress advances', async () => fixture(async options => {
  await importCuratedInventory({ ...options, write: true }); const manifest = await json(join(options.output, 'manifest.json')); manifest.words[1].status = 'approved'; manifest.words[1].batchId = 'generated-later'; await put(join(options.output, 'manifest.json'), manifest);
  const before = await readFile(join(options.output, 'manifest.json'), 'utf8'); const result = await importCuratedInventory({ ...options, write: true }); assert.equal(result.replayed, true); assert.equal(result.added, 0); assert.equal(await readFile(join(options.output, 'manifest.json'), 'utf8'), before);
}));
test('source identity cannot be reused for different source, review or seed details', async () => fixture(async options => {
  await importCuratedInventory({ ...options, write: true }); const changedReview = review(options.src); changedReview.reviewedBy = '/another-reviewer'; await put(options.reviewPath, changedReview);
  await assert.rejects(importCuratedInventory({ ...options, write: true }), /different source or review/);
  await put(options.reviewPath, review(options.src)); const manifest = await json(join(options.output, 'manifest.json')); manifest.words[1].meaning = '別の意味'; await put(join(options.output, 'manifest.json'), manifest);
  await assert.rejects(importCuratedInventory({ ...options, write: true }), /reviewed provenance/);
}));
test('interruption after provenance write but before manifest append can recover exactly once', async () => fixture(async options => {
  await importCuratedInventory({ ...options, write: true }); await put(join(options.output, 'manifest.json'), options.manifest);
  const result = await importCuratedInventory({ ...options, write: true }); assert.equal(result.added, 1); assert.equal((await json(join(options.output, 'manifest.json'))).words.length, 2);
  assert.equal((await importCuratedInventory({ ...options, write: true })).replayed, true);
}));
test('interrupted import with a changed baseline stops rather than silently applying stale evidence', async () => fixture(async options => {
  await importCuratedInventory({ ...options, write: true }); await put(join(options.output, 'manifest.json'), { ...options.manifest, updatedAt: 'changed' });
  await assert.rejects(importCuratedInventory({ ...options, write: true }), /baseline changed/);
}));
test('missing or altered imported evidence cannot be silently recreated', async () => fixture(async options => {
  await importCuratedInventory({ ...options, write: true }); const directory = join(options.output, 'curated-inventory', options.src.id);
  await put(join(directory, 'source.json'), { ...options.src, createdBy: 'tampered' }); await assert.rejects(importCuratedInventory(options), /evidence differs/);
  await put(join(directory, 'source.json'), options.src); await rm(join(directory, 'receipt.json')); await assert.rejects(importCuratedInventory(options), /receipt is missing/);
}));
test('import shares the exact text-build lock and refuses concurrent manifest mutation', async () => fixture(async options => {
  await withLock(options.output, async () => assert.rejects(importCuratedInventory({ ...options, write: true }), /Another text build owns/));
}));
test('loaded frozen forms and approved aliases participate in dedup and their hashes are verified', async () => fixture(async options => {
  for (const word of ['went', 'colour']) { const src = source([lemma(word)]); await put(options.sourcePath, src); await put(options.reviewPath, review(src)); await assert.rejects(importCuratedInventory(options), /overlap/); }
  const path = join(options.output, 'approved', 'grade3', 'fixture.json'), content = await json(path); content.entries[0].entry.word = 'tampered'; await put(path, content);
  await assert.rejects(importCuratedInventory(options), /not bound to its review/);
}));
