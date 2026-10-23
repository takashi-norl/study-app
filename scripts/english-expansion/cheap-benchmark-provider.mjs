import Anthropic from '@anthropic-ai/sdk';
import { hashContent } from './schema.mjs';
import { validateProviderParams as validateSonnet, priceResponse as priceSonnet, quoteInput as quoteSonnet } from './anthropic-adapter.mjs';

export const CHEAP_PRICING = Object.freeze({ schemaVersion: 1, verifiedAt: '2026-10-24T00:00:00+09:00', maximumAgeDays: 7,
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  generation: { model: 'claude-haiku-5-5', inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.50, countedInputCeiling: 50000, reservedInputCeiling: 100000, maxOutputTokens: 16000 },
  review: { model: 'claude-sonnet-5-5', inputUsdPerMillion: 2, outputUsdPerMillion: 10, countedInputCeiling: 25000, reservedInputCeiling: 50000, maxOutputTokens: 8000 },
  serviceTier: 'standard_only', inferenceGeo: 'global', transport: 'messages-sync-no-retry', cache: 'disabled' });
export const CHEAP_PRICING_SHA256 = hashContent(CHEAP_PRICING);
const up = value => Math.ceil(value * 1e6 - 1e-8) / 1e6;
const token = (n, name) => { if (!Number.isSafeInteger(n) || n < 0) throw Error(`Invalid ${name} token usage.`); return n; };
export function assertCheapPricingFresh(now = new Date()) {
  const age = new Date(now).getTime() - Date.parse(CHEAP_PRICING.verifiedAt);
  if (!Number.isFinite(age) || age < -86400000 || age > CHEAP_PRICING.maximumAgeDays * 86400000) throw Error('Benchmark price verification is stale.');
}
export function validateCheapParams(params, stage) {
  const policy = CHEAP_PRICING[stage];
  if (!policy || !params || params.model !== policy.model || params.max_tokens !== policy.maxOutputTokens) throw Error('Benchmark model/output bound differs from its reviewed stage.');
  // Keep the unchanged Sonnet structural policy, substituting only the explicitly priced model for validation.
  validateSonnet({ ...params, model: CHEAP_PRICING.review.model });
  if (params.output_config.effort !== (stage === 'generation' ? 'medium' : 'high')) throw Error('Benchmark effort differs from its exact policy.');
  return params;
}
export function quoteCheapInput(params, stage, countedInputTokens, now = new Date()) {
  validateCheapParams(params, stage); assertCheapPricingFresh(now);
  const policy = CHEAP_PRICING[stage], counted = token(countedInputTokens, 'counted input');
  if (!counted || counted > policy.countedInputCeiling) throw Error('Counted input exceeds the benchmark bound.');
  if (stage === 'review') quoteSonnet(params, countedInputTokens, now); // Preserve the existing Sonnet freshness/tier constraints.
  return { schemaVersion: 1, paramsSha256: hashContent(params), pricingPolicySha256: CHEAP_PRICING_SHA256, stage,
    countedInputTokens: counted, reservedInputTokens: policy.reservedInputCeiling, reservedOutputTokens: policy.maxOutputTokens,
    reservedUsd: up((policy.reservedInputCeiling * policy.inputUsdPerMillion + policy.maxOutputTokens * policy.outputUsdPerMillion) / 1e6) };
}
export function priceCheapResponse(response, stage) {
  const policy = CHEAP_PRICING[stage];
  if (!policy || response?.type !== 'message' || response.model !== policy.model) throw Error('Unverified benchmark response model.');
  const usage = response.usage;
  if (!usage || (usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.cache_read_input_tokens ?? 0) !== 0
    || (usage.server_tool_use?.web_search_requests ?? 0) !== 0 || (usage.server_tool_use?.web_fetch_requests ?? 0) !== 0
    || (usage.service_tier && usage.service_tier !== 'standard') || (usage.speed && usage.speed !== 'standard')
    || (usage.inference_geo && usage.inference_geo !== 'global')) throw Error('Unrecognized benchmark usage requires accounting review.');
  const input = token(usage.input_tokens, 'input'), output = token(usage.output_tokens, 'output');
  if (input > policy.reservedInputCeiling || output > policy.maxOutputTokens) throw Error('Actual tokens exceed the reserved pricing tier or output bound.');
  if (stage === 'review') return priceSonnet(response);
  // output_tokens already includes thinking_tokens. No second reasoning charge.
  return up((input * policy.inputUsdPerMillion + output * policy.outputUsdPerMillion) / 1e6);
}
export function createCheapBenchmarkAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, client, now = () => new Date() } = {}) {
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) throw Error('ANTHROPIC_API_KEY is required in the private process environment.');
  const sdk = client ?? new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 180000 });
  return { async quote(params, stage) {
    validateCheapParams(params, stage); assertCheapPricingFresh(now());
    try {
      const model = await sdk.models.retrieve(params.model); if (model.id !== params.model) throw Error();
      const { max_tokens: _max, service_tier: _tier, inference_geo: _geo, ...input } = params;
      const measured = await sdk.messages.countTokens(input);
      return quoteCheapInput(params, stage, measured.input_tokens, now());
    } catch { throw Error('Benchmark preflight failed; no generation or review was sent.'); }
  }, async request(params, stage) {
    validateCheapParams(params, stage); assertCheapPricingFresh(now());
    try { return await sdk.messages.create(params); }
    catch { throw Error('Benchmark submission outcome is unknown; retain the full reservation.'); }
  } };
}
