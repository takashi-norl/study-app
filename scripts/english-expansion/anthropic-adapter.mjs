import Anthropic from '@anthropic-ai/sdk';
import { hashContent } from './schema.mjs';

// Verified against the official pricing page. A later launch must refresh this
// policy explicitly; a model name alone is not evidence of its current price.
export const PRICING_POLICY = Object.freeze({ schemaVersion: 1, provider: 'anthropic', model: 'claude-sonnet-5-5',
  inputUsdPerMillion: 2, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 0.10,
  verifiedAt: '2026-10-24T00:00:00.000Z', maximumAgeDays: 7,
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  maxCountedInputTokens: 25000, maxInputTokens: 50000, maxOutputTokens: 20000, transport: 'messages-sync-no-retry', serviceTier: 'standard_only', inferenceGeo: 'global' });
export const PRICING_POLICY_SHA256 = hashContent(PRICING_POLICY);
const roundUp = value => Math.ceil(value * 1e6 - 1e-8) / 1e6;
const tokens = (value, name) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid ${name} usage.`); return value; };
export function assertPricingFresh(now = new Date()) {
  const elapsed = new Date(now).getTime() - Date.parse(PRICING_POLICY.verifiedAt);
  if (!Number.isFinite(elapsed) || elapsed < -86400000 || elapsed > PRICING_POLICY.maximumAgeDays * 86400000) throw new Error('Model pricing verification is stale; review official prices before sending.');
}
export function validateProviderParams(params) {
  const allowed = new Set(['model', 'max_tokens', 'system', 'messages', 'output_config', 'service_tier', 'inference_geo']);
  if (!params || Object.keys(params).some(key => !allowed.has(key)) || params.model !== PRICING_POLICY.model || params.service_tier !== 'standard_only' || params.inference_geo !== 'global' || !Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > PRICING_POLICY.maxOutputTokens) throw new Error('Unsupported provider parameters or unverified model.');
  if (!params.output_config?.format || params.output_config.format.type !== 'json_schema' || !['low', 'medium'].includes(params.output_config.effort) || Object.keys(params.output_config).some(key => !['effort', 'format'].includes(key))) throw new Error('Reviewed structured-output and effort settings are required.');
  if (typeof params.system !== 'string' || params.messages?.length !== 1 || params.messages[0].role !== 'user' || typeof params.messages[0].content !== 'string' || JSON.stringify(params).length > 2_000_000) throw new Error('Unexpected provider prompt structure.');
  // No prompt caching or external tools in the bounded pilot.
  if (JSON.stringify(params).includes('"cache_control"')) throw new Error('Cache-write requests are not enabled in this pricing policy.');
  return params;
}
export function quoteInput(params, inputTokens, now = new Date()) {
  validateProviderParams(params); assertPricingFresh(now);
  const measured = tokens(inputTokens, 'counted input'), reservedInputTokens = PRICING_POLICY.maxInputTokens;
  if (!measured || measured > PRICING_POLICY.maxCountedInputTokens) throw new Error('Input exceeds the reviewed pilot token bound.');
  // Reserve the entire 50k input ceiling, while only accepting counted prompts
  // up to 25k. This pilot prioritizes a generous bound over maximal concurrency.
  return { schemaVersion: 1, paramsSha256: hashContent(params), pricingPolicySha256: PRICING_POLICY_SHA256,
    countedInputTokens: measured, reservedInputTokens, reservedOutputTokens: params.max_tokens,
    reservedUsd: roundUp((reservedInputTokens * PRICING_POLICY.inputUsdPerMillion + params.max_tokens * PRICING_POLICY.outputUsdPerMillion) / 1e6) };
}
export function priceResponse(response) {
  if (!response || response.type !== 'message' || response.model !== PRICING_POLICY.model) throw new Error('Provider response has an unverified model or type.');
  const usage = response.usage;
  if (!usage || (usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.server_tool_use?.web_search_requests ?? 0) !== 0 || (usage.server_tool_use?.web_fetch_requests ?? 0) !== 0 || (usage.service_tier && usage.service_tier !== 'standard') || (usage.speed && usage.speed !== 'standard') || (usage.inference_geo && usage.inference_geo !== 'global')) throw new Error('Unsupported usage requires manual billing reconciliation.');
  const input = tokens(usage.input_tokens, 'input'), output = tokens(usage.output_tokens, 'output'), cached = tokens(usage.cache_read_input_tokens ?? 0, 'cached input');
  // output_tokens already includes hidden reasoning: never add thinking_tokens again.
  return roundUp((input * PRICING_POLICY.inputUsdPerMillion + cached * PRICING_POLICY.cacheReadUsdPerMillion + output * PRICING_POLICY.outputUsdPerMillion) / 1e6);
}
/** Constructing this object performs no network operation. Credentials stay in memory. */
export function createAnthropicAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, client, now = () => new Date() } = {}) {
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) throw new Error('ANTHROPIC_API_KEY is required in the private process environment.');
  const sdk = client ?? new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 180000 });
  return Object.freeze({ mode: client ? 'mock-sdk' : 'anthropic', pricingPolicySha256: PRICING_POLICY_SHA256,
    async quote(params) {
      validateProviderParams(params); assertPricingFresh(now());
      let model, measured;
      try {
        model = await sdk.models.retrieve(PRICING_POLICY.model);
        if (model.id !== PRICING_POLICY.model) throw new Error();
        // count_tokens does not accept max_tokens. Keep the actual schema/effort.
        const { max_tokens: _maxTokens, service_tier: _tier, inference_geo: _geo, ...input } = params;
        measured = await sdk.messages.countTokens(input);
      } catch { throw new Error('Provider model/token preflight failed; no generation request was sent.'); }
      return quoteInput(params, measured.input_tokens, now());
    },
    async request(params) {
      validateProviderParams(params); assertPricingFresh(now());
      try { return await sdk.messages.create(params); }
      catch { throw new Error('Provider submission did not return a complete response; preserve its reservation.'); }
    },
    price: priceResponse,
  });
}
