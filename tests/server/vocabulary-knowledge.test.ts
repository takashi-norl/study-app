import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VocabularyEntry } from '../../src/lib/vocabulary-types';
import type { KnowledgeShard, KnowledgeWord } from '../../src/lib/vocabulary-knowledge-generated-types';
import type { VocabularyKnowledgeAnnotations } from '../../src/lib/vocabulary-knowledge-types';
import { compileVocabularyKnowledge, createKnowledgeMatcher, knowledgeShardId, writeVocabularyKnowledge } from '../../scripts/vocabulary-knowledge-lib';

const taxonomy = { schemaVersion: 1, domains: [{ id: 'travel', labelJa: '旅行' }], scenes: [{ id: 'trip', labelJa: '旅先' }], registers: [{ id: 'neutral', labelJa: '中立' }], grammarTags: [{ id: 'purpose', labelJa: '目的' }] };
const blankAnnotations = (): VocabularyKnowledgeAnnotations => ({ schemaVersion: 1, sourcePolicy: 'Explicit authored tags only.', words: [], phrases: [] });
function entry(id = 'go'): VocabularyEntry {
  return { id, word: id, level: '3級', ipa: '/goʊ/', ipaLabel: '米音', partOfSpeech: 'verb', definition: 'Move to another place.', meaning: '行く', usageTip: '行く動作を表します。',
    verbForms: { base: ['go'], past: ['went'], pastParticiple: ['gone'], presentParticiple: ['going'], thirdPersonSingular: ['goes'] },
    examples: [
      { id: 'example-1', context: '旅', text: 'I went home in order to rest.', translation: '休むために帰りました。' },
      { id: 'example-2', context: '旅', text: 'We go home.', translation: '家へ帰ります。' },
      { id: 'example-3', context: '旅', text: 'They have gone.', translation: '出発しました。' },
    ], recall: { prompt: 'I ___ home.', answers: ['go'], explanation: 'go home', alternatives: [{ answer: 'head', explanation: 'この文では家に向かう意味になります。' }] },
    production: { prompt: 'Write a sentence.', modelAnswer: 'We go home.', checkpoints: [] }, questions: [],
  };
}
function annotations(): VocabularyKnowledgeAnnotations {
  return { ...blankAnnotations(), words: [{ wordId: 'go', domains: ['travel'], sentenceAnnotations: [{ sentenceId: 'go:example-1', domains: ['travel'], scene: 'trip', register: 'neutral', grammar: ['purpose'], collocations: [{ phraseId: 'phrase:in-order-to', text: 'in order to' }] }],
    relations: [{ id: 'relation:go:example:head', type: 'contextual-synonym', targetTerm: 'head', scope: 'sentence', evidenceIds: ['go:example-2'], noteJa: '向かう動作。', limitationsJa: 'この文脈だけで置換できます。', replacementText: 'We head home.' }] }],
    phrases: [{ id: 'phrase:in-order-to', term: 'in order to', meaningJa: '〜するために', aliases: [], grammar: ['purpose'], evidenceIds: ['go:example-1'], noteJa: '目的を表します。' }],
  };
}
const build = (source = annotations()) => compileVocabularyKnowledge({ entries: [{ entry: entry(), batchId: 'test' }], glossary: [], taxonomy, annotations: source });
function word(result: ReturnType<typeof build>, id: string) { return (result.files.get(`words/${knowledgeShardId(id)}.json`) as KnowledgeShard).words[id]; }

test('longest known phrases and explicit inflections link without crossing punctuation or guessing suffixes', () => {
  const nodes = [
    { id: 'order', term: 'order', aliases: [] },
    { id: 'phrase:in-order-to', term: 'in order to', aliases: [] },
    { id: 'go', term: 'go', aliases: [{ text: 'went', form: 'past' }] },
    { id: 'see', term: 'see', aliases: [{ text: 'saw', form: 'past' }] },
    { id: 'saw', term: 'saw', aliases: [] },
  ];
  const text = 'Went in order to see a saw; reorder and going. In, order to go.';
  const matches = createKnowledgeMatcher(nodes)(text);
  assert.deepEqual(matches.map(link => link.text), ['Went', 'in order to', 'see', 'saw', 'order', 'go']);
  assert.equal(matches[0].targets[0].forms[0], 'past');
  assert.deepEqual(matches[3].targets.map(target => target.nodeId), ['saw', 'see']);
  assert.equal(matches[3].ambiguous, true);
  for (const link of matches) assert.equal(text.slice(link.start, link.end), link.text);
  const possessive = createKnowledgeMatcher([{ id: 'phrase:trust', term: "customers' trust", aliases: [] }]);
  assert.equal(possessive('It affects customers’ trust.')[0].text, 'customers’ trust');
});

