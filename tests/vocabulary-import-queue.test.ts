import assert from 'node:assert/strict';
import test from 'node:test';
import { runVocabularyImportQueue } from '../src/lib/vocabulary-import-queue';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers<void>();

function harness(items: string[]) {
  const responses = new Map(items.map(key => [key, deferred()]));
  const commits = new Map(items.map(key => [key, deferred()]));
  const calls: string[] = [], active = new Set<string>(), durable = new Set<string>();
  let receipts: Record<string, string> = {}, peak = 0, stopped = false;
  const options = {
    items,
    cacheKey: (key: string) => key,
    isCommitted: (key: string) => durable.has(key),
    shouldStop: () => stopped,
    perform: async (key: string) => {
      calls.push(key); active.add(key); peak = Math.max(peak, active.size);
      try {
        await responses.get(key)!.promise;
        // Same merge order as the component: a validated response is retained
        // for download immediately; admission waits for its durable receipt too.
        receipts = { ...receipts, [key]: `receipt-${key}` };
        await commits.get(key)!.promise;
        durable.add(key);
      } finally { active.delete(key); }
    },
  };
  return { options, responses, commits, calls, active, durable, pause: () => { stopped = true; }, resume: () => { stopped = false; }, receipts: () => receipts, peak: () => peak };
}

test('two uploads finish out of order without losing receipts; a slot includes persistence', async () => {
  const job = harness(['a', 'b', 'c', 'd']);
  const done = runVocabularyImportQueue(job.options);
  assert.deepEqual(job.calls, ['a', 'b']);
  job.responses.get('b')!.resolve(); await tick();
  assert.deepEqual(job.receipts(), { b: 'receipt-b' });
  assert.deepEqual(job.calls, ['a', 'b'], 'a response alone must not release a slot');
  job.commits.get('b')!.resolve(); await tick();
  assert.deepEqual(job.calls, ['a', 'b', 'c']);
  job.responses.get('a')!.resolve(); job.commits.get('a')!.resolve(); await tick();
  assert.deepEqual(job.calls, ['a', 'b', 'c', 'd']);
  for (const key of ['d', 'c']) { job.responses.get(key)!.resolve(); job.commits.get(key)!.resolve(); }
  await done;
  assert.equal(job.peak(), 2);
  assert.deepEqual(Object.keys(job.receipts()).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...job.durable].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(job.active.size, 0);
});

test('first unknown upload failure stops admission and drains the other response and receipt before rejection', async () => {
  const job = harness(['a', 'b', 'c', 'd']);
  const failure = new Error('network outcome unknown');
  let settled = false;
  const result = runVocabularyImportQueue(job.options).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  job.responses.get('b')!.reject(failure); await tick();
  assert.equal(settled, false);
  assert.deepEqual(job.calls, ['a', 'b']);
  job.responses.get('a')!.resolve(); await tick();
  assert.equal(settled, false, 'a successful in-flight response still needs its receipt commit');
  assert.deepEqual(job.calls, ['a', 'b']);
  job.commits.get('a')!.resolve();
  assert.equal(await result, failure);
  assert.deepEqual([...job.durable], ['a']);
  assert.deepEqual(job.calls, ['a', 'b'], 'no automatic retry and no later clip');
  assert.deepEqual(job.receipts(), { a: 'receipt-a' });
});

test('pause drains both uploads; explicit resume skips committed receipts', async () => {
  const job = harness(['a', 'b', 'c', 'd']);
  let settled = false;
  const paused = runVocabularyImportQueue(job.options).then(() => { settled = true; });
  job.pause();
  job.responses.get('b')!.resolve(); job.commits.get('b')!.resolve(); await tick();
  assert.equal(settled, false);
  assert.deepEqual(job.calls, ['a', 'b']);
  job.responses.get('a')!.resolve(); job.commits.get('a')!.resolve();
  await paused;
  assert.deepEqual([...job.durable].sort(), ['a', 'b']);
  job.resume();
  const resumed = runVocabularyImportQueue(job.options);
  assert.deepEqual(job.calls, ['a', 'b', 'c', 'd']);
  for (const key of ['c', 'd']) { job.responses.get(key)!.resolve(); job.commits.get(key)!.resolve(); }
  await resumed;
  assert.equal(job.calls.filter(key => key === 'a').length, 1);
  assert.equal(job.calls.filter(key => key === 'b').length, 1);
  assert.equal(job.durable.size, 4);
});

test('cache keys are attempted once per job, including duplicate items in later bundles', async () => {
  const attemptedKeys = new Set<string>(), calls: string[] = [], active = new Set<string>();
  const options = {
    attemptedKeys,
    cacheKey: (key: string) => key,
    isCommitted: () => false,
    shouldStop: () => false,
    perform: async (key: string) => {
      assert.equal(active.has(key), false, 'same cache key must never be in flight twice');
      active.add(key); calls.push(key);
      await tick(); active.delete(key);
    },
  };
  await runVocabularyImportQueue({ ...options, items: ['a', 'a', 'b', 'a', 'b'] });
  await runVocabularyImportQueue({ ...options, items: ['a', 'c', 'b', 'c'] });
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('duplicate failed keys are not retried within a job', async () => {
  const calls: string[] = [], failure = new Error('unconfirmed upload');
  await assert.rejects(runVocabularyImportQueue({
    items: ['a', 'a', 'b', 'a', 'c'], cacheKey: key => key,
    isCommitted: () => false, shouldStop: () => false,
    perform: async key => { calls.push(key); if (key === 'a') throw failure; await tick(); },
  }), error => error === failure);
  assert.equal(calls.filter(key => key === 'a').length, 1);
  assert.deepEqual(calls, ['a', 'b']);
});

test('receipt storage failure preserves both successful responses, drains, and stops later uploads', async () => {
  const job = harness(['a', 'b', 'c']);
  const failure = new Error('receipt storage unavailable');
  const result = runVocabularyImportQueue(job.options).then(() => null, error => error);
  job.responses.get('a')!.resolve(); await tick();
  job.commits.get('a')!.reject(failure); await tick();
  job.responses.get('b')!.resolve(); job.commits.get('b')!.resolve();
  assert.equal(await result, failure);
  assert.deepEqual(job.receipts(), { a: 'receipt-a', b: 'receipt-b' });
  assert.deepEqual([...job.durable], ['b']);
  assert.deepEqual(job.calls, ['a', 'b']);
});

test('a pre-existing pause admits no upload, and committed keys are skipped before work', async () => {
  const calls: string[] = [];
  const options = { items: ['a', 'b'], cacheKey: (key: string) => key,
    isCommitted: (key: string) => key === 'a', perform: async (key: string) => { calls.push(key); } };
  await runVocabularyImportQueue({ ...options, shouldStop: () => true });
  assert.deepEqual(calls, []);
  await runVocabularyImportQueue({ ...options, shouldStop: () => false });
  assert.deepEqual(calls, ['b']);
});
