import assert from 'node:assert/strict';
import test from 'node:test';
import { selectVocabularyAudio } from '../src/lib/vocabulary-playback';
import type { VocabularyAudio } from '../src/lib/vocabulary-types';
const clip = (url: string, wordId = 'avoid'): VocabularyAudio => ({
  wordId, url, voiceLabel: url, state: 'ready',
  segments: [{ id: 'word', startSeconds: 0, endSeconds: 1 }, { id: 'example-1', startSeconds: 2, endSeconds: 7 }],
});

test('random playback chooses only ready versions of the current word and requested segment', () => {
  const clips = [clip('/a.mp3'), clip('/b.mp3'), clip('/wrong.mp3', 'afford'), { ...clip('/pending.mp3'), state: 'pending' as const }];
  assert.equal(selectVocabularyAudio(clips, 'avoid', 'word', () => 0)?.url, '/a.mp3');
  assert.equal(selectVocabularyAudio(clips, 'avoid', 'example-1', () => 0.99)?.url, '/b.mp3');
  assert.equal(selectVocabularyAudio(clips, 'avoid', 'example-2'), undefined);
  assert.equal(selectVocabularyAudio(clips, 'nonexistent', 'word'), undefined);
});

test('duplicates do not bias voices and a single recording never needs another generation', () => {
  const clips = [clip('/a.mp3'), clip('/a.mp3'), clip('/b.mp3')];
  assert.equal(selectVocabularyAudio(clips, 'avoid', 'word', () => 0.5)?.url, '/b.mp3');
  assert.equal(selectVocabularyAudio([clip('/a.mp3')], 'avoid', 'word', () => { throw new Error('No random draw needed'); })?.url, '/a.mp3');
});

test('invalid segment ranges and absent files cannot become playback candidates', () => {
  const invalid = [clip(''), { ...clip('/reversed'), segments: [{ id: 'word', startSeconds: 2, endSeconds: 1 }] },
    { ...clip('/nan'), segments: [{ id: 'word', startSeconds: NaN, endSeconds: 1 }] }];
  assert.equal(selectVocabularyAudio(invalid, 'avoid', 'word'), undefined);
});
