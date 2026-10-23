import { hashContent } from './schema.mjs';

/** An operator-reviewed planning allowance, never a provider invoice or settled usage. */
export const HISTORICAL_COST_POLICY = Object.freeze({
  schemaVersion: 1, id: 'prior-app-20261024-fixed-allowance-v1',
  textUsd: 40, audioUsd: 11, releasePolicy: 'never-automatic', noRetryAuthority: true,
  knownAppTextEstimateUsd: 2.739465, historicalFailedRequests: 3, perFailedRequestCeilingUsd: 8,
  audioCharacters: 31091, audioUsdPerThousandCharacters: 0.33,
  bounds: { model: 'claude-sonnet-4-6', maxInputTokens: 1000000, maxOutputTokens: 128000,
    maximumInputUsdPerMillionIncludingOneHourCacheWrite: 6, outputUsdPerMillion: 15,
    hostedTools: false, sdkRetries: 0,
    reference: 'https://platform.claude.com/docs/en/models/sonnet-4-6/overview' },
  note: 'Historical failed calls retain unknown actual costs. Their conservative finite allowance is never released automatically and grants no resend permission. Any newly discovered historical activity requires a fresh audited policy; current pipeline unknown outcomes still block all new requests.',
});
export const HISTORICAL_COST_POLICY_SHA256 = hashContent(HISTORICAL_COST_POLICY);

export function validateHistoricalCommitments(receipt) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== 'bounded-historical-project-costs' || receipt.policySha256 !== HISTORICAL_COST_POLICY_SHA256
    || receipt.releasePolicy !== 'never-automatic' || receipt.textUsd !== 40 || receipt.audioUsd !== 11
    || typeof receipt.reviewedBy !== 'string' || !receipt.reviewedBy.trim() || !Number.isFinite(Date.parse(receipt.reviewedAt)) || !receipt.audit || receipt.auditSha256 !== hashContent(receipt.audit)) throw new Error('Historical costs require an exact reviewed audit and the non-releasable USD 51 allowance.');
  const audit = receipt.audit;
  if (audit.schemaVersion !== 1 || audit.source !== 'read-only-app-event-log' || !Number.isFinite(Date.parse(audit.observedAt))
    || audit.claude?.estimatedUsd !== 2.739465 || audit.claude.requests !== 44 || audit.claude.completed !== 41 || audit.claude.failed !== 3 || audit.claude.unknownCostRequests !== 3
    || audit.audio?.requests !== 104 || audit.audio.charactersRequested !== 31091
    || !Array.isArray(audit.unknown) || audit.unknown.length !== 3 || new Set(audit.unknown.map(row => row.invocationId)).size !== 3
    || audit.unknown.some(row => !row.invocationId || row.model !== 'claude-sonnet-4-6' || row.status !== 'failed' || row.reason !== 'request-failed'
      || row.inputTokens !== null || row.outputTokens !== null || !Number.isFinite(Date.parse(row.at)))) throw new Error('Historical audit coverage changed; retain the allowance and obtain a new policy review.');
  const coverage = receipt.coverage;
  if (!coverage || receipt.coverageSha256 !== hashContent(coverage) || coverage.schemaVersion !== 1 || !coverage.id || !coverage.createdBy
    || !Number.isFinite(Date.parse(coverage.createdAt)) || coverage.sourceAuditSha256 !== receipt.auditSha256 || coverage.currency !== 'USD'
    || coverage.knownTextActualUsd !== audit.claude.estimatedUsd || coverage.priorTextAllowanceUsd !== 40 || coverage.priorAudioAllowanceUsd !== 11
    || coverage.audioCharacters !== 31091 || coverage.audioConservativeRateUsdPer1000 !== 0.33
    || coverage.allowanceIsInvoice !== false || coverage.automaticallyReleasable !== false
    || coverage.currentCashPurchasePreTaxUsd !== 100 || coverage.currentCashPurchaseProvider !== 'elevenlabs'
    || !Array.isArray(coverage.pricingSources) || !coverage.pricingSources.includes(HISTORICAL_COST_POLICY.bounds.reference)
    || !Array.isArray(coverage.failedTextCalls) || coverage.failedTextCalls.length !== 3 || new Set(coverage.failedTextCalls.map(row => row.invocationId)).size !== 3
    || coverage.failedTextCalls.some(row => !audit.unknown.some(item => item.invocationId === row.invocationId) || row.model !== 'claude-sonnet-4-6'
      || row.outcome !== 'failed-usage-unknown' || row.reservedUsd !== 8 || row.mayRetry !== false)) throw new Error('Historical coverage evidence must bind the exact audit, fixed allowance and non-retry failure records.');
  return { textUsd: 40, audioUsd: 11, totalUsd: 51, historicalUncertainCostRequests: 3,
    knownTextEstimateUsd: 2.739465, unknownTextCeilingUsd: 24, audioEstimateCeilingUsd: 10.26003,
    unallocatedTextContingencyUsd: 13.260535, unallocatedAudioContingencyUsd: 0.73997,
    actualCostStatus: 'historical-uncertainty-retained', isInvoice: false, releasePolicy: 'never-automatic', noRetryAuthority: true,
    auditSha256: receipt.auditSha256, coverageSha256: receipt.coverageSha256, confirmedAudioPrepaymentUsd: 100, policySha256: HISTORICAL_COST_POLICY_SHA256, receiptSha256: hashContent(receipt) };
}
