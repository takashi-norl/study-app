import Anthropic from '@anthropic-ai/sdk';
import { hashContent } from './schema.mjs';
import { CHEAP_PRICING, assertCheapPricingFresh, validateCheapParams, quoteCheapInput, priceCheapResponse } from './cheap-benchmark-provider.mjs';

// v4 prices stay immutable. The new policy binds the explicit thinking setting,
// but neither adds a new allowance nor discounts the historical v4 outcome.
export const ONE_PHRASE_PRICING = Object.freeze({ ...CHEAP_PRICING, promptVersion: 'v5',
  generation: { ...CHEAP_PRICING.generation, thinking: { type: 'disabled' }, effort: 'medium' },
  thinkingSource: 'https://platform.claude.com/docs/en/build-with-claude/thinking' });
export const ONE_PHRASE_PRICING_SHA256 = hashContent(ONE_PHRASE_PRICING);
export const assertOnePhrasePricingFresh = assertCheapPricingFresh;

export function validateOnePhraseParams(params, stage) {
  if (stage === 'generation') {
    if (!params?.thinking || Object.keys(params.thinking).length !== 1 || params.thinking.type !== 'disabled') throw Error('The v5 generation requires exactly thinking:{type:disabled}.');
    const { thinking: _thinking, ...unchanged } = params;
    validateCheapParams(unchanged, stage);
  } else {
    // The optional review retains Sonnet high and its existing adaptive policy.
    validateCheapParams(params, stage);
  }
  return params;
}
export function quoteOnePhraseInput(params, stage, countedInputTokens, now = new Date()) {
  validateOnePhraseParams(params, stage);
  const { thinking: _thinking, ...unchanged } = params;
  const quote = quoteCheapInput(unchanged, stage, countedInputTokens, now);
  return { ...quote, paramsSha256: hashContent(params), pricingPolicySha256: ONE_PHRASE_PRICING_SHA256 };
}
export const priceOnePhraseResponse = priceCheapResponse;

export function createOnePhraseBenchmarkAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, client, now = () => new Date() } = {}) {
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) throw Error('ANTHROPIC_API_KEY is required in the private process environment.');
  const sdk = client ?? new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 180000 });
  return {
    async quote(params, stage) {
      validateOnePhraseParams(params, stage); assertOnePhrasePricingFresh(now());
      try {
        const model = await sdk.models.retrieve(params.model); if (model.id !== params.model) throw Error();
        const { max_tokens: _max, service_tier: _tier, inference_geo: _geo, ...input } = params;
        const measured = await sdk.messages.countTokens(input);
        return quoteOnePhraseInput(params, stage, measured.input_tokens, now());
      } catch { throw Error('Benchmark preflight failed; no generation or review was sent.'); }
    },
    async request(params, stage) {
      validateOnePhraseParams(params, stage); assertOnePhrasePricingFresh(now());
      try { return await sdk.messages.create(params); }
      catch { throw Error('Benchmark submission outcome is unknown; retain the full reservation.'); }
    },
  };
}
