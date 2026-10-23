import { validateHistoricalCommitments } from './historical-costs.mjs';
export const TOTAL_CAP_USD = 500;
export const PHASE_ONE_CAPS_USD = { text: 100, audio: 400 };
export const DEFAULT_YEN_POLICY = { capJpy: 100000, jpyPerUsd: 180, bufferMultiplier: 1.1 };
const money = (value, name) => {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error(`Invalid ${name}.`);
  return Math.ceil(value * 1e6 - 1e-8);
};
const dollars = micro => micro / 1e6;

function callsCost(calls, phase) {
  if (!Array.isArray(calls)) throw new Error(`Missing ${phase} calls; missing data is not zero spend.`);
  const ids = new Set(), unresolved = []; let actual = 0, reserved = 0;
  for (const call of calls) {
    if (typeof call.id !== 'string' || !call.id || ids.has(call.id)) throw new Error(`Duplicate/missing ${phase} request identity.`);
    ids.add(call.id);
    const ceiling = money(call.reservedUsd, 'reserved amount');
    if (call.status === 'complete') actual += money(call.actualUsd, 'completed cost');
    else if (['reserved', 'requested', 'uncertain', 'batch_pending'].includes(call.status)) {
      if (!ceiling) throw new Error('Unfinished requests must retain a positive reservation.');
      reserved += ceiling;
      if (['requested', 'uncertain'].includes(call.status) || (call.status === 'batch_pending' && !call.providerBatchId)) unresolved.push(`${phase}:${call.id}`);
    } else throw new Error(`Unknown ${phase} request status.`);
  }
  return { actual, reserved, unresolved };
}
function audioCost(records) {
  if (!Array.isArray(records)) throw new Error('Missing phase-one audio reservations.');
  const ids = new Set(), unresolved = []; let total = 0, unsettled = 0;
  for (const record of records) {
    if (!record.requestId || ids.has(record.requestId)) throw new Error('Duplicate/missing audio reservation identity.');
    ids.add(record.requestId);
    if (!Number.isSafeInteger(record.reservedMicroUsd) || record.reservedMicroUsd <= 0) throw new Error('Invalid retained audio reservation.');
    total += record.reservedMicroUsd;
    if (!['ready', 'known-quota-rejection', 'reserved-not-sent'].includes(record.outcome)) unresolved.push(`audio:${record.requestId}`);
    if (!['ready', 'known-quota-rejection'].includes(record.outcome)) unsettled++;
  }
  return { total, unresolved, unsettled };
}
export function assessYenGuard({ textUsd, audioUsd }, cashPurchases = [], policy = DEFAULT_YEN_POLICY) {
  if (!Number.isFinite(policy.capJpy) || policy.capJpy <= 0 || policy.capJpy > 100000 || !Number.isFinite(policy.jpyPerUsd) || policy.jpyPerUsd < 180 || !Number.isFinite(policy.bufferMultiplier) || policy.bufferMultiplier < 1.1) throw new Error('Yen guard must retain at least the approved conservative planning assumptions.');
  money(textUsd, 'text usage commitment'); money(audioUsd, 'audio usage commitment');
  const usageCommittedUsd = textUsd + audioUsd;
  const allInPlanningRate = policy.jpyPerUsd * policy.bufferMultiplier, ids = new Set();
  const yen = usd => Math.ceil(usd * allInPlanningRate - 1e-8);
  let cashCommittedJpy = 0, cashUsdPreTax = 0; const observationsExceedingGuard = [];
  const cashByPool = { text: { usdPreTax: 0, jpy: 0 }, audio: { usdPreTax: 0, jpy: 0 } };
  for (const purchase of cashPurchases) {
    if (!purchase.id || ids.has(purchase.id)) throw new Error('Duplicate/missing cash purchase identity.');
    ids.add(purchase.id); const amount = dollars(money(purchase.amountUsdPreTax, 'cash purchase'));
    if (!amount) throw new Error('Cash purchase obligation must be positive.');
    if (!['text', 'audio'].includes(purchase.fundingPool) || purchase.provider !== (purchase.fundingPool === 'audio' ? 'elevenlabs' : 'anthropic')) throw new Error('Cash obligation needs a known provider and matching funding pool.');
    cashUsdPreTax += amount;
    const estimated = yen(amount);
    if (purchase.chargedJpy !== undefined) {
      if (!Number.isSafeInteger(purchase.chargedJpy) || purchase.chargedJpy <= 0) throw new Error('Invalid observed cash charge.');
      cashCommittedJpy += purchase.chargedJpy;
      cashByPool[purchase.fundingPool].jpy += purchase.chargedJpy;
      if (purchase.chargedJpy > estimated) observationsExceedingGuard.push(purchase.id);
    } else { cashCommittedJpy += estimated; cashByPool[purchase.fundingPool].jpy += estimated; }
    cashByPool[purchase.fundingPool].usdPreTax += amount;
  }
  const usageCommittedJpy = yen(usageCommittedUsd);
  const poolLiabilitiesJpy = { text: Math.max(yen(textUsd), cashByPool.text.jpy), audio: Math.max(yen(audioUsd), cashByPool.audio.jpy) };
  const combinedAllInJpy = poolLiabilitiesJpy.text + poolLiabilitiesJpy.audio;
  const combinedObligationUsd = Math.max(textUsd, cashByPool.text.usdPreTax) + Math.max(audioUsd, cashByPool.audio.usdPreTax);
  return { capJpy: policy.capJpy, allInPlanningRate, usageCommittedJpy, cashCommittedJpy, cashPurchasedUsdPreTax: cashUsdPreTax, cashByPool, poolLiabilitiesJpy, combinedAllInJpy, combinedObligationUsd, observationsExceedingGuard, blocked: combinedAllInJpy > policy.capJpy || observationsExceedingGuard.length > 0, note: 'Sum the larger usage/prepayment liability within each funding pool; do not double-count the same consumed credit. Planning conversion/buffer is not a quoted FX/tax rate.' };
}
/** Cash top-ups fund usage; adding them again would double-count the same credit. */
export function assessSharedBudget({ phaseOneText, phaseOneAudioReservations, expansion, cashPurchases = [], historicalCommitments, capUsd = TOTAL_CAP_USD, yenPolicy = DEFAULT_YEN_POLICY, lifecycle = {} }) {
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > TOTAL_CAP_USD) throw new Error('Shared budget cannot exceed USD 500.');
  const base = callsCost(phaseOneText?.calls, 'phase-one'), next = callsCost(expansion?.calls, 'expansion');
  const audio = audioCost(phaseOneAudioReservations), cap = money(capUsd, 'budget cap');
  const historical = historicalCommitments ? validateHistoricalCommitments(historicalCommitments) : null;
  const priorText = money(historical?.textUsd ?? 0, 'historical text allowance'), priorAudio = money(historical?.audioUsd ?? 0, 'historical audio allowance');
  const committed = base.actual + base.reserved + audio.total + next.actual + next.reserved + priorText + priorAudio;
  const capViolations = [];
  if (base.actual + base.reserved > money(PHASE_ONE_CAPS_USD.text, 'phase-one text cap')) capViolations.push('phase-one-text');
  if (audio.total > money(PHASE_ONE_CAPS_USD.audio, 'phase-one audio cap')) capViolations.push('phase-one-audio');
  if (committed > cap) capViolations.push('shared-total');
  const unresolved = [...base.unresolved, ...next.unresolved, ...audio.unresolved];
  const yen = assessYenGuard({ textUsd: dollars(base.actual + base.reserved + next.actual + next.reserved + priorText), audioUsd: dollars(audio.total + priorAudio) }, cashPurchases, yenPolicy);
  if (money(yen.combinedObligationUsd, 'combined funding liability') > cap) capViolations.push('funding-obligations-total');
  if (yen.blocked) capViolations.push('yen-guard');
  const lifecycleReady = lifecycle.phaseOneStopped === true && lifecycle.phaseOneSettled === true && lifecycle.exclusiveSharedLockHeld === true && base.reserved === 0 && audio.unsettled === 0;
  return { capUsd, committedUsd: dollars(committed), remainingUsd: Math.max(0, dollars(cap - money(yen.combinedObligationUsd, 'combined funding liability'))), phaseOneTextUsd: dollars(base.actual + base.reserved), phaseOneAudioUsd: dollars(audio.total), expansionUsd: dollars(next.actual + next.reserved), unresolved, capViolations, canReserve: !unresolved.length && !capViolations.length, canCommitExpansion: lifecycleReady && !unresolved.length && !capViolations.length, lifecycleReady, yen, cashPurchasedUsdPreTax: yen.cashPurchasedUsdPreTax, cashIsNotAdditionalUsage: true, historical };
}

