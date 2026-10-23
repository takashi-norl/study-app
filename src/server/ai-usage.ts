import 'server-only';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AiFeature, AiUsageSummary, AiUsageTotals } from '@/lib/ai-usage';
import type { Profile } from '@/lib/types';
import { ApiError, requiredEnv, requireGenerationEnabled } from './config';
import { appendEvent, type StudyEvent } from './google-store';
import { aiRequestedSchema, aiUsageSchema, type AiRequested, type AiUsage } from './ai-usage-schema';

export const AI_PRICING_AS_OF = '2026-10-23';
export const AI_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
type Price = { input: number; output: number; read: number; longContextThreshold?: number; longInput?: number; longOutput?: number };
// First-party standard rates per million tokens, checked against the official page above.
// Explicit model IDs only: a future/unknown alias must never silently inherit an old price.
const prices: Record<string, Price> = Object.create(null);
function priced(ids: string[], input: number, output: number, read = input / 10) {
  for (const id of ids) prices[id] = { input, output, read };
}
priced(['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-5', 'claude-opus-4-5-20251101'], 5, 25);
priced(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], 3, 15);
priced(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], 1, 5);
priced(['claude-sonnet-5'], 2, 10);
priced(['claude-sonnet-5-5'], 2, 10, 0.1);
priced(['claude-opus-5-5'], 4, 20, 0.2);
priced(['claude-fable-5', 'claude-mythos-5'], 10, 50);
priced(['claude-fable-5-1', 'claude-mythos-5-1'], 10, 50, 0.25);
priced(['claude-haiku-5-5'], 0.1, 0.5, 0.01);
prices['claude-haiku-5-5'] = { ...prices['claude-haiku-5-5'], longContextThreshold: 100_000, longInput: 0.5, longOutput: 2.5 };

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const optionalCount = (value: unknown): number | null => value == null ? 0 : count(value);
type UsageLike = Partial<Anthropic.Messages.Usage> | null | undefined;

/** Keep provider counts, including cache tokens, even when the price cannot be determined. */
export function priceAnthropicUsage(model: string, usage: UsageLike): Pick<AiUsage,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens' | 'cacheWriteUnknownTokens' | 'estimatedUsd' | 'unknownReason' | 'pricingAsOf'> {
  const inputTokens = count(usage?.input_tokens), outputTokens = count(usage?.output_tokens);
  const cacheReadTokens = optionalCount(usage?.cache_read_input_tokens);
  const cacheWrite5mTokens = optionalCount(usage?.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = optionalCount(usage?.cache_creation?.ephemeral_1h_input_tokens);
  const cacheTotal = optionalCount(usage?.cache_creation_input_tokens);
  const cacheWriteUnknownTokens = cacheTotal !== null && cacheWrite5mTokens !== null && cacheWrite1hTokens !== null
    ? Math.max(0, cacheTotal - cacheWrite5mTokens - cacheWrite1hTokens) : null;
  const result = { inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, cacheWriteUnknownTokens,
    pricingAsOf: AI_PRICING_AS_OF, estimatedUsd: null as number | null, unknownReason: null as AiUsage['unknownReason'] };
  if (!usage || inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheWrite5mTokens === null
    || cacheWrite1hTokens === null || cacheWriteUnknownTokens === null || (cacheTotal !== null && cacheTotal < cacheWrite5mTokens + cacheWrite1hTokens)) {
    return { ...result, unknownReason: 'usage-unavailable' };
  }
  const price = prices[model];
  if (!price) return { ...result, unknownReason: 'unknown-model' };
  if (cacheWriteUnknownTokens > 0) return { ...result, unknownReason: 'cache-duration-unknown' };
  // These features are not used by this app. Do not pretend standard token prices cover them.
  if ((usage.service_tier && usage.service_tier !== 'standard') || (usage.speed && usage.speed !== 'standard')
    || Object.values(usage.server_tool_use ?? {}).some(value => typeof value === 'number' && value > 0)
    || (usage.inference_geo && !['global', 'us'].includes(usage.inference_geo))) return { ...result, unknownReason: 'unsupported-billing' };
  const totalInput = inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens;
  // Legacy 4.5 long-context rates have changed over time; leave those exceptional calls unpriced.
  if (model.startsWith('claude-sonnet-4-5') && totalInput > 200_000) return { ...result, unknownReason: 'unsupported-billing' };
  const long = price.longContextThreshold !== undefined && totalInput > price.longContextThreshold;
  const inputRate = long ? price.longInput! : price.input, outputRate = long ? price.longOutput! : price.output;
  const readRate = long ? inputRate / 10 : price.read;
  const geoMultiplier = usage.inference_geo === 'us' ? 1.1 : 1;
  const cost = (inputTokens * inputRate + outputTokens * outputRate + cacheReadTokens * readRate
    + cacheWrite5mTokens * inputRate * 1.25 + cacheWrite1hTokens * inputRate * 2) / 1_000_000 * geoMultiplier;
  return { ...result, estimatedUsd: Math.round(cost * 1e10) / 1e10 };
}

