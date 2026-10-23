import Anthropic from '@anthropic-ai/sdk';
import { scopeQuote, scopePrice, SCOPE_PRICING_SHA256 } from './reviewed-scope-provider.mjs';
import { hashContent } from './schema.mjs';
import { assertPricingFresh, PRICING_POLICY, priceResponse, quoteInput, validateProviderParams } from './anthropic-adapter.mjs';

export const BATCH_POLICY = Object.freeze({ schemaVersion: 1, model: PRICING_POLICY.model, discount: 0.5,
  maxRequests: 40, unitsPerRequest: 5, maxPayloadBytes: 16_000_000,
  verifiedAt: '2026-10-24T00:00:00.000Z', source: 'https://platform.claude.com/docs/en/build-with-claude/batch-processing',
  nonBilledTerminalResults: ['errored', 'canceled', 'expired'], noAutomaticResubmission: true });
export const BATCH_POLICY_SHA256 = hashContent(BATCH_POLICY);
const round = value => Math.ceil(value * 1e6 - 1e-8) / 1e6;
export function quoteBatchInput(params, inputTokens, now) {
  const standard = quoteInput(params, inputTokens, now);
  return { ...standard, standardReservedUsd: standard.reservedUsd, reservedUsd: round(standard.reservedUsd * 0.5), batchPolicySha256: BATCH_POLICY_SHA256 };
}
export function priceBatchResult(item) {
  if (!item?.result || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.custom_id ?? '')) throw new Error('Invalid exact batch result identity.');
  if (item.result.type === 'succeeded') return round(priceResponse(item.result.message) * 0.5);
  if (BATCH_POLICY.nonBilledTerminalResults.includes(item.result.type)) return 0;
  throw new Error('Unrecognized batch outcome; its full reservation must remain.');
}
export function validateBatchRequests(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 40 || new Set(requests.map(row => row.custom_id)).size !== requests.length
    || Buffer.byteLength(JSON.stringify({ requests })) > BATCH_POLICY.maxPayloadBytes) throw new Error('Batch is outside the reviewed 1–40 request bound.');
  for (const row of requests) {
    if (Object.keys(row).some(key => !['custom_id', 'params'].includes(key)) || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.custom_id ?? '')) throw new Error('Invalid batch request identity.');
    validateProviderParams(row.params);
  }
  return requests;
}
export function createBatchAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, client, now = () => new Date() } = {}) {
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) throw new Error('Private ANTHROPIC_API_KEY is required.');
  const sdk = client ?? new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 180000 });
  let modelVerified = false;
  return Object.freeze({ mode: client ? 'mock-sdk' : 'anthropic-batch', policySha256: BATCH_POLICY_SHA256,
    async quote(params) {
      validateProviderParams(params); assertPricingFresh(now());
      try {
        if (!modelVerified) { const model = await sdk.models.retrieve(PRICING_POLICY.model); if (model.id !== PRICING_POLICY.model) throw new Error(); modelVerified = true; }
        const { max_tokens: _max, service_tier: _tier, inference_geo: _geo, ...input } = params;
        const result = await sdk.messages.countTokens(input); return quoteBatchInput(params, result.input_tokens, now());
      } catch { throw new Error('Batch model/token preflight failed; no batch was submitted.'); }
    },
    ...batchTransport(sdk, validateBatchRequests, now),
    price: priceBatchResult,
  });
}

function batchTransport(sdk, validate, now) { return {
    async create(requests) {
      validate(requests); assertPricingFresh(now());
      try { return await sdk.messages.batches.create({ requests }); }
      catch { throw new Error('Batch submission outcome is unknown. Never resubmit automatically.'); }
    },
    async retrieve(id) {
      if (!/^msgbatch_[a-zA-Z0-9]+$/.test(id)) throw new Error('Invalid saved provider batch ID.');
      try { return await sdk.messages.batches.retrieve(id); }
      catch { throw new Error('Read-only batch status failed; retry collection without resubmitting.'); }
    },
    async results(id) {
      if (!/^msgbatch_[a-zA-Z0-9]+$/.test(id)) throw new Error('Invalid saved provider batch ID.');
      try { return await sdk.messages.batches.results(id); }
      catch { throw new Error('Read-only result stream failed; retry collection without resubmitting.'); }
    },
  }; }