test('relations retain their sense, direction, exact evidence and limitations without global synonym inference', () => {
  const result = build(), node = word(result, 'go');
  assert.equal(result.index.counts.scopedRelations, 2);
  assert.equal(node.relations[0].sourceSenseId, 'sense:go:primary');
  const scoped = node.relations.find(relation => relation.scope === 'sentence')!;
  assert.deepEqual(scoped.evidenceIds, ['go:example-2']);
  assert.equal(scoped.replacementText, 'We head home.');
  assert.equal(scoped.limitationsJa, 'この文脈だけで置換できます。');
  assert.deepEqual(scoped.targetIds, []); // The target is not silently invented as a dictionary entry.
  assert.equal(result.index.coverage.unresolvedRelationTargets, 2);
  const phrase = word(result, 'phrase:in-order-to');
  assert.deepEqual(phrase.evidenceIds, ['go:example-1']);
  assert.deepEqual(phrase.mentionedIn, ['go:example-1']);
  const sentence = (result.files.get(`words/${knowledgeShardId('go')}.json`) as KnowledgeShard).sentences['go:example-1'];
  assert.deepEqual(sentence.domainIds, ['travel']);
  assert.ok(sentence.links.find(link => link.text === 'went')?.targets.some(target => target.nodeId === 'go'));
});

test('unproven semantic labels, aliases, evidence and collocations fail closed', () => {
  const invalid: VocabularyKnowledgeAnnotations[] = [];
  let data = annotations(); data.words[0].domains = ['guessed']; invalid.push(data);
  data = annotations(); data.words[0].relations[0].evidenceIds = ['go:recall']; invalid.push(data);
  data = annotations(); data.words[0].relations[0].targetWordId = 'go'; invalid.push(data);
  data = annotations(); data.words[0].sentenceAnnotations[0].collocations[0].text = 'order'; invalid.push(data);
  data = annotations(); data.phrases[0].evidenceIds = ['go:example-2']; invalid.push(data);
  data = annotations(); data.phrases.push(structuredClone(data.phrases[0])); invalid.push(data);
  for (const source of invalid) assert.throws(() => build(source));
});

test('future catalog entries remain unclassified unless authored metadata provides a known domain', () => {
  const source = entry(); source.metadata = { schemaVersion: 2, cefrEstimate: 'A1', gradeEstimate: '3級', levelPolicy: 'Editor estimate.', domains: ['travel', 'unsupported-guess'] };
  const result = compileVocabularyKnowledge({ entries: [{ entry: source, batchId: 'test' }], glossary: [], taxonomy, annotations: blankAnnotations() });
  assert.deepEqual(word(result, 'go').domainIds, ['travel']);
  assert.deepEqual(result.index.coverage.unknownDomainTags, ['unsupported-guess']);
  assert.equal(result.index.coverage.annotatedWords, 0);
  assert.equal((result.files.get('domains/travel/index.json') as { sentenceCount: number }).sentenceCount, 0);
});

test('generated shards exclude extra private provider fields and stay deterministic under catalog order changes', () => {
  const first = entry(), second = { ...entry('rest'), word: 'rest', verbForms: undefined };
  Object.assign(first, { fileId: 'PRIVATE_DRIVE_FILE', apiKey: 'PRIVATE_API_KEY' });
  const compile = (entries: VocabularyEntry[]) => compileVocabularyKnowledge({ entries: entries.map(entry => ({ entry, batchId: 'test' })), glossary: [], taxonomy, annotations: blankAnnotations() });
  const a = compile([first, second]), b = compile([second, first]);
  assert.deepEqual(a.files, b.files);
  const serialized = JSON.stringify([...a.files]);
  assert.doesNotMatch(serialized, /PRIVATE_|fileId|apiKey/);
});

test('incremental writes leave unchanged files alone and delete only compiler-tracked obsolete shards', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vocabulary-knowledge-'));
  try {
    const result = build();
    const initial = await writeVocabularyKnowledge(result, directory);
    assert.ok(initial.written > 0);
    const again = await writeVocabularyKnowledge(result, directory);
    assert.equal(again.written, 0); assert.equal(again.unchanged, initial.written);
    await writeFile(path.join(directory, 'notes.txt'), 'keep');
    const empty = compileVocabularyKnowledge({ entries: [], glossary: [], taxonomy, annotations: blankAnnotations() });
    const change = await writeVocabularyKnowledge(empty, directory);
    assert.ok(change.removed > 0);
    assert.equal(await readFile(path.join(directory, 'notes.txt'), 'utf8'), 'keep');
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: null }));
    await assert.rejects(writeVocabularyKnowledge(empty, directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('7500 entries compile into bounded shards and domain pages without provider access', () => {
  const entries = Array.from({ length: 7500 }, (_, index) => {
    const item = entry(`term${index}`); item.word = item.id; item.verbForms = undefined;
    item.examples = item.examples.map(example => ({ ...example, text: `${item.word} belongs here.` }));
    item.recall = { prompt: 'Choose the word.', answers: [item.word], explanation: 'A local sample.' };
    item.metadata = { schemaVersion: 2, cefrEstimate: 'A1', gradeEstimate: '3級', levelPolicy: 'Editor estimate.', domains: ['travel'] };
    return { entry: item, batchId: `set-${Math.floor(index / 100)}` };
  });
  const result = compileVocabularyKnowledge({ entries, glossary: [], taxonomy, annotations: blankAnnotations() });
  assert.equal(result.index.counts.catalogWords, 7500);
  assert.equal(result.index.counts.sentences, 30000);
  assert.equal(result.index.domains[0].pages, 75);
  assert.equal([...result.files.keys()].filter(key => key.startsWith('words/')).length, 256);
  for (const [file, data] of result.files) if (file.startsWith('words/')) {
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 4 * 1024 * 1024);
    assert.ok(Object.values((data as KnowledgeShard).words).every((node: KnowledgeWord) => node.sentenceIds.length === 4));
  }
});
