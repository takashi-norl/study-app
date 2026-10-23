import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readings } from './pilot-content.mjs';
import { ALL_READING_DOMAINS, VOLUME2_DOMAINS, applyIndependentReview, applyReviewReceipts, hashReading, validateSeries } from './schema.mjs';

test('schema expansion preserves every independently reviewed pilot content hash', async () => {
  const receipt = JSON.parse(await readFile(new URL('../../content/reading-generated/pilot-v1.review.json', import.meta.url), 'utf8'));
  const approved = applyIndependentReview(readings, receipt);
  assert.equal(approved.length, 12);
  assert.ok(approved.every(r => hashReading(r) === receipt.passages.find(p => p.id === r.id).contentSha256));
});
test('separate independent reviewers keep their own per-passage attribution', () => {
  const receipt = (source, reviewer) => ({ reviewer, reviewedAt: '2026-10-23T00:00:00.000Z', passages: source.map(reading => ({ id: reading.id, contentSha256: hashReading(reading), approved: true, issues: [] })) });
  const first = receipt(readings.slice(0, 6), 'reviewer-one'), second = receipt(readings.slice(6), 'reviewer-two');
  const approved = applyReviewReceipts(readings, [first, second], 'reading-domains-pilot-v1');
  assert.equal(approved[0].review.reviewer, 'reviewer-one');
  assert.equal(approved[6].review.reviewer, 'reviewer-two');
  assert.throws(() => applyReviewReceipts(readings, [first], 'reading-domains-pilot-v1'), /exactly/);
});
test('second volume covers exactly the seventeen remaining domains and both levels', () => {
  assert.equal(ALL_READING_DOMAINS.length, 23);
  assert.equal(VOLUME2_DOMAINS.length, 17);
  const fixtures = VOLUME2_DOMAINS.flatMap(domain => ['2級', '準1級'].map(level => ({
    ...structuredClone(readings.find(r => r.level === level)), id: `test-${level === '2級' ? 'grade2' : 'pre1'}-${domain}`,
    title: `${level} ${domain} fixture`, domainIds: [domain], seriesId: 'reading-domains-volume2-v1',
  })));
  assert.equal(validateSeries(fixtures, 'reading-domains-volume2-v1').length, 34);
  assert.throws(() => validateSeries(fixtures.slice(1), 'reading-domains-volume2-v1'), /34 passages/);
});
