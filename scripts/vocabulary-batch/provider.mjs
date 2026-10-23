import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { join } from 'node:path';
import { atomicJson, readJson } from './storage.mjs';
import { hashVocabularyEntry } from './schema.mjs';

export const PRICES = { 'claude-sonnet-4-6': { input: 3, output: 15 }, 'claude-haiku-4-5-20251001': { input: 1, output: 5 }, 'claude-sonnet-5-5': { input: 2, output: 10 }, 'claude-haiku-5-5': { input: 0.1, output: 0.5, maximumInput: 100000 } };
export const HARD_TEXT_CAP_USD = 100;
export function reserveBudget(ledger, id, reservedUsd, budgetUsd = HARD_TEXT_CAP_USD) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > HARD_TEXT_CAP_USD) throw new Error('Text budget must be greater than 0 and at most100USD.');
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) throw new Error('Invalid call reservation.');
  if (ledger.calls.some(call => call.id === id)) throw new Error(`Duplicate paid request identity: ${id}`);
  if (ledger.calls.some(call => !['complete', 'batch_pending'].includes(call.status) || (call.status === 'batch_pending' && (!call.providerBatchId || !call.submissionId || call.billing !== 'batch-50-percent')))) throw new Error('An earlier provider request has an unresolved outcome. No further spending is allowed until its saved result is recovered.');
  const spent = ledger.calls.reduce((sum, call) => sum + (call.status === 'complete' ? call.actualUsd : call.reservedUsd), 0);
  if (!Number.isFinite(spent) || spent + reservedUsd > budgetUsd + 1e-9) throw new Error(`Text budget stop: spent$${spent.toFixed(3)}, next maximum$${reservedUsd.toFixed(3)}, cap$${budgetUsd.toFixed(2)}.`);
  return { spent, remaining: budgetUsd - spent - reservedUsd };
}
export function responseCost(response) {
  const price = PRICES[response.model], usage = response.usage;
  if (!price || !usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) || usage.input_tokens < 0 || usage.output_tokens < 0) throw new Error('Provider usage or model cannot be priced; request remains unresolved.');
  const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
  if (![read, write].every(value => Number.isSafeInteger(value) && value >= 0) || write) throw new Error('Unsupported cached billing; request remains unresolved.');
  if (price.maximumInput && usage.input_tokens + read + write > price.maximumInput) throw new Error('Provider usage exceeded the configured model input price tier; request remains unresolved.');
  return (usage.input_tokens * price.input + usage.output_tokens * price.output + read * price.input / 10) / 1_000_000;
}
export function structuredResult(response, toolName) {
  const invalid = message => Object.assign(new Error(message), { code: 'INVALID_STRUCTURED_RESULT' });
  if (response.stop_reason === 'max_tokens') throw invalid('Provider output was truncated. Saved raw output remains available; no automatic paid retry.');
  const block = response.content.find(item => item.type === 'tool_use' && item.name === toolName);
  if (block) return block.input;
  const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('');
  try { const data = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw invalid('Provider did not return the requested structured result.'); }
}
export function messageParams(model, { system, prompt, toolName, schema, maxTokens }) {
  if (model.endsWith('-5-5')) {
    const params = { model, max_tokens: maxTokens, system: `${system}\nFor this request return only the JSON object matching the output schema; no tool call.`, messages: [{ role: 'user', content: prompt }], output_config: { effort: toolName === 'review_vocabulary' ? 'medium' : 'low', format: jsonSchemaOutputFormat(schema) } };
    // Haiku 5.5 otherwise spends the shared output limit on adaptive thinking,
    // even at low effort. Disable it only for inventory; keep authored content
    // and independent review settings (and their saved request hashes) intact.
    // https://platform.claude.com/docs/en/build-with-claude/thinking#turning-thinking-off
    if (model === 'claude-haiku-5-5' && toolName === 'inventory_words') params.thinking = { type: 'disabled' };
    return params;
  }
  return { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }], tools: [{ name: toolName, description: 'Return original vocabulary learning assets in the required structure.', input_schema: schema }], tool_choice: { type: 'tool', name: toolName } };
}
export function tokenCountParams(params) { const { max_tokens: _maxTokens, ...rest } = params; return rest; }
export function createProvider(output, { model = 'claude-sonnet-4-6', budgetUsd = 100, apiKey = process.env.ANTHROPIC_API_KEY, client } = {}) {
  if (!PRICES[model]) throw new Error(`Model has no configured conservative price: ${model}`);
  if (!client && !apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Supply it in the environment; never put it in a command argument or a saved asset.');
  const sdk = client ?? new Anthropic({ apiKey, maxRetries: 0, timeout: 180_000 });
  return async function request(id, { system, prompt, toolName, schema, maxTokens }) {
    if (!/^[a-z0-9-]{1,160}$/.test(id) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 20000) throw new Error('Invalid provider request identity/output limit.');
    const ledgerPath = join(output, 'ledger.json'), rawPath = join(output, 'raw', `${id}.json`);
    const params = messageParams(model, { system, prompt, toolName, schema, maxTokens });
    const requestHash = hashVocabularyEntry(params);
    const ledger = await readJson(ledgerPath, { schemaVersion: 1, calls: [] });
    let previous = ledger.calls.find(call => call.id === id);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Error(`Saved request${id} has different inputs. Use a new explicit revision; do not silently spend twice.`);
      const raw = await readJson(rawPath, null);
      if (raw && raw.requestHash === requestHash && raw.id === id) {
        const actualUsd = responseCost(raw.response);
        if (previous.status !== 'complete') { Object.assign(previous, { status: 'complete', actualUsd, completedAt: new Date().toISOString(), recovered: true }); await atomicJson(ledgerPath, ledger); }
        return structuredResult(raw.response, toolName);
      }
      throw new Error(`Request${id} already sent but raw result is missing. Do not retry an uncertain paid request.`);
    }
    // Token counting is not a generation request. A count failure stops before spending.
    let count;
    try { count = await sdk.messages.countTokens(tokenCountParams(params)); }
    catch { throw new Error('Input token counting failed. No generation request was sent; check provider access/balance.'); }
    if (!Number.isSafeInteger(count.input_tokens) || count.input_tokens < 0) throw new Error('Could not bound input tokens.');
    if (PRICES[model].maximumInput && Math.ceil(count.input_tokens * 1.01) + 32 > PRICES[model].maximumInput) throw new Error('Input would exceed this model’s explicitly priced context tier; no generation request sent.');
    // A 1% input margin covers token-count variation. maxTokens reserves all
    // output, including any model thinking; prompt caching is not enabled.
    const reservedUsd = ((Math.ceil(count.input_tokens * 1.01) + 32) * PRICES[model].input + maxTokens * PRICES[model].output) / 1_000_000;
    reserveBudget(ledger, id, reservedUsd, budgetUsd);
    previous = { id, requestHash, model, status: 'requested', reservedUsd, requestedAt: new Date().toISOString() };
    ledger.calls.push(previous); await atomicJson(ledgerPath, ledger);
    let response;
    try { response = await sdk.messages.create(params); }
    catch (error) { previous.status = 'uncertain'; previous.errorKind = error?.name ?? 'provider-error'; await atomicJson(ledgerPath, ledger); throw new Error(`Provider request${id} failed or timed out; outcome is uncertain. Stopped without retry. See ledger.json.`); }
    // Persist the original response before validation, pricing or transformation.
    await atomicJson(rawPath, { schemaVersion: 1, id, requestHash, response, savedAt: new Date().toISOString() });
    const actualUsd = responseCost(response);
    Object.assign(previous, { status: 'complete', actualUsd, completedAt: new Date().toISOString() });
    await atomicJson(ledgerPath, ledger);
    if (actualUsd > reservedUsd + 1e-9) throw new Error('Reported charge exceeded the reservation. Raw result saved; stop and inspect the pricing assumption.');
    return structuredResult(response, toolName);
  };
}
