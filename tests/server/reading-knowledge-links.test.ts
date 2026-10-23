import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileReadingKnowledgeLinks, loadApprovedReadings, loadKnowledgeLexicon, writeReadingKnowledgeLinks, type ReadingLexiconNode } from '../../scripts/reading-batch/knowledge-links';
import { hashReading, validateReading } from '../../scripts/reading-batch/schema.mjs';
import { knowledgeShardId } from '../../scripts/vocabulary-knowledge-lib';

const pilot = JSON.parse(readFileSync(path.resolve('content/reading-generated/pilot-v1.json'), 'utf8'));
const base = validateReading(pilot.readings.find((reading: { level: string }) => reading.level === '2級'));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const prefix = '😀 Went in order to rest. A saw supports supporters. Going sawdust. ';
const lexicon = () => ({ sourceDigest: 'a'.repeat(64), nodes: [
  { id: 'go', kind: 'word', term: 'go', domainIds: ['travel'], aliases: [{ text: 'went', form: 'past' }] },
  { id: 'order', kind: 'word', term: 'order', domainIds: [], aliases: [] },
  { id: 'phrase:in-order-to', kind: 'phrase', term: 'in order to', domainIds: [], aliases: [] },
  { id: 'see', kind: 'word', term: 'see', domainIds: [], aliases: [{ text: 'saw', form: 'past' }] },
  { id: 'saw', kind: 'word', term: 'saw', domainIds: [], aliases: [] },
  { id: 'support', kind: 'word', term: 'support', domainIds: [], aliases: [] },
] satisfies ReadingLexiconNode[] });

function fixture() {
  const reading = structuredClone(base);
  reading.paragraphs[0].text = prefix + reading.paragraphs[0].text;
  reading.vocabulary = ['went', 'in order to', 'unknown', 'go dancing', 'saw'].map(term => ({ term, meaningJa: 'テスト用の語釈', linkPolicy: 'resolve-lemma-in-shared-catalog' as const }));
  const contentSha256 = hashReading(reading);
  return validateReading({ ...reading, wordCount: undefined, contentSha256, review: { status: 'approved', method: 'independent-ai-review', reviewer: 'test-fixture', reviewedAt: '2026-10-23T00:00:00.000Z', contentSha256 } });
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reading-links-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('paragraph links use exact longest known spans and explicit inflections with UTF-16 offsets', () => {
  const reading = fixture(), result = compileReadingKnowledgeLinks([reading], lexicon());
  const paragraph = result.readings[0].paragraphs[0];
  const matches = paragraph.spans.filter(span => span.start < prefix.length);
  assert.deepEqual(matches.map(span => span.text), ['Went', 'in order to', 'saw']);
  assert.equal(matches[0].start, 3); // An emoji occupies two UTF-16 code units.
  assert.deepEqual(matches[0].targets, [{ nodeId: 'go', kind: 'word', forms: ['past'] }]);
  assert.deepEqual(matches[1].targets.map(target => target.nodeId), ['phrase:in-order-to']);
  assert.equal(matches[2].ambiguous, true);
  assert.deepEqual(matches[2].targets.map(target => target.nodeId), ['saw', 'see']);
  for (const span of paragraph.spans) assert.equal(reading.paragraphs[0].text.slice(span.start, span.end), span.text);
  assert.equal(paragraph.textSha256, sha(reading.paragraphs[0].text));
  assert.equal(result.readings[0].contentSha256, reading.contentSha256);
  assert.equal(result.offsetUnit, 'utf16-code-unit');
});

test('glossary links preserve homographs and leave unknown or partial compounds unresolved', () => {
  const result = compileReadingKnowledgeLinks([fixture()], lexicon());
  const glosses = result.readings[0].glossary;
  assert.deepEqual(glosses.map(gloss => [gloss.term, gloss.status]), [['went', 'resolved'], ['in order to', 'resolved'], ['unknown', 'unresolved'], ['go dancing', 'unresolved'], ['saw', 'resolved']]);
  assert.equal(glosses[4].ambiguous, true);
  assert.deepEqual(glosses[2].targets, []);
  assert.equal(result.counts.resolvedGlosses, 3);
  assert.equal(result.counts.unresolvedGlosses, 2);
  assert.deepEqual(result.readings[0].domainIds, fixture().domainIds);
  const bigger = lexicon();
  bigger.nodes.push({ id: 'unknown', kind: 'word', term: 'unknown', domainIds: [], aliases: [] });
  const next = compileReadingKnowledgeLinks([fixture()], bigger);
  assert.equal(next.readings[0].glossary[2].status, 'resolved');
  assert.notEqual(next.sourceDigest, result.sourceDigest);
});

test('compiler rejects draft, stale approved content and duplicate node or reading identities', () => {
  const reading = fixture();
  assert.throws(() => compileReadingKnowledgeLinks([{ ...reading, review: { status: 'draft', method: 'independent-ai-review-required' } }], lexicon()), /approved/);
  const stale = structuredClone(reading); stale.title += ' changed';
  assert.throws(() => compileReadingKnowledgeLinks([stale], lexicon()), /hash|review/);
  assert.throws(() => compileReadingKnowledgeLinks([reading, reading], lexicon()), /unique/);
  const duplicate = lexicon(); duplicate.nodes.push(duplicate.nodes[0]);
  assert.throws(() => compileReadingKnowledgeLinks([reading], duplicate), /Duplicate/);
});

test('stable output ignores input node order and repeat writes preserve the source content', async () => {
  const reading = fixture(), original = JSON.stringify(reading), first = compileReadingKnowledgeLinks([reading], lexicon());
  const reversed = lexicon(); reversed.nodes.reverse();
  assert.deepEqual(compileReadingKnowledgeLinks([reading], reversed), first);
  await temporary(async directory => {
    const output = path.join(directory, 'knowledge-links.json');
    assert.deepEqual(await writeReadingKnowledgeLinks(output, first), { written: true });
    assert.deepEqual(await writeReadingKnowledgeLinks(output, first), { written: false });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), first);
  });
  assert.equal(JSON.stringify(reading), original);
});

