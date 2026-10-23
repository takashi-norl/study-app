import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileGrammarKnowledgeLinks } from './knowledge-links';

const source = JSON.parse(readFileSync(new URL('../../content/grammar-generated/series-v1.json', import.meta.url), 'utf8'));
const lexicon = {
  sourceDigest: 'a'.repeat(64),
  nodes: [
    { id: 'vocab-get', kind: 'word' as const, term: 'get', domainIds: [], aliases: [{ text: 'got', form: 'past' }] },
    { id: 'phrase-get-across', kind: 'phrase' as const, term: 'get across', domainIds: [], aliases: [] },
    { id: 'vocab-take', kind: 'word' as const, term: 'take', domainIds: [], aliases: [] },
  ],
};

test('grammar sidecar links exact approved examples and contrasts without test-answer leakage', () => {
  const result = compileGrammarKnowledgeLinks(source, lexicon);
  assert.equal(result.counts.lessons, 36);
  assert.equal(result.counts.sentences, 288);
  assert.ok(result.counts.spans > 0);
  for (const lesson of result.lessons) {
    const original = source.lessons.find((item: { id: string }) => item.id === lesson.lessonId);
    assert.equal(lesson.sentences.length, 8);
    const texts = new Map<string, string>([
      ...original.examples.map((example: { id: string; text: string }) => [example.id, example.text]),
      ...original.contrasts.flatMap((contrast: { leftEnglish: string; rightEnglish: string }, index: number) => [
        [`${lesson.lessonId}-contrast-${index + 1}-left`, contrast.leftEnglish],
        [`${lesson.lessonId}-contrast-${index + 1}-right`, contrast.rightEnglish],
      ]),
    ]);
    for (const sentence of lesson.sentences) {
      const text = texts.get(sentence.sentenceId)!;
      assert.ok(text);
      for (const span of sentence.spans) {
        assert.equal(text.slice(span.start, span.end), span.text);
        assert.ok(span.targets.every(target => lexicon.nodes.some(node => node.id === target.nodeId)));
      }
    }
  }
  assert.deepEqual(compileGrammarKnowledgeLinks(source, lexicon), result);
});

test('stale, missing or draft independent review cannot generate linked learning material', () => {
  const stale = structuredClone(source);
  stale.lessons[0].examples[0].text += ' Changed.';
  assert.throws(() => compileGrammarKnowledgeLinks(stale, lexicon), /review hashes/);
  const draft = structuredClone(source);
  draft.lessons[0].review.status = 'draft';
  assert.throws(() => compileGrammarKnowledgeLinks(draft, lexicon));
  const missing = structuredClone(source);
  delete missing.lessons[0].review;
  assert.throws(() => compileGrammarKnowledgeLinks(missing, lexicon));
  assert.throws(() => compileGrammarKnowledgeLinks(source, { ...lexicon, nodes: [...lexicon.nodes, lexicon.nodes[0]] }), /Duplicate/);
});
