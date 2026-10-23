import test from 'node:test';
import assert from 'node:assert/strict';
import { readings } from './pilot-content.mjs';
import { applyIndependentReview, countEnglishWords, hashReading, validatePilot, validateReading } from './schema.mjs';
const copy = value => structuredClone(value);

test('original pilot has twelve passages, all domains and levels, forty-eight supported questions', () => {
  const result = validatePilot(readings);
  assert.equal(result.length, 12);
  assert.equal(result.reduce((n, r) => n + r.questions.length, 0), 48);
  assert.ok(result.every(r => r.review.status === 'draft' && r.contentSha256.length === 64));
});
test('word counts treat common contractions and hyphenated words consistently', () => {
  assert.equal(countEnglishWords("The clinic’s long-term plan isn't fixed."), 6);
});
test('evidence must be an exact quotation of an existing paragraph', () => {
  const absent = copy(readings[0]); absent.questions[0].evidence[0].paragraphId = 'p99';
  assert.throws(() => validateReading(absent), /paragraph does not exist/);
  const paraphrase = copy(readings[0]); paraphrase.questions[0].evidence[0].quote = 'people could not find the clinic';
  assert.throws(() => validateReading(paraphrase), /exact substring/);
});
test('answers need four distinct choices and an in-range saved answer', () => {
  const duplicate = copy(readings[0]); duplicate.questions[0].choices[3] = duplicate.questions[0].choices[0];
  assert.throws(() => validateReading(duplicate), /duplicate/);
  const invalid = copy(readings[0]); invalid.questions[0].correctIndex = 4;
  assert.throws(() => validateReading(invalid));
});
test('each grade enforces its passage length', () => {
  const tooShort = copy(readings[0]); tooShort.paragraphs = tooShort.paragraphs.map(p => ({ ...p, text: 'One short sentence.' }));
  assert.throws(() => validateReading(tooShort), /words; expected/);
});
test('the pilot cannot omit a level-domain combination or duplicate IDs', () => {
  const changed = copy(readings); changed[0].domainIds = ['travel'];
  assert.throws(() => validatePilot(changed), /medical/);
  const duplicate = copy(readings); duplicate[1].id = duplicate[0].id;
  assert.throws(() => validatePilot(duplicate), /Reading IDs/);
});
test('review binds every passage and its answers to the exact independently reviewed content', () => {
  const receipt = { reviewer: 'separate-review-agent', reviewedAt: '2026-10-23T00:00:00.000Z', passages: readings.map(r => ({ id: r.id, contentSha256: hashReading(r), approved: true, issues: [] })) };
  const approved = applyIndependentReview(readings, receipt);
  assert.ok(approved.every(r => r.review.status === 'approved'));
  const changed = copy(approved[0]); changed.questions[0].correctIndex = 0;
  assert.throws(() => validateReading(changed), /stale content hash/);
  const rejected = copy(receipt); rejected.passages[0].issues = ['A distractor could also be correct.'];
  assert.throws(() => applyIndependentReview(readings, rejected), /unresolved review/);
  const stale = copy(receipt); stale.passages[0].contentSha256 = '0'.repeat(64);
  assert.throws(() => applyIndependentReview(readings, stale), /outdated review/);
});
test('explanations must not depend on shuffled choice positions', () => {
  const positional = copy(readings[0]); positional.questions[0].explanationJa = '正解は2です。';
  assert.throws(() => validateReading(positional), /choice position/);
});
