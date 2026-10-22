import assert from 'node:assert/strict';
import test from 'node:test';
import { englishChoiceSpeechText, englishSpeechText, speechChunks } from '../src/lib/speech';

test('reading an English question excludes Japanese instructions and preserves contractions and sentence punctuation', () => {
  const result = englishSpeechText('次の英文を読みなさい。「I don’t know why she left. Can you explain?」空欄に当てはまるものを選ぶ。');
  assert.equal(result, 'I don’t know why she left. Can you explain?');
  assert.equal(englishSpeechText('「abundant」の意味として最も適切なものを選びなさい。'), 'abundant.');
  assert.equal(englishSpeechText('次の選択肢 A、B、C、D から選ぶ。'), '');
  assert.equal(englishSpeechText('助動詞「けり」の意味は？'), '');
});

test('audio leaves a visible blank unfilled, reads choices independently, and omits URLs', () => {
  assert.equal(englishSpeechText('He ____ to school every day. 空欄を埋めよ。'), 'He blank to school every day.');
  assert.equal(englishChoiceSpeechText('a'), 'a');
  assert.equal(englishChoiceSpeechText('I'), 'I');
  assert.equal(englishChoiceSpeechText('A. take care of'), 'take care of.');
  assert.equal(englishChoiceSpeechText('豊富な'), '');
  assert.equal(englishSpeechText('参照 https://example.com/private-page'), '');
});

test('mobile utterance chunks keep the complete passage in order with bounded length', () => {
  const text = 'Her first attempt was unsuccessful, but she continued to work steadily. '.repeat(12).trim();
  const chunks = speechChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 240));
  assert.equal(chunks.join(' '), text);
  assert.deepEqual(speechChunks(''), []);
  assert.throws(() => speechChunks('hello', 0));
});
