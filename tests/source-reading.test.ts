import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceReadingLoader, parseSourceReadingResponse, type SourceReading } from '../src/lib/source-reading';

const reading = (text: string, sourceId = 'source'): SourceReading => ({ sourceId, revision: `revision:${text}`,
  analysis: { text, learningPoints: ['古文単語'], uncertainties: ['末尾が不鮮明'] }, reviewed: true, updatedAt: '2026-10-23T00:00:00Z' });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

test('closing and reopening a source cannot apply an older late response over the new reading or draft', async () => {
  for (const finishOldFirst of [true, false]) {
    const old = deferred(), fresh = deferred();
    let count = 0;
    const loader = createSourceReadingLoader(async () => (++count === 1 ? old.promise : fresh.promise));
    const previousLoad = loader.load('source');
    loader.cancel();
    const currentLoad = loader.load('source');
    if (finishOldFirst) {
      old.resolve(response(reading('古い内容')));
      assert.deepEqual(await previousLoad, { status: 'superseded' }, 'must not clear the current loading state');
    }
    fresh.resolve(response(reading('新しい内容')));
    assert.deepEqual(await currentLoad, { status: 'loaded', reading: reading('新しい内容') });
    if (!finishOldFirst) {
      old.resolve(response(reading('古い内容')));
      assert.deepEqual(await previousLoad, { status: 'superseded' }, 'must not overwrite edits started after the fresh load');
    }
  }
});

test('cancelled and unmounted loaders ignore a fetch implementation that does not honor abort', async () => {
  const pending = deferred();
  const loader = createSourceReadingLoader(async () => pending.promise);
  const result = loader.load('source');
  loader.cancel();
  pending.resolve(response(reading('表示しない内容')));
  assert.deepEqual(await result, { status: 'superseded' });
});

test('a response for another photo or a malformed success never enters editable state', async () => {
  for (const body of [null, {}, reading('別の教材', 'another-source'), { ...reading('本文'), revision: undefined },
    { ...reading('本文'), analysis: { text: '本文', learningPoints: '配列ではない', uncertainties: [] } }]) {
    await assert.rejects(parseSourceReadingResponse(response(body), 'source'));
  }
  const loader = createSourceReadingLoader(async () => response(reading('別の教材', 'another-source')));
  assert.equal((await loader.load('source')).status, 'failed');
  assert.deepEqual(await parseSourceReadingResponse(response({ sourceId: 'source', revision: null, analysis: null, reviewed: false }), 'source'),
    { sourceId: 'source', revision: null, analysis: null, reviewed: false });
});

test('source reading errors retain the standard API message and a timed-out load can be retried', async () => {
  for (const error of ['別画面で変更されました', { message: '別画面で変更されました' }]) {
    await assert.rejects(parseSourceReadingResponse(response({ error, code: 'SOURCE_ANALYSIS_CONFLICT' }, 409), 'source'), /別画面で変更/);
  }
  let count = 0;
  const loader = createSourceReadingLoader(async (_url, options) => {
    if (++count > 1) return response(reading('読み直した内容'));
    return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }, 5);
  const timedOut = await loader.load('source');
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.status === 'failed' ? timedOut.message : '', /取得が完了しません/);
  assert.equal((await loader.load('source')).status, 'loaded');
});
