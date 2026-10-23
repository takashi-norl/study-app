import assert from 'node:assert/strict';
import test from 'node:test';
import { vocabularyKnowledgeDomain, vocabularyKnowledgeDomainSentences, vocabularyKnowledgeIndex, vocabularyKnowledgeLookup, vocabularyKnowledgeSentence, vocabularyKnowledgeWord } from '../../src/server/vocabulary-knowledge';

test('compiled knowledge is available through bounded word, phrase, inflection and domain reads', async () => {
  const index = await vocabularyKnowledgeIndex();
  assert.ok(index && index.counts.catalogWords >= 100);
  const word = await vocabularyKnowledgeWord('reluctant');
  assert.equal(word?.sentences.length, 4);
  assert.ok(word?.word.relations.some(relation => relation.targetTerm === 'hesitant' && relation.evidenceIds.includes('reluctant:example-1')));
  assert.ok((await vocabularyKnowledgeLookup('went')).some(target => target.nodeId === 'basic-go' && target.forms.includes('past')));
  assert.equal((await vocabularyKnowledgeLookup(' In  order to '))[0].nodeId, 'phrase:in-order-to');
  const page = await vocabularyKnowledgeDomain('travel');
  assert.ok(page && page.words.length > 0 && page.words.length <= 100);
  const sentences = await vocabularyKnowledgeDomainSentences('travel');
  assert.ok(sentences && sentences.sentences.length > 0 && sentences.sentences.length <= 100);
  assert.equal((await vocabularyKnowledgeSentence('reluctant', 'reluctant:example-1'))?.ownerId, 'reluctant');
  assert.doesNotMatch(JSON.stringify({ word, page, sentences }), /fileId|cacheKey|audioBase64|apiKey/);
});

test('knowledge readers reject paths, foreign-owned sentences, missing nodes and invalid pages', async () => {
  for (const id of ['', '../index', '/etc/passwd', 'word/elsewhere', 'x'.repeat(201)]) {
    assert.equal(await vocabularyKnowledgeWord(id), null);
    assert.equal(await vocabularyKnowledgeDomain(id), null);
    assert.equal(await vocabularyKnowledgeSentence('reluctant', id), null);
  }
  assert.equal(await vocabularyKnowledgeSentence('reluctant', 'inevitable:example-1'), null);
  assert.equal(await vocabularyKnowledgeWord('not-a-real-vocabulary-node'), null);
  for (const page of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await vocabularyKnowledgeDomain('travel', page), null);
    assert.equal(await vocabularyKnowledgeDomainSentences('travel', page), null);
  }
  assert.deepEqual(await vocabularyKnowledgeLookup('__proto__'), []);
  assert.deepEqual(await vocabularyKnowledgeLookup('constructor'), []);
  assert.deepEqual(await vocabularyKnowledgeLookup('x'.repeat(241)), []);
});
