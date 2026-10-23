import { assessSharedBudget, reserveExpansionRequest } from './budget.mjs';
import { classifyCandidates, countDistinct } from './registry.mjs';
import { TARGET_ALLOCATION, validateAllocation } from './allocation.mjs';

export function planningStatus(registry, ownApprovedUnits = []) {
  validateAllocation();
  const baseForms = new Set([...registry.units.values()].filter(unit => unit.source !== 'expansion').map(unit => unit.lemma));
  const approved = new Set(ownApprovedUnits.map(unit => unit.id));
  if ([...approved].some(id => !registry.units.has(id) || registry.units.get(id).source !== 'expansion')) throw new Error('Approved expansion identity is not registered.');
  return { baseApprovedDistinct: baseForms.size, baseTarget: TARGET_ALLOCATION.baseTarget, baseReady: baseForms.size >= TARGET_ALLOCATION.baseTarget, registeredDistinct: countDistinct(registry).lexicalUnits, expansionApprovedDistinct: approved.size, totalApprovedDistinct: baseForms.size + approved.size, totalTarget: TARGET_ALLOCATION.totalTarget };
}

/** Pure plan only. A production dispatcher must lock and persist before sending. */
export function planWave({ registry, candidates, budgetSnapshot, requests, maxUnits = 20, maxRequests = 10 }) {
  if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > TARGET_ALLOCATION.laterWaveMaxUnits || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 500) throw new Error('Expansion wave bounds exceeded.');
  const status = planningStatus(registry), classification = classifyCandidates(registry, candidates), budget = assessSharedBudget(budgetSnapshot);
  if (!status.baseReady) return { status, classification, budget, blocked: 'base-catalog-not-complete', requests: [], ledger: budgetSnapshot.expansion };
  if (!budget.canReserve) return { status, classification, budget, blocked: 'budget-or-unresolved-outcome', requests: [], ledger: budgetSnapshot.expansion };
  if (!budget.canCommitExpansion) return { status, classification, budget, blocked: 'phase-one-not-stopped-and-settled-or-shared-lock-missing', requests: [], ledger: budgetSnapshot.expansion };
  const remaining = Math.max(0, TARGET_ALLOCATION.totalTarget - status.registeredDistinct);
  const candidateIds = new Set(classification.accepted.slice(0, Math.min(maxUnits, remaining)).map(unit => unit.id));
  const allAcceptedIds = new Set(classification.accepted.map(unit => unit.id));
  let snapshot = budgetSnapshot; const selected = [], seen = new Set();
  for (const request of requests) {
    if (selected.length >= maxRequests || seen.size >= candidateIds.size) break;
    if (!Array.isArray(request.unitIds) || !request.unitIds.length || request.unitIds.length > 5 || new Set(request.unitIds).size !== request.unitIds.length || request.unitIds.some(id => !allAcceptedIds.has(id) || seen.has(id))) throw new Error('Every generation request must address 1–5 distinct accepted new units once.');
    if (request.unitIds.some(id => !candidateIds.has(id))) break;
    const remainingBudget = assessSharedBudget(snapshot);
    if (!Number.isFinite(request.reservedUsd) || request.reservedUsd <= 0) throw new Error('Worst-case request cost is required.');
    if (request.reservedUsd > remainingBudget.remainingUsd + 1e-9) break;
    const next = reserveExpansionRequest(snapshot, request);
    if (!next.newReservation) throw new Error('Existing request must be reconciled, not dispatched by a new wave.');
    selected.push(request); request.unitIds.forEach(id => seen.add(id)); snapshot = { ...snapshot, expansion: next.ledger };
  }
  return { status, classification, budget: assessSharedBudget(snapshot), blocked: !selected.length ? 'no-new-units-or-budget-cap' : null, requests: selected, ledger: snapshot.expansion, newUnitsReserved: seen.size, requiresDurableGlobalLock: true, createsNoNetworkRequests: true };
}
