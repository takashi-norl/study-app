import assert from 'node:assert/strict';
import test from 'node:test';
import { approveUnit, hashContent, senseIdFor, unitIdFor, validateRelations, validateSeed, validateUnit } from './schema.mjs';
import { classifyCandidates, countDistinct, createRegistry } from './registry.mjs';
import { assessSharedBudget, assessYenGuard, reserveCashTopUp, reserveExpansionRequest } from './budget.mjs';
import { planningStatus, planWave } from './planner.mjs';
import { TARGET_ALLOCATION, validateAllocation } from './allocation.mjs';

function seed(lemma = 'resilient', kind = 'word') {
  return { id: unitIdFor(kind, lemma), kind, lemma, aliases: [], primaryCollection: 'eiken-1', level: { cefrEstimate: 'C1', eikenEstimates: ['pre1', 'grade1'], policy: 'estimated-not-official' }, genres: ['general', 'academic'], register: 'neutral', audience: { suitableFor: 'teens-and-adults', noteJa: '学校や日常の文脈で使えます。' }, pitfalls: [{ kind: 'meaning', noteJa: '困難から回復できるという意味です。' }] };
}
function unit() {
  const base = seed(), id = senseIdFor(base.id, 'recovering');
  const choices = ['resilient', 'fragile', 'irrelevant', 'temporary'].map(text => ({ text, meaningJa: '選択肢の意味', feedbackJa: '文脈と語義を確認します。' }));
  return { ...base, schemaVersion: 1, senses: [{ id, key: 'recovering', partOfSpeech: 'adjective', meaningEn: 'Able to recover after difficulties.', meaningJa: '困難から回復できる', examples: ['The team remained resilient after the loss.', 'She became more resilient with practice.', 'The town has a resilient community.'].map((text, index) => ({ id: `${id}:example-${index + 1}`, text, meaningJa: '例文の日本語訳', contextJa: '困難からの回復' })), tests: ['meaning', 'word', 'context', 'usage'].map(mode => ({ mode, prompt: mode === 'context' ? 'The team remained ___.' : 'resilientに合う答えは？', choices, correctIndex: 0, explanationJa: '困難から回復する文脈に合います。', alternatives: [] })), relations: [] }], provenance: { authorship: 'original', author: 'writer', createdAt: '2026-10-23T00:00:00.000Z', usageReferences: [] } };
}
const complete = (id, actualUsd, reservedUsd = actualUsd) => ({ id, status: 'complete', actualUsd, reservedUsd });
const audio = (requestId, usd, outcome = 'ready') => ({ requestId, reservedMicroUsd: usd * 1e6, outcome });
const lifecycle = { phaseOneStopped: true, phaseOneSettled: true, exclusiveSharedLockHeld: true };
const purchase = (id, amountUsdPreTax, extra = {}) => ({ id, amountUsdPreTax, provider: 'elevenlabs', fundingPool: 'audio', ...extra });
const snapshot = () => ({ phaseOneText: { calls: [complete('base', 80)] }, phaseOneAudioReservations: [audio('audio', 250)], expansion: { schemaVersion: 1, calls: [] }, cashPurchases: [purchase('topup', 100)], lifecycle });
const request = (id = 'one', reservedUsd = 1) => ({ id, reservedUsd, requestHash: hashContent({ id }) });

