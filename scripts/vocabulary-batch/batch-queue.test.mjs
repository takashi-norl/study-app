import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planningProvider, submitBatch } from './batches.mjs';

test('bounded batch submits waiting reviews before alphabetically earlier new generation', async () => {
  const output = await mkdtemp(join(tmpdir(), 'hibi-batch-queue-'));
  try {
    const plan = planningProvider(output);
    const input = { system: 'test', prompt: 'test', toolName: 'test', schema: { type: 'object', properties: {} }, maxTokens: 100 };
    for (const id of ['generate-a', 'generate-b', 'review-z', 'review-a']) {
      await assert.rejects(plan(id, input), error => error.code === 'BATCH_QUEUED');
    }
    let selected;
    await submitBatch(output, { maxRequests: 2, client: { messages: {
      countTokens: async () => ({ input_tokens: 10 }),
      batches: { create: async ({ requests }) => {
        selected = requests.map(request => request.custom_id);
        return { id: 'msgbatch-review-first', processing_status: 'in_progress' };
      } },
    } } });
    assert.deepEqual(selected, ['review-a', 'review-z']);
  } finally { await rm(output, { recursive: true, force: true }); }
});