export interface AiCallContext { actorId: string; feature: AiFeature; requestId: string; samplePreview?: boolean }
/** Question batches and explicitly marked 3-question previews get a bounded longer deadline. */
export function anthropicRequestPolicy(feature: AiFeature, samplePreview=false): { timeout: number; maxRetries: number } {
  return { timeout: feature === 'question-generation' || (feature==='planning' && samplePreview) ? 180_000 : 90_000, maxRetries: 0 };
}
/** Allowlisted operational metadata only; never include provider messages, bodies, headers, or prompts. */
export function aiFailureDiagnostic(feature: AiFeature, invocationId: string, error: unknown, samplePreview=false): {
  feature: AiFeature; invocationId: string; kind: 'timeout' | 'connection' | 'provider' | 'unexpected'; timeoutMs: number; httpStatus?: number;
} {
  const kind = error instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
    : error instanceof Anthropic.APIConnectionError ? 'connection'
    : error instanceof Anthropic.APIError ? 'provider' : 'unexpected';
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  return { feature, invocationId, kind, timeoutMs: anthropicRequestPolicy(feature,samplePreview).timeout,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  };
}
type MessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
export interface AiCallDependencies {
  append: (event: StudyEvent) => Promise<void>;
  create: (params: MessageParams) => Promise<Anthropic.Messages.Message>;
}

/** Record a receipt before spending and usage before parsing/validating model output. No paid retries. */
export async function trackedAnthropicMessage(context: AiCallContext, params: MessageParams,
  dependencies?: AiCallDependencies): Promise<Anthropic.Messages.Message> {
  let deps = dependencies;
  if (!deps) {
    requireGenerationEnabled();
    const client = new Anthropic({ apiKey: requiredEnv('ANTHROPIC_API_KEY'), ...anthropicRequestPolicy(context.feature,context.samplePreview) });
    deps = { append: appendEvent, create: async input => client.messages.create(input) };
  }
  const requested = aiRequestedSchema.parse({ invocationId: randomUUID(), requestId: context.requestId,
    feature: context.feature, model: params.model });
  const event = (type: 'ai.requested' | 'ai.usage', payload: AiRequested | AiUsage): StudyEvent => ({
    id: `${type}:${requested.invocationId}`, type, actorId: context.actorId, createdAt: new Date().toISOString(), payload,
  });
  // If this fails, no provider request is made. An unfinished receipt means unknown cost, not zero.
  await deps.append(event('ai.requested', requested));
  let response: Anthropic.Messages.Message;
  try { response = await deps.create(params); } catch (error) {
    console.error('AI provider call failed', aiFailureDiagnostic(context.feature, requested.invocationId, error,context.samplePreview));
    const failed: AiUsage = { ...requested, responseId: null, status: 'failed', ...priceAnthropicUsage(params.model, null), unknownReason: 'request-failed' };
    try { await deps.append(event('ai.usage', aiUsageSchema.parse(failed))); } catch { /* The durable receipt still marks this as unresolved. */ }
    throw error;
  }
  const usage = aiUsageSchema.parse({ ...requested, model: response.model, responseId: response.id, status: 'complete',
    ...priceAnthropicUsage(response.model, response.usage) });
  try { await deps.append(event('ai.usage', usage)); } catch {
    throw new ApiError(502, 'AIの処理結果を保存できませんでした。接続を確認してからお試しください。', 'AI_RECORD_FAILED');
  }
  return response;
}

