import Anthropic from '@anthropic-ai/sdk';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readJson } from './storage.mjs';
import { hashVocabularyEntry } from './schema.mjs';
import { HARD_TEXT_CAP_USD, PRICES, messageParams, tokenCountParams, responseCost, structuredResult } from './provider.mjs';

export class BatchQueued extends Error { constructor(id) { super(`Queued${id}for batch submission.`); this.code = 'BATCH_QUEUED'; } }
export const MAX_BATCH_REQUESTS = 500;
async function files(directory) { try { return (await readdir(directory)).filter(file => file.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
export function planningProvider(output, model = 'claude-sonnet-4-6') {
  if (!PRICES[model]) throw new Error('Unknown batch model price.');
  return async (id, input) => {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('Batch custom IDs must be1–64safe characters.');
    // SDK structured-output helpers carry an enumerable parse callback. Hash only the JSON wire payload.
    const sdkParams = messageParams(model, input), params = JSON.parse(JSON.stringify(sdkParams)), requestHash = hashVocabularyEntry(params);
    const ledger = await readJson(join(output, 'ledger.json'), { calls: [] });
    const previous = ledger.calls.find(item => item.id === id);
    const raw = await readJson(join(output, 'raw', `${id}.json`), null);
    if (raw) {
      if (!previous || raw.requestHash !== requestHash || previous.requestHash !== requestHash || previous.status !== 'complete') throw new Error(`Saved batch request${id}requires reconciliation before reuse.`);
      return structuredResult(raw.response, input.toolName);
    }
    if (previous) throw new Error(`Request${id}already submitted. Collect its results before preparing more.`);
    const path = join(output, 'prepared', `${id}.json`), old = await readJson(path, null);
    if (old && old.requestHash !== requestHash) {
      // Repair only an unsent receipt whose exact serialized request is unchanged.
      if (old.requestHash !== hashVocabularyEntry(sdkParams) || hashVocabularyEntry(old.params) !== requestHash) throw new Error(`Prepared request${id}has different inputs.`);
      await atomicJson(path, { ...old, legacyRequestHash: old.requestHash, requestHash });
    }
    if (!old) await atomicJson(path, { schemaVersion: 1, id, requestHash, params, preparedAt: new Date().toISOString() });
    throw new BatchQueued(id);
  };
}
function clientOr(client) {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 180000 });
}
/** One submitted batch at a time. Atomically reserve ALL request ceilings before a paid create. */
export async function submitBatch(output, { budgetUsd = 100, maxRequests = MAX_BATCH_REQUESTS, client } = {}) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > HARD_TEXT_CAP_USD || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_BATCH_REQUESTS) throw new Error('Invalid batch budget/request limit (maximum500 requests).');
  const sdk = clientOr(client), ledgerPath = join(output, 'ledger.json');
  const ledger = await readJson(ledgerPath, { schemaVersion: 1, calls: [] });
  if (ledger.calls.some(item => item.status !== 'complete')) throw new Error('Collect or reconcile the outstanding provider request before another paid submission.');
  const known = new Set(ledger.calls.map(item => item.id));
  const candidates = [];
  for (const file of await files(join(output, 'prepared'))) {
    const candidate = await readJson(join(output, 'prepared', file));
    if (!known.has(candidate.id)) candidates.push(candidate);
    if (candidates.length >= maxRequests) break;
  }
  if (!candidates.length) return { submitted: 0 };
  const spent = ledger.calls.reduce((sum, item) => sum + item.actualUsd, 0);
  if (!Number.isFinite(spent)) throw new Error('Ledger contains unknown costs.');
  const selected = []; let totalReservedUsd = 0;
  for (const item of candidates) {
    const params = item.params, price = PRICES[params.model];
    if (!price || hashVocabularyEntry(params) !== item.requestHash || !/^[a-z0-9-]{1,64}$/.test(item.id) || params.max_tokens > 20000 || params.max_tokens < 1) throw new Error('Prepared batch request failed validation.');
    let count;
    try { count = await sdk.messages.countTokens(tokenCountParams(params)); }
    catch { throw new Error('Batch token-count preflight failed. No batch was submitted.'); }
    if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0) throw new Error('Unusable input token count.');
    if (price.maximumInput && Math.ceil(count.input_tokens * 1.01) + 32 > price.maximumInput) throw new Error('Input would exceed this model’s explicitly priced context tier; no batch submitted.');
    const reservedUsd = ((Math.ceil(count.input_tokens * 1.01) + 32) * price.input + params.max_tokens * price.output) / 1_000_000 * 0.5;
    if (spent + totalReservedUsd + reservedUsd > budgetUsd) break;
    selected.push({ ...item, reservedUsd }); totalReservedUsd += reservedUsd;
  }
  if (!selected.length) throw new Error('Text budget cannot reserve even one next batch request. No batch was submitted.');
  const submissionId = `batch-${hashVocabularyEntry(selected.map(item => item.id)).slice(0, 24)}`;
  const submissionPath = join(output, 'batches', `${submissionId}.json`);
  if (await readJson(submissionPath, null)) throw new Error('This exact batch submission already has a receipt. Do not send it again.');
  const submission = { schemaVersion: 1, id: submissionId, status: 'requested', requestIds: selected.map(item => item.id), totalReservedUsd, requestedAt: new Date().toISOString() };
  await atomicJson(submissionPath, submission);
  ledger.calls.push(...selected.map(item => ({ id: item.id, requestHash: item.requestHash, model: item.params.model, status: 'requested', billing: 'batch-50-percent', reservedUsd: item.reservedUsd, submissionId, requestedAt: submission.requestedAt })));
  await atomicJson(ledgerPath, ledger);
  let response;
  try { response = await sdk.messages.batches.create({ requests: selected.map(item => ({ custom_id: item.id, params: item.params })) }); }
  catch {
    submission.status = 'uncertain'; await atomicJson(submissionPath, submission);
    for (const item of ledger.calls.filter(item => item.submissionId === submissionId)) item.status = 'uncertain';
    await atomicJson(ledgerPath, ledger);
    throw new Error('Batch create outcome is uncertain. Reservations retained; no automatic retry. Reconcile in the provider console.');
  }
  // Batch ID must be saved immediately; result collection can safely be retried afterwards.
  submission.providerBatchId = response.id; submission.status = 'submitted'; submission.providerStatus = response.processing_status;
  await atomicJson(submissionPath, submission);
  for (const item of ledger.calls.filter(item => item.submissionId === submissionId)) Object.assign(item, { status: 'batch_pending', providerBatchId: response.id });
  await atomicJson(ledgerPath, ledger);
  return { submitted: selected.length, providerBatchId: response.id, totalReservedUsd, submissionId };
}