export const AUTHOR_EDITOR_BATCH_POLICY_SHA256=hashContent({base:BATCH_POLICY_SHA256,scoped:SCOPE_PRICING_SHA256,author:'claude-haiku-5-5',editor:'claude-sonnet-5-5',editorEffort:'medium',editorThinking:'adaptive',editorMaxTokens:12000,discount:0.5});
export const batchOperation=params=>params?.model==='claude-haiku-5-5'?'author':params?.model==='claude-sonnet-5-5'?'editor':null;
export function quoteAuthorEditorBatch(params,inputTokens=1){const operation=batchOperation(params);let standard;if(operation==='author')standard=scopeQuote(params,operation,inputTokens);else{if(operation!=='editor'||params.max_tokens!==12000||params.output_config?.effort!=='medium'||hashContent(params.thinking)!==hashContent({type:'adaptive'}))throw Error('Exact medium adaptive editor policy required.');const {thinking:_thinking,...rest}=params;standard={...quoteInput(rest,inputTokens),paramsSha256:hashContent(params)};}return{...standard,standardReservedUsd:standard.reservedUsd,reservedUsd:round(standard.reservedUsd*0.5),batchPolicySha256:AUTHOR_EDITOR_BATCH_POLICY_SHA256};}
export function validateAuthorEditorBatchRequests(requests){if(!Array.isArray(requests)||!requests.length||requests.length>40||new Set(requests.map(r=>r.custom_id)).size!==requests.length||Buffer.byteLength(JSON.stringify({requests}))>BATCH_POLICY.maxPayloadBytes)throw Error('Batch is outside the reviewed 1–40 request bound.');for(const row of requests){if(Object.keys(row).some(k=>!['custom_id','params'].includes(k))||! /^[a-zA-Z0-9_-]{1,64}$/.test(row.custom_id??''))throw Error('Invalid batch request identity.');quoteAuthorEditorBatch(row.params);}if(new Set(requests.map(r=>batchOperation(r.params))).size!==1)throw Error('One author or editor stage per batch.');return requests;}
export function priceAuthorEditorBatchResult(item){if(!item?.result||! /^[a-zA-Z0-9_-]{1,64}$/.test(item.custom_id??''))throw Error('Invalid exact batch result identity.');if(item.result.type==='succeeded'){if(batchOperation(item.result.message)==='editor'&&item.result.message.usage?.output_tokens>12000)throw Error('Editor output exceeded its exact ceiling.');return round(scopePrice(item.result.message,batchOperation(item.result.message))*0.5);}if(BATCH_POLICY.nonBilledTerminalResults.includes(item.result.type))return 0;throw Error('Unrecognized batch outcome; retain its reservation.');}
export function createAuthorEditorBatchAdapter({apiKey=process.env.ANTHROPIC_API_KEY,client,now=()=>new Date()}={}) {
 if(!client&&(!apiKey||typeof apiKey!=='string'))throw Error('Private ANTHROPIC_API_KEY is required.');
 const sdk=client??new Anthropic({apiKey,baseURL:'https://api.anthropic.com',maxRetries:0,timeout:180000}),models=new Set();
 return Object.freeze({mode:client?'mock-sdk':'anthropic-batch',policySha256:AUTHOR_EDITOR_BATCH_POLICY_SHA256,
 async quote(params){quoteAuthorEditorBatch(params);assertPricingFresh(now());try{if(!models.has(params.model)){const model=await sdk.models.retrieve(params.model);if(model.id!==params.model)throw Error();models.add(params.model);}const{max_tokens:_max,service_tier:_tier,inference_geo:_geo,...input}=params;const counted=await sdk.messages.countTokens(input);return quoteAuthorEditorBatch(params,counted.input_tokens);}catch{throw Error('Batch model/token preflight failed; no batch submitted.');}},
 ...batchTransport(sdk,validateAuthorEditorBatchRequests,now),price:priceAuthorEditorBatchResult});
}