const monthInJapan = (date: string | Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(date)).slice(0, 7);
const emptyTotals = (): AiUsageTotals => ({ requests: 0, completed: 0, failed: 0, unresolved: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0, unknownCostRequests: 0 });
type Receipt = { actorId: string; createdAt: string; request: AiRequested; usage?: AiUsage };
function totals(receipts: Receipt[]): AiUsageTotals {
  const result = emptyTotals();
  const seenResponses = new Set<string>();
  for (const receipt of receipts) {
    result.requests += 1;
    const usage = receipt.usage;
    if (!usage) { result.unresolved += 1; result.unknownCostRequests += 1; continue; }
    if (usage.status === 'failed') result.failed += 1; else result.completed += 1;
    // Replayed response receipts must not count the same provider usage twice.
    if (usage.responseId && seenResponses.has(usage.responseId)) continue;
    if (usage.responseId) seenResponses.add(usage.responseId);
    result.inputTokens += usage.inputTokens ?? 0;
    result.outputTokens += usage.outputTokens ?? 0;
    result.cacheReadTokens += usage.cacheReadTokens ?? 0;
    result.cacheWriteTokens += (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0) + (usage.cacheWriteUnknownTokens ?? 0);
    if (usage.estimatedUsd === null) result.unknownCostRequests += 1; else result.estimatedUsd += usage.estimatedUsd;
  }
  result.estimatedUsd = Math.round(result.estimatedUsd * 1e10) / 1e10;
  return result;
}

/** Return aggregates only. The route checks the verified Super User session before loading events. */
export function summarizeAiUsage(events: StudyEvent[], profiles: Profile[], now = new Date()): AiUsageSummary {
  const receipts = new Map<string, Receipt>();
  const seenEvents = new Set<string>();
  const unique = events.filter(event => { if (seenEvents.has(event.id)) return false; seenEvents.add(event.id); return true; });
  for (const event of unique) {
    if (event.type === 'ai.requested') {
      const request = aiRequestedSchema.parse(event.payload);
      if (!receipts.has(request.invocationId)) receipts.set(request.invocationId, { actorId: event.actorId, createdAt: event.createdAt, request });
    }
  }
  for (const event of unique) {
    if (event.type !== 'ai.usage') continue;
    const usage = aiUsageSchema.parse(event.payload), receipt = receipts.get(usage.invocationId);
    if (receipt && receipt.actorId === event.actorId && receipt.request.requestId === usage.requestId && receipt.request.feature === usage.feature && !receipt.usage) receipt.usage = usage;
  }
  const all = [...receipts.values()], month = monthInJapan(now), monthly = all.filter(receipt => monthInJapan(receipt.createdAt) === month);
  const audio = unique.filter(event => event.type === 'audio.requested' && monthInJapan(event.createdAt) === month);
  const audioReady = new Set(unique.filter(event => event.type === 'audio.ready').map(event => event.payload.requestToken));
  const audioFailed = new Set(unique.filter(event => event.type === 'audio.failed').map(event => event.payload.requestToken));
  const ready = audio.filter(event => audioReady.has(event.payload.requestToken)).length;
  const failed = audio.filter(event => !audioReady.has(event.payload.requestToken) && audioFailed.has(event.payload.requestToken)).length;
  return { currency: 'USD', estimated: true, trackingSince: all.map(receipt => receipt.createdAt).sort()[0] ?? null,
    pricingAsOf: AI_PRICING_AS_OF, pricingUrl: AI_PRICING_URL, month, monthly: totals(monthly), allTime: totals(all),
    byFeature: (['source-analysis', 'question-generation', 'planning', 'profile'] as const).map(feature => ({ feature, usage: totals(monthly.filter(receipt => receipt.request.feature === feature)) })),
    byUser: [...new Set(monthly.map(receipt => receipt.actorId))].map(userId => ({ userId, name: profiles.find(profile => profile.id === userId)?.name ?? '退会した利用者', usage: totals(monthly.filter(receipt => receipt.actorId === userId)) })),
    elevenLabs: { requests: audio.length, characters: audio.reduce((sum, event) => sum + event.payload.characters, 0), ready, failed, unresolved: audio.length - ready - failed, estimatedUsd: null },
    notes: ['記録開始後にこのアプリが使ったClaude APIの概算です。導入前・別のアプリ・税金・割引は含みません。請求額はClaudeの管理画面で確認できます。',
      '未確定のリクエストや料金表にないモデルは金額に含めず、件数を別に表示します。失敗やタイムアウトでも課金の可能性があるため、0ドルとは扱いません。',
      'ElevenLabsは今月の作成依頼数と文字数です。失敗・未完了の依頼も含みます。契約プランの料金が不明なため金額は計算していません。'] };
}

/** Operational totals contain no participant identity or individual activity breakdown. */
export function summarizeOperationalAiUsage(events: StudyEvent[], now = new Date()): AiUsageSummary {
  return { ...summarizeAiUsage(events, [], now), byUser: [] };
}
