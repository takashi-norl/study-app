import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSharedBudget, reserveExpansionRequest } from './budget.mjs';
import { HISTORICAL_COST_POLICY, validateHistoricalCommitments } from './historical-costs.mjs';
import { hashContent } from './schema.mjs';
import { historicalReceiptFixture } from './test-fixtures.mjs';

const snapshot = () => ({ phaseOneText: { calls: [{ id: 'base-text', status: 'complete', reservedUsd: 100, actualUsd: 60 }] },
  phaseOneAudioReservations: [{ requestId: 'base-audio', outcome: 'ready', reservedMicroUsd: 277_000_000 }], expansion: { schemaVersion: 1, calls: [] },
  cashPurchases: [{ id: 'audio-topup', provider: 'elevenlabs', fundingPool: 'audio', amountUsdPreTax: 100 }], historicalCommitments: historicalReceiptFixture(),
  lifecycle: { phaseOneStopped: true, phaseOneSettled: true, exclusiveSharedLockHeld: true } });
const request = reservedUsd => ({ id: 'bounded-next', requestHash: 'a'.repeat(64), reservedUsd });

test('historical unknown costs stay uncertain and fixed at USD 51; no invoice or retry permission is invented', () => {
  const proof = validateHistoricalCommitments(historicalReceiptFixture());
  assert.equal(proof.totalUsd, 51); assert.equal(proof.historicalUncertainCostRequests, 3); assert.equal(proof.unknownTextCeilingUsd, 24);
  assert.equal(proof.isInvoice, false); assert.equal(proof.actualCostStatus, 'historical-uncertainty-retained'); assert.equal(proof.releasePolicy, 'never-automatic'); assert.equal(proof.noRetryAuthority, true);
  const bounds = HISTORICAL_COST_POLICY.bounds;
  assert.ok(bounds.maxInputTokens * bounds.maximumInputUsdPerMillionIncludingOneHourCacheWrite / 1e6 + bounds.maxOutputTokens * bounds.outputUsdPerMillion / 1e6 < HISTORICAL_COST_POLICY.perFailedRequestCeilingUsd);
  assert.ok(3 * 8 + proof.knownTextEstimateUsd < proof.textUsd); assert.ok(proof.audioEstimateCeilingUsd < proof.audioUsd);
});
test('shared USD and yen totals include prior allowances in their own funding pools without counting topups twice', () => {
  const report = assessSharedBudget(snapshot()); assert.equal(report.committedUsd, 388); assert.equal(report.remainingUsd, 112);
  assert.equal(report.yen.combinedAllInJpy, 76824); assert.equal(report.cashPurchasedUsdPreTax, 100); assert.equal(report.canCommitExpansion, true);
  assert.equal(report.historical.totalUsd, 51); assert.equal(report.phaseOneTextUsd, 60); assert.equal(report.phaseOneAudioUsd, 277);
  const exact = reserveExpansionRequest(snapshot(), request(112)); assert.equal(exact.report.committedUsd, 500); assert.equal(exact.report.yen.combinedAllInJpy, 99000);
  assert.throws(() => reserveExpansionRequest(snapshot(), request(112.000001)), /cannot cover/);
});
test('prior text liability is added to prepaid audio liability, while consumed audio allowance uses the same pool', () => {
  const value = snapshot(); value.phaseOneAudioReservations[0].reservedMicroUsd = 1_000_000; value.cashPurchases[0].amountUsdPreTax = 450;
  const report = assessSharedBudget(value); assert.equal(report.committedUsd, 112); assert.equal(report.yen.combinedObligationUsd, 550); assert.equal(report.canCommitExpansion, false);
});
test('historical allowance cannot be lowered, misrepresented as settled, or rebound to a changed audit automatically', () => {
  for (const mutate of [r => r.textUsd = 39, r => r.audioUsd = 10, r => r.releasePolicy = 'settled', r => r.audit.audio.charactersRequested++, r => r.audit.unknown.pop()]) {
    const receipt = historicalReceiptFixture(); mutate(receipt); assert.throws(() => validateHistoricalCommitments(receipt));
  }
  const changed = historicalReceiptFixture(); changed.audit.unknown[0].model = 'unknown-model'; changed.auditSha256 = hashContent(changed.audit);
  assert.throws(() => validateHistoricalCommitments(changed), /coverage changed/);
});
test('the bounded historical exception never settles or permits retry of a current unknown request', () => {
  const value = snapshot(); value.expansion.calls.push({ id: 'current-unknown', status: 'uncertain', requestHash: 'b'.repeat(64), reservedUsd: 1 });
  const report = assessSharedBudget(value); assert.deepEqual(report.unresolved, ['expansion:current-unknown']); assert.equal(report.canCommitExpansion, false);
  assert.throws(() => reserveExpansionRequest(value, request(1)), /unresolved/);
  assert.equal(value.expansion.calls[0].status, 'uncertain'); assert.equal(report.historical.historicalUncertainCostRequests, 3);
});

test('operator coverage evidence is hash-bound and cannot relabel failures as settled or release their ceiling', () => {
  const receipt = historicalReceiptFixture(); receipt.coverage.failedTextCalls[0].reservedUsd = 0;
  assert.throws(() => validateHistoricalCommitments(receipt), /coverage evidence/);
  receipt.coverageSha256 = hashContent(receipt.coverage); assert.throws(() => validateHistoricalCommitments(receipt), /coverage evidence/);
  const mismatch = historicalReceiptFixture(); mismatch.coverage.sourceAuditSha256 = 'a'.repeat(64); mismatch.coverageSha256 = hashContent(mismatch.coverage);
  assert.throws(() => validateHistoricalCommitments(mismatch), /coverage evidence/);
});
