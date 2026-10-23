import { HISTORICAL_COST_POLICY_SHA256 } from './historical-costs.mjs';
import { hashContent, unitIdFor } from './schema.mjs';
import { PRICING_POLICY } from './anthropic-adapter.mjs';
export const seed = lemma => ({ id: unitIdFor('word', lemma), kind: 'word', lemma, aliases: [], primaryCollection: 'eiken-1', level: { cefrEstimate: 'C1', eikenEstimates: ['grade1'], policy: 'estimated-not-official' }, genres: ['general'], register: 'neutral', audience: { suitableFor: 'teens-and-adults', noteJa: '一般的な文脈で使えます。' }, pitfalls: [{ kind: 'meaning', noteJa: '文脈と語義を確認します。' }] });
export function generatedContent(target) {
  const choices = [target.lemma, 'fragile', 'irrelevant', 'temporary'].map(text => ({ text, meaningJa: '選択肢の意味', feedbackJa: '文脈と語義を確認します。' }));
  return { unitId: target.id, partOfSpeech: 'adjective', meaningEn: 'Able to recover after difficulties.', meaningJa: '困難から回復できる', examples: [
    'The team remained resilient after the loss.', 'She became more resilient with practice.', 'The town has a resilient community.'
  ].map(text => ({ text, meaningJa: '例文の日本語訳', contextJa: '困難からの回復' })), tests: ['meaning', 'word', 'context', 'usage'].map(mode => ({ mode, prompt: mode === 'context' ? 'The team remained ___.' : 'resilientに合う答えは？', choices, correctIndex: 0, explanationJa: '困難から回復する文脈に合います。', alternatives: [] })), relations: [] };
}
export const response = payload => ({ type: 'message', model: PRICING_POLICY.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(payload) }], usage: { input_tokens: 100, output_tokens: 1000, thinking_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

export function historicalReceiptFixture() {
  const audit = { schemaVersion: 1, observedAt: '2026-10-24T00:00:00.000Z', source: 'read-only-app-event-log',
    claude: { requests: 44, completed: 41, failed: 3, estimatedUsd: 2.739465, unknownCostRequests: 3 },
    audio: { requests: 104, charactersRequested: 31091 },
    unknown: Array.from({ length: 3 }, (_, i) => ({ invocationId: `synthetic-prior-failure-${i}`, model: 'claude-sonnet-4-6', status: 'failed', reason: 'request-failed', at: '2026-10-22T00:00:00.000Z', inputTokens: null, outputTokens: null })) };
  const coverage = { schemaVersion: 1, id: 'test-only-coverage', createdBy: 'test-auditor', createdAt: audit.observedAt, sourceAuditSha256: hashContent(audit), currency: 'USD',
    knownTextActualUsd: 2.739465, priorTextAllowanceUsd: 40, priorAudioAllowanceUsd: 11, audioCharacters: 31091, audioConservativeRateUsdPer1000: 0.33,
    allowanceIsInvoice: false, automaticallyReleasable: false, currentCashPurchasePreTaxUsd: 100, currentCashPurchaseProvider: 'elevenlabs',
    pricingSources: ['https://platform.claude.com/docs/en/models/sonnet-4-6/overview'],
    failedTextCalls: audit.unknown.map(row => ({ invocationId: row.invocationId, model: row.model, outcome: 'failed-usage-unknown', reservedUsd: 8, mayRetry: false })) };
  return { schemaVersion: 1, kind: 'bounded-historical-project-costs', policySha256: HISTORICAL_COST_POLICY_SHA256,
    textUsd: 40, audioUsd: 11, releasePolicy: 'never-automatic', reviewedBy: 'test-only-cost-reviewer', reviewedAt: '2026-10-24T00:00:00.000Z', audit, auditSha256: hashContent(audit), coverage, coverageSha256: hashContent(coverage) };
}