test('stable canonical word/phrase identities and subordinate senses validate without counting genres', () => {
  assert.equal(validateUnit(unit()).senses.length, 1);
  assert.equal(unitIdFor('phrase', '  In Order To '), unitIdFor('phrase', 'in order to'));
  assert.equal(validateSeed(seed('in order to', 'phrase')).kind, 'phrase');
  assert.throws(() => validateSeed(seed('in order to', 'word')), /correct item type/);
  assert.throws(() => validateSeed({ ...seed(), id: 'invented-id' }), /stable canonical/);
  assert.throws(() => validateSeed({ ...seed(), genres: ['general', 'general'] }), /Duplicate/);
});
test('all senses have three examples and four unambiguous structured MCQ modes', () => {
  for (const change of [x => x.senses[0].examples.pop(), x => { x.senses[0].tests[1].mode = 'meaning'; }, x => { x.senses[0].tests[1].correctIndex = 1; }, x => { x.senses[0].tests[0].choices[1].text = 'resilient'; }, x => { x.senses[0].tests[0].explanationJa = '正解は1です。'; }, x => { x.senses[0].tests[2].alternatives = [{ text: 'fragile', meaningJa: '壊れやすい', noteJa: '誤答にも使っているため矛盾。' }]; }]) {
    const candidate = unit(); change(candidate); assert.throws(() => validateUnit(candidate));
  }
});
test('relations are sense scoped and cannot point at a missing sense', () => {
  const candidate = unit(); candidate.senses[0].relations.push({ type: 'synonym', targetUnitId: 'base-recover', targetSenseId: 'base-recover:health', contextJa: '健康の回復', substitutable: false, limitationJa: '品詞が違うのでそのまま置換できません。' });
  validateUnit(candidate);
  assert.throws(() => validateRelations([candidate], new Set()), /Unresolved/);
  assert.equal(validateRelations([candidate], new Set(['base-recover:health'])), true);
  candidate.senses[0].relations[0].targetSenseId = 'other:health'; assert.throws(() => validateUnit(candidate), /declared target/);
});
test('approval requires a different reviewer and hashes all current content', () => {
  const candidate = unit(), receipt = { reviewer: 'reviewer', reviewedAt: '2026-10-24T00:00:00.000Z', unitId: candidate.id, contentSha256: hashContent(candidate), approved: true, issues: [] };
  assert.equal(approveUnit(candidate, receipt).review.approved, true);
  assert.throws(() => approveUnit(candidate, { ...receipt, reviewer: 'writer' }), /Independent/);
  candidate.senses[0].meaningJa = '別の意味'; assert.throws(() => approveUnit(candidate, receipt), /Independent/);
});
test('dedup covers approved, frozen, own inventory and verb/spelling aliases without mutating the registry', () => {
  const entry = { id: 'base-go', word: 'go', verbForms: { past: ['went'], pastParticiple: ['gone'] } };
  const registry = createRegistry({ approvedBatches: [{ schemaVersion: 1, entries: [{ entry, review: { status: 'approved', contentSha256: hashContent(entry) } }] }], frozenEntries: [{ entry, contentSha256: hashContent(entry) }], ownInventory: [seed('colour')] });
  const result = classifyCandidates(registry, [seed('go'), seed('went'), { ...seed('color'), aliases: ['colour'] }, seed('colour'), seed('in order to', 'phrase'), seed('in order to', 'phrase')]);
  assert.equal(result.accepted.length, 1); assert.equal(result.overlapping.length, 3); assert.equal(result.alreadyRegistered.length, 2);
  assert.deepEqual(countDistinct(registry), { lexicalUnits: 2, words: 2, phrases: 0 });
  assert.equal(registry.units.size, 2);
});
test('tampered approved or frozen content cannot enter the dedup registry', () => {
  const entry = { id: 'one', word: 'one' };
  assert.throws(() => createRegistry({ approvedBatches: [{ schemaVersion: 1, entries: [{ entry, review: { status: 'approved', contentSha256: '0'.repeat(64) } }] }] }), /hash-bound/);
  assert.throws(() => createRegistry({ frozenEntries: [{ entry, contentSha256: '0'.repeat(64) }] }), /hash mismatch/);
});
test('terminal punctuation does not inflate collection counts, while related constructions need explicit aliases', () => {
  const registry = createRegistry({ frozenEntries: [{ id: 'my-bad', word: 'My bad.' }, { id: 'no-sweat', word: 'No sweat!' }] });
  assert.equal(classifyCandidates(registry, [seed('my bad', 'phrase'), seed('no sweat', 'phrase')]).overlapping.length, 2);
  const first = seed("i've got your back", 'phrase'), second = seed("have someone's back", 'phrase');
  assert.equal(classifyCandidates(registry, [first, second]).accepted.length, 2);
  const explicit = classifyCandidates(registry, [{ ...first, aliases: ["have someone's back"] }, second]);
  assert.equal(explicit.accepted.length, 1); assert.equal(explicit.overlapping.length, 1);
});
test('shared spending sums actuals, full pending reservations and both audio attempts; cash stays separate', () => {
  const s = snapshot(); s.phaseOneText.calls.push({ id: 'pending', status: 'batch_pending', providerBatchId: 'batch-one', reservedUsd: 10 });
  s.phaseOneAudioReservations = [audio('original', 100, 'known-quota-rejection'), audio('retry', 1)];
  s.expansion.calls = [complete('expanded', 50), { ...request('reserved', 20), status: 'reserved' }];
  const result = assessSharedBudget(s);
  assert.equal(result.committedUsd, 261); assert.equal(result.remainingUsd, 239); assert.equal(result.cashPurchasedUsdPreTax, 100);
  assert.equal(result.canReserve, true); assert.equal(result.canCommitExpansion, false);
});
test('unknown text and audio outcomes keep reservations and block all new spending', () => {
  for (const status of ['requested', 'uncertain', 'batch_pending']) {
    const s = snapshot(); s.expansion.calls.push({ ...request('unknown', 3), status });
    assert.equal(assessSharedBudget(s).committedUsd, 333); assert.equal(assessSharedBudget(s).canReserve, false);
    assert.throws(() => reserveExpansionRequest(s, request('next')), /unresolved/);
  }
  const s = snapshot(); s.phaseOneAudioReservations.push(audio('missing-result', 2, 'uncertain'));
  assert.equal(assessSharedBudget(s).committedUsd, 332); assert.equal(assessSharedBudget(s).canReserve, false);
});
test('phase-one stop, drained requests and exclusive lock are required even with budget remaining', () => {
  for (const field of Object.keys(lifecycle)) {
    const s = snapshot(); s.lifecycle = { ...lifecycle, [field]: false }; assert.throws(() => reserveExpansionRequest(s, request()), /stopped and settled/);
  }
  const s = snapshot(); s.phaseOneAudioReservations.push(audio('not-sent-retry', 1, 'reserved-not-sent'));
  assert.throws(() => reserveExpansionRequest(s, request()), /stopped and settled/);
});
test('global dollar ceiling is shared with the base; exact-boundary reservations and zero-cost completion are valid', () => {
  const s = snapshot(); s.phaseOneText.calls = [complete('base', 100), complete('zero', 0, 0.1)]; s.phaseOneAudioReservations = [audio('audio', 300)]; s.expansion.calls = [complete('earlier', 90)];
  const next = reserveExpansionRequest(s, request('last', 10)); assert.equal(next.report.committedUsd, 500); assert.equal(next.report.yen.usageCommittedJpy, 99000);
  assert.throws(() => reserveExpansionRequest(s, request('too-much', 10.001)), /cannot cover/);
  assert.throws(() => assessSharedBudget({ ...s, capUsd: 501 }), /exceed USD 500/);
  const broken = snapshot(); broken.phaseOneText.calls = [complete('base', 101)]; assert.equal(assessSharedBudget(broken).canReserve, false);
});
test('reservation replay is idempotent and never authorizes another send', () => {
  const s = snapshot(), first = reserveExpansionRequest(s, request());
  const replay = reserveExpansionRequest({ ...s, expansion: first.ledger }, request());
  assert.equal(replay.newReservation, false); assert.equal(replay.action, 'reconcile-existing-reservation'); assert.equal(replay.ledger.calls.length, 1);
  assert.equal(s.expansion.calls.length, 0);
  assert.throws(() => reserveExpansionRequest({ ...s, expansion: first.ledger }, { ...request(), requestHash: 'a'.repeat(64) }), /different inputs/);
});
test('yen and cumulative cash guards are independent; adverse observed conversion blocks continuation', () => {
  const result = assessYenGuard({ textUsd: 0, audioUsd: 500 }, [purchase('funding', 500)]);
  assert.equal(result.usageCommittedJpy, 99000); assert.equal(result.cashCommittedJpy, 99000); assert.equal(result.blocked, false);
  assert.equal(assessYenGuard({ textUsd: 0, audioUsd: 100 }, [purchase('too-much-cash', 600)]).blocked, true);
  assert.equal(assessYenGuard({ textUsd: 0, audioUsd: 100 }, [purchase('adverse-conversion', 100, { chargedJpy: 19900 })]).blocked, true);
  assert.throws(() => assessYenGuard({ textUsd: 0, audioUsd: 100 }, [], { capJpy: 100000, jpyPerUsd: 170, bufferMultiplier: 1.1 }), /conservative/);
  assert.throws(() => assessYenGuard({ textUsd: 0, audioUsd: 100 }, [{ id: 'unknown', amountUsdPreTax: 100 }]), /funding pool/);
});
test('text liabilities plus prepaid audio are bounded together without double-counting consumed audio', () => {
  const result = assessYenGuard({ textUsd: 300, audioUsd: 100 }, [purchase('large-audio-topup', 400)]);
  assert.equal(result.combinedObligationUsd, 700); assert.equal(result.combinedAllInJpy, 138600); assert.equal(result.blocked, true);
  const s = snapshot(); s.phaseOneAudioReservations = [audio('audio', 100)]; s.expansion.calls = [complete('new-text', 220)]; s.cashPurchases = [purchase('large-audio-topup', 400)];
  assert.equal(assessSharedBudget(s).committedUsd, 400); assert.equal(assessSharedBudget(s).canReserve, false);
});
test('cash top-up planning is separate and idempotent, and never creates a usage call', () => {
  const s = snapshot(), topup = purchase('second', 100);
  const next = reserveCashTopUp(s, topup); assert.equal(next.report.committedUsd, 330); assert.equal(next.report.cashPurchasedUsdPreTax, 200);
  assert.equal(reserveCashTopUp({ ...s, cashPurchases: next.cashPurchases }, topup).newObligation, false);
  assert.throws(() => reserveCashTopUp(s, purchase('too-large', 500)), /Cash top-up blocked/);
  assert.equal(s.expansion.calls.length, 0);
});
test('allocation reconciles to twenty thousand without adding genre subdivisions twice', () => {
  const plan = validateAllocation(); assert.equal(plan.baseTarget + plan.expansionTarget, 20000);
  assert.equal(plan.collections.reduce((s, x) => s + x.words, 0), 8500); assert.equal(plan.collections.reduce((s, x) => s + x.phrases, 0), 4000);
});
test('planner refuses incomplete base and reserves only a bounded affordable prefix', () => {
  const candidates = [seed('resilient'), seed('in order to', 'phrase')], small = createRegistry();
  assert.equal(planWave({ registry: small, candidates, budgetSnapshot: snapshot(), requests: [] }).blocked, 'base-catalog-not-complete');
  const registry = createRegistry({ frozenEntries: Array.from({ length: 7500 }, (_, i) => ({ id: `base-${i}`, word: `base${i}` })) });
  assert.equal(planningStatus(registry).totalApprovedDistinct, 7500);
  const s = snapshot(); s.expansion.calls = [complete('earlier', 150)];
  const requests = candidates.map((candidate, i) => ({ ...request(`new-${i}`, 15), unitIds: [candidate.id] }));
  const plan = planWave({ registry, candidates, budgetSnapshot: s, requests });
  assert.equal(plan.requests.length, 1); assert.equal(plan.newUnitsReserved, 1); assert.equal(plan.budget.committedUsd, 495);
  assert.equal(s.expansion.calls.length, 1); assert.equal(registry.units.size, 7500);
  assert.throws(() => planWave({ registry, candidates, budgetSnapshot: s, requests, maxUnits: 1001 }), /bounds/);
  assert.equal(TARGET_ALLOCATION.pilot.audio, 'deferred');
});
