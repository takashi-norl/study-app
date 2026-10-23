import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hashVocabularyEntry } from './vocabulary-batch/schema.mjs';
import { applyVocabularyExportCorrections } from './vocabulary-export-corrections.mjs';

const catalog = JSON.parse(await readFile(new URL('../content/vocabulary-editorial-corrections.json', import.meta.url), 'utf8'));
const files = { 'vocab-cause': 'grade3-001', 'vocab-pending': 'grade2-016', 'vocab-have': 'grade2-005', 'vocab-arrears': 'pre1-012' };
const originals = new Map();
function setLeaf(entry, path, value) {
  const keys = path.slice(1).split('/'); let target = entry;
  for (const key of keys.slice(0, -1)) target = target[key];
  target[keys.at(-1)] = value;
}
const protectedFields = ({ tests: _tests, questions: _questions, recall: _recall, ...rest }) => rest;
for (const patch of catalog.patches) {
  const batch = JSON.parse(await readFile(new URL(`../content/vocabulary-generated/${files[patch.wordId]}.json`, import.meta.url), 'utf8'));
  const original = structuredClone(batch.entries.find(entry => entry.id === patch.wordId));
  // Reconstruct the exact immutable source, whether the display catalog is old or already exported.
  for (const operation of patch.operations) {
    if (operation.kind === 'replace-test-leaf') setLeaf(original, operation.path, operation.before);
    else (operation.mode === 'recall' ? original.recall : original.tests.find(item => item.mode === 'context')).alternatives = structuredClone(operation.before);
  }
  originals.set(original.id, original);
  test(`${patch.wordId}: exact reviewed result, protected fields and audio text unchanged, idempotent`, () => {
    assert.equal(hashVocabularyEntry(original), patch.beforeContentSha256);
    const corrected = applyVocabularyExportCorrections(original, catalog);
    assert.equal(hashVocabularyEntry(corrected), patch.afterContentSha256);
    assert.equal(hashVocabularyEntry(original), patch.beforeContentSha256);
    assert.deepEqual(protectedFields(corrected), protectedFields(original));
    assert.deepEqual(corrected.examples, original.examples);
    assert.equal(corrected.word, original.word); assert.equal(corrected.voice, original.voice);
    assert.deepEqual(applyVocabularyExportCorrections(corrected, catalog), corrected);
  });
  test(`${patch.wordId}: changed source and results outside the approved operations fail closed`, () => {
    const changed = structuredClone(original); changed.meaning += 'changed';
    assert.throws(() => applyVocabularyExportCorrections(changed, catalog), /source changed/);
    const invalid = structuredClone(catalog), rule = invalid.patches.find(row => row.wordId === patch.wordId);
    rule.operations[0].after = rule.operations[0].kind ? 'Unreviewed replacement.' : [];
    assert.throws(() => applyVocabularyExportCorrections(original, invalid));
  });
}
test('new patches retain exact independent source/review provenance while prior correction provenance is unchanged', () => {
  assert.equal(catalog.proposalSha256, 'b8d0ac2b2f5e43fa75f31c2aa7bc4f5c40048e5b3f658daa8d339893a2138235');
  for (const id of ['vocab-have', 'vocab-arrears']) {
    const p = catalog.patches.find(row => row.wordId === id).provenance;
    assert.equal(p.sourceProposalSha256, 'c0c8c8bdca085ce8c86607c726a140f8933c9ca98b88823c1ae711cfad8973b1');
    assert.equal(p.independentReviewSha256, 'df7defe3fbe6de61446aa37ea5082a73c34a3a8c5175638e920293869a64f126');
    assert.notEqual(p.sourceAuthor, p.independentReviewer); assert.equal(p.reviewedBy, '/root');
  }
});
test('have removes only bring from both context and recall alternatives', () => {
  const original = originals.get('vocab-have'), result = applyVocabularyExportCorrections(original, catalog);
  assert.deepEqual(result.tests.find(row => row.mode === 'context').alternatives.map(row => row.answer), ['carry']);
  assert.deepEqual(result.recall.alternatives.map(row => row.answer), ['carry']);
  assert.deepEqual(result.tests.filter(row => row.mode !== 'context'), original.tests.filter(row => row.mode !== 'context'));
});
test('arrears replaces one meaning-in-situation usage question and keeps its legacy mirror exact', () => {
  const original = originals.get('vocab-arrears'), result = applyVocabularyExportCorrections(original, catalog), usage = result.tests.find(row => row.mode === 'usage'), mirror = result.questions.find(row => row.type === 'usage');
  assert.match(usage.prompt, /この文が表す状況/); assert.equal(usage.correctIndex, 0);
  assert.equal(usage.choices[0].text, 'He still owes loan payments whose due dates have passed.');
  assert.equal(mirror.prompt, usage.prompt); assert.equal(mirror.explanation, usage.explanation); assert.equal(mirror.correctIndex, usage.correctIndex);
  assert.deepEqual(mirror.choices, usage.choices.map(row => row.text));
  assert.deepEqual(result.tests.filter(row => row.mode !== 'usage'), original.tests.filter(row => row.mode !== 'usage'));
  assert.deepEqual(result.recall, original.recall);
  assert.ok(!JSON.stringify(usage).includes('単数形で不自然な誤り文'));
});
test('leaf allowlist rejects protected fields, answer indexes, array edits, missing paths, wrong target modes and prototype keys', () => {
  const original = originals.get('vocab-arrears');
  const mutations = [
    p => { p.operations[0].path = '/examples/0/text'; },
    p => { p.operations[0].path = '/tests/3/correctIndex'; p.operations[0].after = 1; },
    p => { p.operations[0].path = '/tests/3/choices'; },
    p => { p.operations[0].path = '/tests/3/choices/4/text'; },
    p => { p.operations[0].path = '/tests/999/prompt'; },
    p => { p.operations[0].path = '/tests/0/prompt'; },
    p => { p.operations[0].path = '/questions/0/choices/0/meaning'; },
    p => { p.operations[0].path = '/tests/3/__proto__'; },
    p => { p.operations[0].before += ' changed'; },
    p => { p.operations[0].after = ''; },
    p => { p.operations[0].after = p.operations[0].before; },
    p => { p.operations[0].extra = 'not authorized'; },
    p => { p.operations.push(p.operations[0]); },
    p => { delete p.provenance; },
    p => { p.provenance.independentReviewer = p.provenance.sourceAuthor; },
    p => { p.provenance.independentReviewSha256 = 'invalid'; },
  ];
  for (const mutate of mutations) { const invalid = structuredClone(catalog), patch = invalid.patches.find(row => row.wordId === original.id); mutate(patch); assert.throws(() => applyVocabularyExportCorrections(original, invalid)); }
});
test('one-sided usage changes cannot pass even if a caller supplies the matching partial after hash', () => {
  const original = originals.get('vocab-arrears'), invalid = structuredClone(catalog), patch = invalid.patches.find(row => row.wordId === original.id);
  patch.operations = [patch.operations[0]]; const partial = structuredClone(original); setLeaf(partial, patch.operations[0].path, patch.operations[0].after);
  patch.afterContentSha256 = hashVocabularyEntry(partial);
  assert.throws(() => applyVocabularyExportCorrections(original, invalid), /exact mirrors/);
});
test('unrelated entries are preserved and duplicate patches are refused', () => {
  const unrelated = { id: 'vocab-unrelated' }; assert.equal(applyVocabularyExportCorrections(unrelated, catalog), unrelated);
  const invalid = structuredClone(catalog); invalid.patches.push(invalid.patches[0]);
  assert.throws(() => applyVocabularyExportCorrections(originals.get(invalid.patches[0].wordId), invalid), /Duplicate editorial/);
});