export function reserveExpansionRequest(snapshot, request) {
  if (!request?.id || typeof request.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.requestHash)) throw new Error('A stable request identity and exact input hash are required.');
  const amount = money(request.reservedUsd, 'next request ceiling');
  if (!amount) throw new Error('A positive worst-case request ceiling is required.');
  const report = assessSharedBudget(snapshot);
  const prior = snapshot.expansion.calls.find(call => call.id === request.id);
  if (prior) {
    if (prior.requestHash !== request.requestHash || money(prior.reservedUsd, 'prior reservation') !== amount) throw new Error('Existing request has different inputs or reservation. Use an explicit revision.');
    return { ledger: snapshot.expansion, report, action: prior.status === 'complete' ? 'reuse-saved-result' : 'reconcile-existing-reservation', newReservation: false };
  }
  if (!report.canReserve) throw new Error('Shared budget is blocked by an unresolved outcome or cap violation.');
  if (!report.canCommitExpansion) throw new Error('Phase one must be stopped and settled under an exclusive shared lock before expansion reservations.');
  if (amount > money(report.remainingUsd, 'remaining budget')) throw new Error('Shared USD 500 budget cannot cover the next request.');
  const ledger = { ...snapshot.expansion, calls: [...snapshot.expansion.calls, { ...request, status: 'reserved' }] };
  const projected = assessSharedBudget({ ...snapshot, expansion: ledger });
  if (!projected.canCommitExpansion) throw new Error('Next request would exceed the shared yen or dollar guard.');
  return { ledger, report: projected, action: 'persist-reservation-before-send', newReservation: true };
}

export function reserveCashTopUp(snapshot, purchase) {
  const prior = (snapshot.cashPurchases ?? []).find(item => item.id === purchase.id);
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(purchase)) throw new Error('Cash obligation identity already exists with different details.');
    return { cashPurchases: snapshot.cashPurchases, newObligation: false, action: 'reuse-existing-cash-obligation' };
  }
  const cashPurchases = [...(snapshot.cashPurchases ?? []), purchase];
  const report = assessSharedBudget({ ...snapshot, cashPurchases });
  if (!report.canCommitExpansion) throw new Error('Cash top-up blocked by budget, yen guard, unresolved outcome or phase lifecycle.');
  return { cashPurchases, report, newObligation: true, action: 'persist-obligation-before-operator-checkout; never-auto-purchase' };
}