/** Read-only provider operations; each successful raw response is written before validation or use. */
export async function collectBatches(output, { client } = {}) {
  const sdk = clientOr(client), summaries = [];
  for (const name of await files(join(output, 'batches'))) {
    const path = join(output, 'batches', name), submission = await readJson(path);
    if (submission.status === 'complete') continue;
    if (!submission.providerBatchId) throw new Error(`Submission${submission.id}has no saved provider ID. Do not resubmit; reconcile provider outcome.`);
    let metadata;
    try { metadata = await sdk.messages.batches.retrieve(submission.providerBatchId); }
    catch { throw new Error('Could not read batch status. No new generation request was sent; collect may be retried.'); }
    if (metadata.processing_status !== 'ended') {
      // A confirmed provider batch has a bounded reservation, not an unknown outcome.
      const pendingLedgerPath = join(output, 'ledger.json'), pendingLedger = await readJson(pendingLedgerPath);
      for (const item of pendingLedger.calls.filter(item => item.submissionId === submission.id && item.status === 'requested')) Object.assign(item, { status: 'batch_pending', providerBatchId: submission.providerBatchId });
      await atomicJson(pendingLedgerPath, pendingLedger);
      summaries.push({ id: submission.id, status: metadata.processing_status, counts: metadata.request_counts }); continue;
    }
    const ledgerPath = join(output, 'ledger.json'), ledger = await readJson(ledgerPath);
    const expected = new Set(submission.requestIds), received = new Set();
    let stream;
    try { stream = await sdk.messages.batches.results(submission.providerBatchId); }
    catch { throw new Error('Could not open completed batch results. No new generation request was sent; collect may be retried.'); }
    try {
      for await (const item of stream) {
        if (!expected.has(item.custom_id) || received.has(item.custom_id)) throw new Error('Batch results contain an unknown or duplicate request.');
        received.add(item.custom_id);
        const receipt = ledger.calls.find(call => call.id === item.custom_id && call.submissionId === submission.id);
        if (!receipt) throw new Error('No matching durable request reservation.');
        await atomicJson(join(output, 'batch-results', `${item.custom_id}.json`), item);
        if (item.result.type !== 'succeeded') {
          // Keep the reservation until a human/explicit reconciliation establishes the final charge.
          receipt.status = 'uncertain'; receipt.providerOutcome = item.result.type;
          await atomicJson(ledgerPath, ledger); continue;
        }
        const response = item.result.message;
        await atomicJson(join(output, 'raw', `${item.custom_id}.json`), { schemaVersion: 1, id: item.custom_id, requestHash: receipt.requestHash, response, savedAt: new Date().toISOString(), providerBatchId: submission.providerBatchId });
        const actualUsd = responseCost(response) * 0.5;
        if (actualUsd > receipt.reservedUsd + 1e-9) throw new Error('Batch actual cost exceeds its maximum reservation; stop and reconcile pricing.');
        Object.assign(receipt, { status: 'complete', actualUsd, completedAt: new Date().toISOString() });
        await atomicJson(ledgerPath, ledger);
      }
    } catch { throw new Error('Batch collection interrupted or failed integrity checks. Saved results are retained. Collect may be retried without a new generation request.'); }
    if (received.size !== expected.size) throw new Error('Completed batch is missing results. Collect may be retried.');
    submission.status = ledger.calls.filter(item => item.submissionId === submission.id).every(item => item.status === 'complete') ? 'complete' : 'unresolved';
    submission.collectedAt = new Date().toISOString(); await atomicJson(path, submission);
    summaries.push({ id: submission.id, status: submission.status, results: received.size });
  }
  return summaries;
}
