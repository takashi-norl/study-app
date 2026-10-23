import assert from 'node:assert/strict';
import test from 'node:test';
import { getVerbAliases, getVerbForms } from '../src/lib/verb-forms';

test('dictionary separates past and participle, including irregular and unchanged forms', () => {
  const take = getVerbForms('take')!;
  assert.deepEqual(take.past, ['took']);
  assert.deepEqual(take.pastParticiple, ['taken']);
  assert.deepEqual(take.presentParticiple, ['taking']);
  assert.deepEqual(take.thirdPersonSingular, ['takes']);
  assert.deepEqual(getVerbForms('come')!.pastParticiple, ['come']);
  assert.deepEqual(getVerbAliases('read'), ['reading', 'reads']);
  assert.match(getVerbForms('read')!.note!, /riːd.*red/);
});

test('checked spellings include consonant doubling, y changes and US/UK variants', () => {
  assert.deepEqual(getVerbForms('admit')!.past, ['admitted']);
  assert.deepEqual(getVerbForms('admit')!.presentParticiple, ['admitting']);
  assert.deepEqual(getVerbForms('justify')!.past, ['justified']);
  assert.deepEqual(getVerbForms('justify')!.thirdPersonSingular, ['justifies']);
  assert.deepEqual(getVerbForms('justify')!.presentParticiple, ['justifying']);
  assert.deepEqual(getVerbForms('begin')!.presentParticiple, ['beginning']);
  assert.deepEqual(getVerbForms('label')!.pastParticiple, ['labeled', 'labelled']);
  assert.deepEqual(getVerbForms('focus')!.presentParticiple, ['focusing', 'focussing']);
});

test('phrases retain their full meaning and every conjugation links to one entry', () => {
  assert.deepEqual(getVerbForms('take part in')!.pastParticiple, ['taken part in']);
  assert.deepEqual(getVerbForms('make a mistake')!.past, ['made a mistake']);
  assert.deepEqual(getVerbForms('be able to')!.past, ['was able to', 'were able to']);
  assert.deepEqual(getVerbForms('be worried about')!.pastParticiple, ['been worried about']);
  assert.ok(getVerbAliases('be able to').includes('am able to'));
  assert.ok(getVerbAliases('be able to').includes('are able to'));
  const aliases = getVerbAliases('focus on');
  assert.equal(new Set(aliases).size, aliases.length);
  assert.ok(aliases.includes('focussed on'));
  assert.ok(!aliases.includes('focus on'));
});

test('unregistered verbs and dictionary objects are never guessed', () => {
  for (const unknown of ['run', 'happiness', 'look away', '__proto__', 'constructor']) {
    assert.equal(getVerbForms(unknown), undefined);
    assert.deepEqual(getVerbAliases(unknown), []);
  }
});
