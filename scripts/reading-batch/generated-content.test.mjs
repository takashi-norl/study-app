import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSeries } from './schema.mjs';

test('exported reading manifest matches validated content and review status', async () => {
  const indexUrl = new URL('../../content/reading-generated/index.json', import.meta.url);
  const index = JSON.parse(await readFile(indexUrl, 'utf8'));
  assert.equal(index.schemaVersion, 1);
  const allIds = [], levelDomains = [];
  for (const descriptor of index.series) {
    assert.match(descriptor.file, /^[a-z0-9-]+\.json$/);
    const saved = JSON.parse(await readFile(new URL(descriptor.file, indexUrl), 'utf8'));
    const readings = validateSeries(saved.readings, descriptor.id);
    assert.equal(saved.seriesId, descriptor.id);
    assert.equal(descriptor.passageCount, readings.length);
    assert.equal(descriptor.questionCount, readings.reduce((count, reading) => count + reading.questions.length, 0));
    assert.equal(saved.reviewStatus, descriptor.reviewStatus);
    assert.equal(descriptor.reviewStatus, readings.every(reading => reading.review.status === 'approved') ? 'approved' : 'draft');
    assert.equal(descriptor.publicationStatus, 'unpublished');
    allIds.push(...readings.map(reading => reading.id));
    levelDomains.push(...readings.map(reading => `${reading.level}/${reading.domainIds[0]}`));
  }
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(new Set(levelDomains).size, levelDomains.length);
  if (index.series.some(series => series.id === 'reading-domains-volume2-v1')) assert.equal(allIds.length, 46);
});
