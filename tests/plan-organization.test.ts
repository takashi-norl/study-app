import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangementScopeSummary, normalizePlanTags } from '../src/lib/plan-organization';

test('new-plan tags normalize once without changing the input or the project label', () => {
  const input = [' 2学期中間テスト ', '古文', '2学期中間テスト'];
  assert.deepEqual(normalizePlanTags(input), ['2学期中間テスト', '古文']);
  assert.deepEqual(input, [' 2学期中間テスト ', '古文', '2学期中間テスト']);
  assert.deepEqual(normalizePlanTags([]), []);
  assert.deepEqual(normalizePlanTags(Array(64).fill('試験')), ['試験']);
  assert.equal(normalizePlanTags(['名'.repeat(40)])[0].length, 40);
});

test('new-plan tags reject whitespace, incorrect types and values outside the stored limits', () => {
  for (const input of [[''], ['  '], ['名'.repeat(41)], Array.from({ length: 9 }, (_, i) => `試験${i}`),
    Array(65).fill('試験'), '試験', null, [123], ['試験', null]]) {
    assert.throws(() => normalizePlanTags(input));
  }
});

test('arrangement scope covers unique points beyond sample excerpts and explicitly limits coverage', () => {
  const summary = arrangementScopeSummary({ description: '2学期の古文。助動詞から現代語訳まで。' }, [
    { learningPoint: '助動詞' }, { learningPoint: ' 助動詞 ' }, { learningPoint: '敬語' }, { learningPoint: '現代語訳' },
  ]);
  assert.match(summary, /元の問題4問/);
  assert.match(summary, /3 \/ 3項目/);
  assert.match(summary, /・現代語訳/);
  assert.match(summary, /助動詞から現代語訳まで/);
  assert.match(summary, /参考3問だけの学習項目に限定せず/);
  assert.match(summary, /試験範囲全体を網羅した資料ではありません/);
  assert.match(summary, /不足する条件を推測せず/);
});

test('scope summary bounds long descriptions and many learning points to 2000 characters', () => {
  const summary = arrangementScopeSummary({ description: '詳'.repeat(10000) }, Array.from({ length: 300 }, (_, i) => ({ learningPoint: `項目${i}${'長'.repeat(1000)}` })));
  assert.ok(summary.length <= 2000);
  assert.match(summary, /\/ 300項目の抜粋/);
  assert.match(summary, /本文がない箇所や不足する条件を推測せず/);
  assert.match(arrangementScopeSummary({ description: '' }, [{ learningPoint: ' ' }]), /学習ポイントの記載はありません/);
});

test('an exam range of 25 short vocabulary entries is retained in full within the scope budget', () => {
  const points = Array.from({ length: 25 }, (_, index) => ({ learningPoint: `古文単語${index + 26}` }));
  const summary = arrangementScopeSummary({ description: '試験範囲は26〜50' }, points);
  assert.match(summary, /25 \/ 25項目/);
  for (const point of points) assert.ok(summary.includes(`・${point.learningPoint}`));
  assert.ok(summary.length <= 2000);
  const capped = arrangementScopeSummary({ description: '' }, Array.from({ length: 80 }, (_, index) => ({ learningPoint: `語${index}` })));
  assert.match(capped, /40 \/ 80項目の抜粋/);
});
