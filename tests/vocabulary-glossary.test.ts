import assert from 'node:assert/strict';
import test from 'node:test';
import { matchGlossaryTerms, type GlossaryEntry } from '../src/lib/vocabulary-glossary';
const entries: GlossaryEntry[] = ['in order to', 'order', 'rain', 'look for'].map(term => ({
  id: term, term, aliases: term === 'look for' ? ['looking for', 'looked for'] : [],
  meaning: '', definition: '', level: '', examples: [], relatedIds: [],
}));
test('glossary links longest phrases and inflections without altering a sentence', () => {
  const text = 'In order to avoid rain, we looked for shelter.';
  const parts = matchGlossaryTerms(text, entries);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.entryId).map(part => part.entryId), ['in order to', 'rain', 'look for']);
  assert.equal(matchGlossaryTerms('in  order\nto', entries)[0].entryId, 'in order to');
});
test('glossary does not link partial words, possessives, or words inside compounds', () => {
  const text = "rainfall, trained, rain's, order-based, rain.";
  assert.deepEqual(matchGlossaryTerms(text, entries).filter(part => part.entryId).map(part => part.text), ['rain']);
  assert.deepEqual(matchGlossaryTerms('hello', []), [{ text: 'hello' }]);
});