test('indexed loader only reads approved series and verifies descriptor counts and safe paths', async () => {
  await temporary(async directory => {
    const descriptor = { id: pilot.seriesId, file: 'pilot.json', reviewStatus: 'approved', passageCount: 12, questionCount: 48 };
    const index = { schemaVersion: 1, series: [descriptor, { id: 'future', file: 'nonexistent-draft.json', reviewStatus: 'draft', passageCount: 1, questionCount: 0 }] };
    const indexPath = path.join(directory, 'index.json');
    await writeFile(path.join(directory, 'pilot.json'), JSON.stringify(pilot));
    await writeFile(indexPath, JSON.stringify(index));
    assert.equal((await loadApprovedReadings(indexPath)).readings.length, 12);
    await writeFile(indexPath, JSON.stringify({ ...index, series: [{ ...descriptor, questionCount: 49 }] }));
    await assert.rejects(() => loadApprovedReadings(indexPath), /counts/);
    await writeFile(indexPath, JSON.stringify({ ...index, series: [{ ...descriptor, file: '../pilot.json' }] }));
    await assert.rejects(() => loadApprovedReadings(indexPath));
    const changed = structuredClone(pilot); changed.readings[0].title += ' changed';
    await writeFile(path.join(directory, 'pilot.json'), JSON.stringify(changed));
    await writeFile(indexPath, JSON.stringify(index));
    await assert.rejects(() => loadApprovedReadings(indexPath), /hash|review/);
  });
});

test('vocabulary loader verifies shard hashes, identity, count, and path before using nodes', async () => {
  await temporary(async directory => {
    await mkdir(path.join(directory, 'words'));
    const node = lexicon().nodes[0], file = `words/${knowledgeShardId(node.id)}.json`;
    const indexText = JSON.stringify({ schemaVersion: 1, sourceDigest: 'a'.repeat(64), counts: { nodes: 1 } });
    const shardText = JSON.stringify({ schemaVersion: 1, words: { [node.id]: node } });
    const manifest = { schemaVersion: 1, files: { 'index.json': sha(indexText), [file]: sha(shardText) } };
    await writeFile(path.join(directory, 'index.json'), indexText);
    await writeFile(path.join(directory, file), shardText);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    assert.deepEqual((await loadKnowledgeLexicon(directory)).nodes, [node]);
    await writeFile(path.join(directory, file), `${shardText} `);
    await assert.rejects(() => loadKnowledgeLexicon(directory), /saved hash/);
    await writeFile(path.join(directory, file), shardText);
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, files: { ...manifest.files, 'words/../../outside.json': 'a'.repeat(64) } }));
    await assert.rejects(() => loadKnowledgeLexicon(directory), /Unsafe/);
  });
});
