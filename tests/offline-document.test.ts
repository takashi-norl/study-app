import assert from 'node:assert/strict';
import test from 'node:test';
import { offlineDocument } from '../src/lib/offline-document';

test('offline fallback identifies TEST and never sends the learner to a production origin', () => {
  const staging = offlineDocument(true), production = offlineDocument(false);
  assert.match(staging, /<title>ひび学習 TEST/);
  assert.match(staging, /aria-label="検証環境"/);
  assert.match(staging, /href="\/"/);
  assert.doesNotMatch(staging, /https?:\/\/|<script|http-equiv="refresh"/);
  assert.doesNotMatch(production, /TEST|検証環境/);
  assert.match(production, /<title>ひび学習 — 接続を確認/);
});
