import assert from 'node:assert/strict';
import test from 'node:test';
import { hashVocabularyEntry, jsonSchema, reviewSchema, validateReview } from './schema.mjs';

const entries = ['apple', 'pear', 'orange', 'grape', 'melon'].map(word => ({ word }));
const verdicts = () => entries.map(({ word }) => ({ word, approved: true, issues: [] }));

test('local decoding preserves approved siblings and the full long rejected explanation', () => {
  const issue = `  ${'A detailed explanation of the incorrect distractor. '.repeat(30)}\n`;
  const raw = { verdicts: verdicts() };
  raw.verdicts[2] = { word: 'orange', approved: false, issues: [issue] };
  const before = JSON.stringify(raw);
  const checked = validateReview(raw, entries);
  assert.deepEqual(checked.map(verdict => verdict.approved), [true, true, false, true, true]);
  assert.equal(checked[2].issues[0], issue);
  assert.equal(JSON.stringify(raw), before);
});

test('saved issue decoding has an 8000-character bound and rejects blank or oversized issues', () => {
  const raw = issue => ({ verdicts: [{ word: 'apple', approved: false, issues: [issue] }] });
  assert.equal(validateReview(raw('x'.repeat(8000)), [entries[0]])[0].issues[0].length, 8000);
  for (const issue of ['x'.repeat(8001), '', ' \n\t ']) assert.throws(() => validateReview(raw(issue), [entries[0]]));
  assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: false, issues: Array(13).fill('Issue.') }] }, [entries[0]]));
});

test('local decoding still requires every exact lemma once, with no missing or unknown verdicts', () => {
  for (const invalid of [
    verdicts().slice(0, 4),
    [...verdicts(), { word: 'peach', approved: true, issues: [] }],
    verdicts().map((verdict, index) => index === 1 ? { ...verdict, word: 'apple' } : verdict),
    verdicts().map((verdict, index) => index === 1 ? { ...verdict, word: 'peach' } : verdict),
    verdicts().map((verdict, index) => index === 1 ? { ...verdict, word: 'Pear' } : verdict),
  ]) assert.throws(() => validateReview({ verdicts: invalid }, entries), /each requested lemma exactly once/);
});

test('approval is valid if and only if issues are empty, including long issue strings', () => {
  for (const issues of [['Wrong gloss.'], ['x'.repeat(8000)]]) {
    assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: true, issues }] }, [entries[0]]), /disagree/);
  }
  assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: false, issues: [] }] }, [entries[0]]), /disagree/);
  assert.equal(validateReview({ verdicts: [{ word: 'apple', approved: true, issues: [] }] }, [entries[0]])[0].approved, true);
});

test('local decoding preserves strict field and verdict-count limits', () => {
  assert.throws(() => validateReview({ verdicts: verdicts(), unexpected: true }, entries));
  assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: false, issues: ['Issue.'], unexpected: true }] }, [entries[0]]));
  assert.throws(() => validateReview({ verdicts: Array(11).fill({ word: 'apple', approved: false, issues: ['Issue.'] }) }, Array(11).fill(entries[0])));
});

test('outbound review schema remains byte-identical for immutable prepared request hashes', () => {
  assert.equal(hashVocabularyEntry(jsonSchema(reviewSchema)), '113b3effbc26b3d7ef4686a3b01f202e2d8ca143d70ff50f056994f82af7fcea');
  const outbound = issues => ({ verdicts: [{ word: 'apple', approved: false, issues }] });
  assert.equal(reviewSchema.safeParse(outbound(['x'.repeat(500)])).success, true);
  assert.equal(reviewSchema.safeParse(outbound(['x'.repeat(501)])).success, false);
});
