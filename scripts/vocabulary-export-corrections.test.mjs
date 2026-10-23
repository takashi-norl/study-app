import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hashVocabularyEntry } from './vocabulary-batch/schema.mjs';
import { applyVocabularyExportCorrections } from './vocabulary-export-corrections.mjs';

const catalog = JSON.parse(await readFile(new URL('../content/vocabulary-editorial-corrections.json', import.meta.url), 'utf8'));
const files = { 'vocab-cause': 'grade3-001', 'vocab-pending': 'grade2-016' };
for (const patch of catalog.patches) {
  const batch = JSON.parse(await readFile(new URL(`../content/vocabulary-generated/${files[patch.wordId]}.json`, import.meta.url), 'utf8'));
  const original = structuredClone(batch.entries.find(entry => entry.id === patch.wordId));
  // Both the pre-release and corrected exported catalog exercise the same immutable source fixture.
  for (const operation of patch.operations) {
    const target = operation.mode === 'recall' ? original.recall : original.tests.find(test => test.mode === 'context');
    target.alternatives = structuredClone(operation.before);
  }
  test(`${patch.wordId}: remove only reviewed invalid replacements, keep source and audio text unchanged, remain idempotent`, () => {
    assert.equal(hashVocabularyEntry(original), patch.beforeContentSha256);
    const corrected = applyVocabularyExportCorrections(original, catalog);
    assert.equal(hashVocabularyEntry(corrected), patch.afterContentSha256);
    assert.equal(hashVocabularyEntry(original), patch.beforeContentSha256);
    assert.deepEqual(corrected.examples, original.examples);
    assert.equal(corrected.word, original.word);
    assert.equal(corrected.voice, original.voice);
    assert.deepEqual(applyVocabularyExportCorrections(corrected, catalog), corrected);
  });
  test(`${patch.wordId}: refuse changed source or edits beyond the exact reviewed removal`, () => {
    const changed = structuredClone(original); changed.meaning += 'changed';
    assert.throws(() => applyVocabularyExportCorrections(changed, catalog), /source changed/);
    const invalid = structuredClone(catalog), rule = invalid.patches.find(row => row.wordId === patch.wordId);
    rule.operations[0].after = [];
    assert.throws(() => applyVocabularyExportCorrections(original, invalid), /remove exactly one/);
  });
}
test('unrelated entries are preserved', () => {
 const unrelated={id:'vocab-unrelated'};
 assert.equal(applyVocabularyExportCorrections(unrelated,catalog),unrelated);
});
