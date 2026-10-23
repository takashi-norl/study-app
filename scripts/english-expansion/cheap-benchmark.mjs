import { readdir, realpath, access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { integrationFiles, REPO_ROOT, sha256File, validateReviewedSeeds } from './activation.mjs';
import { SPENDING_FENCE_PROTOCOL } from '../shared-spending-fence.mjs';
import { validateHistoricalCommitments } from './historical-costs.mjs';
import { hashContent } from './schema.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { reserveExpansionRequest } from './budget.mjs';
import { generationWorkV4, reviewWorkV4, parseGeneratedV4, parseReviewedV4, REVIEW_POLICY_V4 } from './prompts-v4.mjs';
import { CHEAP_PRICING_SHA256, assertCheapPricingFresh, quoteCheapInput, priceCheapResponse, createCheapBenchmarkAdapter } from './cheap-benchmark-provider.mjs';
import { readJson, readOptionalJson, withExpansionLock, persistWork, persistRequest, persistLedger, persistRawResponse, persistDraft, persistReviewResult } from './store.mjs';

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/), absolute = z.string().refine(isAbsolute);
const pathKeys = ['phaseOneOutput', 'runtimeDirectory', 'output', 'sharedLockDirectory'];
export const cheapBenchmarkAuthoritySchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('haiku-three-seed-benchmark-v4'), id,
  reviewedBy: z.literal('/root'), reviewedAt: z.string().datetime(), approved: z.literal(true), textOnly: z.literal(true), scaleAuthorized: z.literal(false),
  maxPaidRequests: z.literal(2), maxUnits: z.literal(3), maxTotalReservedUsd: z.literal(0.198), pricingPolicySha256: sha,
  paths: z.object(Object.fromEntries(pathKeys.map(key => [key, absolute]))).strict(),
  disabledConfigSha256: sha, storeSha256: sha, baselineLedgerSha256: sha, baselineRequestIds: z.array(id).max(8),
  approvedSnapshotSha256: sha, nativeScaleHoldSha256: sha,
  research: z.object({ path: absolute, sha256: sha }).strict(),
  files: z.array(z.object({ id: z.string().min(1), sha256: sha }).strict()).min(1),
  generation: z.object({ id, workSha256: sha, seeds: z.array(z.object({ id, sha256: sha }).strict()).min(1).max(3), reservedUsd: z.literal(0.018) }).strict(),
  review: z.object({ id, policySha256: sha, reservedUsd: z.literal(0.18) }).strict(),
}).strict();
export const cheapReviewAuthoritySchema = z.object({ schemaVersion: z.literal(1), benchmarkSha256: sha,
  generationRawSha256: sha, reviewWorkSha256: sha, reviewedBy: z.literal('/root'), reviewedAt: z.string().datetime(), approved: z.literal(true) }).strict();
export function cheapBenchmarkFiles(runtimeDirectory) {
  return [...integrationFiles(runtimeDirectory), ...['prompts-v4', 'cheap-benchmark-provider', 'cheap-benchmark', 'cheap-benchmark-cli'].map(name => ({ id: `scripts/english-expansion/${name}.mjs`, path: join(REPO_ROOT, 'scripts/english-expansion', `${name}.mjs`) }))];
}
export async function approvedSnapshot(output) {
  const names = (await readdir(join(output, 'approved'))).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => [name, hashContent(await readJson(join(output, 'approved', name)))]));
}
const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function checkedWork(work) {
  const builder = work?.stage === 'generation' ? generationWorkV4 : work?.stage === 'review' ? reviewWorkV4 : null;
  const expected = builder?.(work.stage === 'generation' ? work.seeds : work.units, { id: work.id, createdAt: work.createdAt });
  if (!expected || work.promptVersion !== 'v4' || hashContent(work) !== hashContent(expected)) throw Error('Work differs from the exact v4 benchmark policy.');
  return work;
}
export async function verifyCheapBenchmark(options) {
  const authority = cheapBenchmarkAuthoritySchema.parse(await readJson(options.authorityPath));
  const generationIds = authority.generation.seeds.map(row => row.id);
  if (new Set(generationIds).size !== generationIds.length || new Set(authority.baselineRequestIds).size !== authority.baselineRequestIds.length
    || authority.generation.id === authority.review.id || [authority.generation.id, authority.review.id].some(id => authority.baselineRequestIds.includes(id))
    || authority.pricingPolicySha256 !== CHEAP_PRICING_SHA256 || authority.review.policySha256 !== hashContent(REVIEW_POLICY_V4)) throw Error('Benchmark authority has conflicting identities or policy.');
  for (const key of pathKeys) if (!isAbsolute(options[key] ?? '') || authority.paths[key] !== resolve(options[key])) throw Error('Benchmark authority belongs to different directories.');
  if (options.sharedLockDirectory !== join(options.runtimeDirectory, 'shared-spending.lock') || options.output === options.phaseOneOutput
    || options.output.startsWith(options.phaseOneOutput + '/') || options.phaseOneOutput.startsWith(options.output + '/')) throw Error('Benchmark needs the shared runtime fence and separate outputs.');
  for (const key of pathKeys.filter(key => key !== 'sharedLockDirectory')) if (await realpath(options[key]) !== resolve(options[key])) throw Error('Benchmark paths cannot be symlink aliases.');
  const config = await readJson(join(options.runtimeDirectory, 'shared-spending-integration.json'));
  if (hashContent(config) !== authority.disabledConfigSha256 || config.enabled !== false || config.protocol !== SPENDING_FENCE_PROTOCOL
    || config.scope !== 'phase-two-initial-pilot' || config.textOnly !== true || config.pilot?.maxUnits !== 20 || config.pilot?.maxPaidRequests !== 10
    || config.expenseCoverage !== 'reviewed-ledgers-plus-bounded-historical-allowance' || !Array.isArray(config.cashPurchases)) throw Error('Existing integration must remain exactly disabled with its historical budget coverage.');
  for (const key of pathKeys) if (config.paths?.[key] !== options[key]) throw Error('Disabled integration paths changed.');
  const historical = validateHistoricalCommitments(config.historicalCommitments);
  if (config.cashPurchases.filter(p => p.provider === 'elevenlabs' && p.fundingPool === 'audio').reduce((sum, p) => sum + p.amountUsdPreTax, 0) < historical.confirmedAudioPrepaymentUsd) throw Error('Confirmed audio cash obligation is missing.');
  validateReviewedSeeds(config.inventory.source, config.inventory.review);
  const expected = cheapBenchmarkFiles(options.runtimeDirectory);
  if (authority.files.length !== expected.length || new Set(authority.files.map(row => row.id)).size !== expected.length) throw Error('Complete benchmark code binding is required.');
  for (const file of expected) if (await realpath(file.path) !== resolve(file.path) || await sha256File(file.path) !== authority.files.find(row => row.id === file.id)?.sha256) throw Error('Benchmark code changed; root authority is stale.');
  if (await realpath(authority.research.path) !== resolve(authority.research.path) || hashContent(await readJson(authority.research.path)) !== authority.research.sha256) throw Error('Reviewed model research changed.');
  const state = await readJson(join(options.output, 'store.json'));
  if (hashContent(state) !== authority.storeSha256 || state.sharedLockDirectory !== options.sharedLockDirectory || state.pilot?.maxUnits !== 20 || state.pilot.seeds.length > 20) throw Error('Registered pilot/store/lock changed; no seed registration is permitted.');
  for (const row of authority.generation.seeds) if (hashContent(state.pilot.seeds.find(seed => seed.id === row.id)) !== row.sha256) throw Error('Benchmark seed is not the exact registered pilot seed.');
  if (hashContent(await approvedSnapshot(options.output)) !== authority.approvedSnapshotSha256) throw Error('Existing private approvals must remain unchanged.');
  const hold = await readJson(join(options.output, 'native-recoveries', 'scale-hold.json'));
  if (hashContent(hold) !== authority.nativeScaleHoldSha256 || hold.scaleAuthorized !== false || hold.automaticallyReleasable !== false) throw Error('The explicit native quality hold must remain unchanged.');
  assertCheapPricingFresh();
  return { authority, config, state, authoritySha256: hashContent(authority) };
}
function verifyLedger(ledger, authority) {
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.calls) || new Set(ledger.calls.map(call => call.id)).size !== ledger.calls.length) throw Error('Invalid existing ledger.');
  const baseline = ledger.calls.filter(call => authority.baselineRequestIds.includes(call.id));
  if (hashContent({ ...ledger, calls: baseline }) !== authority.baselineLedgerSha256 || hashContent(baseline.map(call => call.id)) !== hashContent(authority.baselineRequestIds)
    || baseline.some(call => call.status !== 'complete' || call.accountingHold || !Number.isFinite(call.actualUsd) || call.actualUsd < 0)) throw Error('All historical paid calls must remain exactly settled and immutable.');
  const added = ledger.calls.filter(call => !authority.baselineRequestIds.includes(call.id));
  if (added.length > 2 || added.some(call => ![authority.generation.id, authority.review.id].includes(call.id)) || ledger.calls.length > 10) throw Error('Only two authorized benchmark requests may be appended within the ten-call pilot.');
}
async function inspectPriorRaw(output, ledger, authority) {
  for (const call of ledger.calls.filter(call => call.status === 'complete')) {
    const raw = await readJson(join(output, 'requests', call.id, 'response.json'));
    if (raw.requestId !== call.id || raw.requestHash !== call.requestHash || hashContent(raw.response) !== call.responseHash) throw Error('Historical paid raw evidence changed.');
    if (!authority.baselineRequestIds.includes(call.id) && priceCheapResponse(raw.response, call.stage) !== call.actualUsd) throw Error('Benchmark settled cost does not match its preserved usage.');
  }
}
async function assertReviewSource(output, work, ledger, authority, reviewAuthorization) {
  const generation = ledger.calls.find(call => call.id === authority.generation.id);
  if (!generation || generation.stage !== 'generation' || generation.status !== 'complete' || generation.accountingHold || !Number.isFinite(generation.actualUsd)) throw Error('Review requires the single settled benchmark generation.');
  const saved = await readJson(join(output, 'requests', generation.id, 'work.json')), raw = await readJson(join(output, 'requests', generation.id, 'response.json'));
  const original = checkedWork(saved.work);
  if (hashContent(original) !== authority.generation.workSha256 || raw.requestHash !== generation.requestHash || hashContent(raw.response) !== generation.responseHash) throw Error('Benchmark generation source changed.');
  const units = parseGeneratedV4(raw.response, original);
  if (hashContent(units) !== hashContent(work.units)) throw Error('Review must use the exact generated complete cards.');
  for (const unit of units) {
    const draft = await readJson(join(output, 'drafts', unit.id, `${hashContent(unit)}.json`));
    if (hashContent(draft.unit) !== hashContent(unit) || draft.contentSha256 !== hashContent(unit)) throw Error('Review draft changed.');
  }
  const receipt = cheapReviewAuthoritySchema.parse(reviewAuthorization);
  if (receipt.benchmarkSha256 !== hashContent(authority) || receipt.generationRawSha256 !== hashContent(raw) || receipt.reviewWorkSha256 !== hashContent(work)) throw Error('Separate exact root authorization is required before a paid Sonnet review.');
}
async function finish(lease, work, request, raw) {
  if (raw.requestId !== work.id || raw.requestHash !== request.requestHash) throw Error('Saved response belongs to different benchmark work.');
  const ledger = await readJson(join(lease.output, 'ledger.json')), call = ledger.calls.find(row => row.id === work.id), responseHash = hashContent(raw.response);
  if (call.status === 'complete' && call.responseHash !== responseHash) throw Error('Saved paid response changed.');
  if (call.status !== 'complete') {
    let actualUsd;
    try { actualUsd = priceCheapResponse(raw.response, work.stage); }
    catch { call.status = 'uncertain'; call.accountingHold = 'benchmark-usage-unpriced'; await persistLedger(lease, ledger); throw Error('Raw saved, but usage pricing is unresolved. No retry.'); }
    Object.assign(call, { status: 'complete', actualUsd, responseHash, completedAt: new Date().toISOString() });
    if (actualUsd > call.reservedUsd + 1e-9) call.accountingHold = 'benchmark-charge-exceeded-reservation';
    await persistLedger(lease, ledger);
  }
  if (call.accountingHold) throw Error('Benchmark accounting hold requires operator review.');
  if (work.stage === 'generation') {
    const units = parseGeneratedV4(raw.response, work);
    for (const unit of units) await persistDraft(lease, unit);
    return { requestId: work.id, stage: work.stage, actualUsd: call.actualUsd, unitIds: units.map(unit => unit.id), state: 'private-drafts-awaiting-root-quality-decision', published: 0, scaleAuthorized: false };
  }
  const results = parseReviewedV4(raw.response, work, raw.savedAt);
  await persistReviewResult(lease, work.id, results.map(({ unit, receipt }) => ({ unitId: unit.id, contentSha256: hashContent(unit), receipt })));
  return { requestId: work.id, stage: work.stage, actualUsd: call.actualUsd, approvedByModel: results.filter(row => row.receipt.approved).map(row => row.unit.id),
    held: results.filter(row => !row.receipt.approved).map(row => row.unit.id), state: 'benchmark-evidence-only-root-quality-decision-required', published: 0, scaleAuthorized: false };
}
async function action(options, adapterFactory) {
  const work = checkedWork(options.work);
  return withExpansionLock(options, async lease => {
    const checked = await verifyCheapBenchmark(options), { authority, config, state } = checked;
    if (work.id !== authority[work.stage].id || hashContent(work.unitIds) !== hashContent(authority.generation.seeds.map(row => row.id))
      || (work.stage === 'generation' && hashContent(work) !== authority.generation.workSha256)) throw Error('Only the exact authorized benchmark work may run.');
    if (work.stage === 'generation' && work.seeds.some((seed, index) => hashContent(seed) !== authority.generation.seeds[index].sha256)) throw Error('Generation work changed the exact registered seed.');
    let ledger = await readJson(join(options.output, 'ledger.json'));
    verifyLedger(ledger, authority); await inspectPriorRaw(options.output, ledger, authority);
    const prior = ledger.calls.find(call => call.id === work.id);
    const reviewAuthorization = options.reviewAuthorityPath ? await readJson(options.reviewAuthorityPath) : null;
    if (work.stage === 'review') await assertReviewSource(options.output, work, ledger, authority, reviewAuthorization);
    const quote = quoteCheapInput(work.params, work.stage, 1), request = boundedRequest({ ...work, reservedUsd: quote.reservedUsd });
    if (request.reservedUsd !== authority[work.stage].reservedUsd) throw Error('Reservation differs from the exact benchmark authority.');
    const gateOptions = { phaseOneOutput: options.phaseOneOutput, runtimeDirectory: options.runtimeDirectory, cashPurchases: config.cashPurchases, historicalCommitments: config.historicalCommitments, canonicalAudit: config.canonicalAudit };
    let gate = await inspectPhaseOneGate(lease, gateOptions);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint || gate.registry.canonicalAudit?.canonicalLexemeCount !== 7500) throw Error('Completed canonical base or cost baseline changed.');
    if (prior) {
      const savedWork = await readJson(join(options.output, 'requests', work.id, 'work.json'));
      if (hashContent(savedWork.work) !== hashContent(work) || hashContent(savedWork.quote.authority) !== checked.authoritySha256
        || savedWork.quote.pricingPolicySha256 !== CHEAP_PRICING_SHA256 || prior.requestHash !== request.requestHash || prior.reservedUsd !== request.reservedUsd
        || hashContent(savedWork.quote.reviewAuthorization ?? null) !== hashContent(reviewAuthorization)) throw Error('Prior benchmark request cannot change its bound evidence.');
      const raw = await readOptionalJson(join(options.output, 'requests', work.id, 'response.json'));
      if (!raw) throw Error('Prior benchmark has no saved response; never resend an unknown or interrupted request.');
      if (!options.send) return { mode: 'dry-run-saved-result', requestId: work.id, paidCalls: 0 };
      return { ...await finish(lease, work, request, raw), replayed: true };
    }
    if (ledger.calls.some(call => call.status !== 'complete' || call.accountingHold)) throw Error('Any unresolved outcome blocks new benchmark spending.');
    if (ledger.calls.length >= 10 || ledger.calls.some(call => call.requestHash === request.requestHash)) throw Error('Pilot request cap or duplicate provider inputs.');
    if (work.stage === 'generation') for (const seed of work.seeds) {
      if (ledger.calls.some(call => call.unitIds.includes(seed.id)) || await exists(join(options.output, 'drafts', seed.id)) || await exists(join(options.output, 'approved', `${seed.id}.json`))) throw Error('Benchmark cannot regenerate a used pilot seed.');
    }
    let reservation = reserveExpansionRequest({ ...gate.snapshot, expansion: ledger }, request);
    // Check headroom for the optional review before paying for generation. The
    // disabled old entry point plus exact baseline authority prevent other pilot work.
    if (work.stage === 'generation') reserveExpansionRequest({ ...gate.snapshot, expansion: reservation.ledger }, { id: authority.review.id, requestHash: hashContent({ authority: checked.authoritySha256, reservedReviewPolicy: authority.review }), reservedUsd: authority.review.reservedUsd });
    if (!options.send) return { mode: 'dry-run', requestId: work.id, stage: work.stage, reservedUsd: request.reservedUsd, maximumPairReservedUsd: authority.maxTotalReservedUsd, paidCalls: 0, scaleAuthorized: false };
    const adapter = adapterFactory(), measuredQuote = await adapter.quote(work.params, work.stage);
    if (measuredQuote.reservedUsd !== request.reservedUsd || measuredQuote.pricingPolicySha256 !== CHEAP_PRICING_SHA256) throw Error('Provider preflight quote changed.');
    const rechecked = await verifyCheapBenchmark(options);
    if (rechecked.authoritySha256 !== checked.authoritySha256) throw Error('Benchmark approval changed during preflight.');
    gate = await inspectPhaseOneGate(lease, gateOptions);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint || hashContent(await readJson(join(options.output, 'ledger.json'))) !== hashContent(ledger)) throw Error('Budget or ledger baseline changed before reservation.');
    reservation = reserveExpansionRequest({ ...gate.snapshot, expansion: ledger }, request);
    await persistWork(lease, work, { ...measuredQuote, authority, reviewAuthorization });
    await persistRequest(lease, request); await persistLedger(lease, reservation.ledger);
    if ((await verifyCheapBenchmark(options)).authoritySha256 !== checked.authoritySha256) throw Error('Benchmark authority changed before submission.');
    gate = await inspectPhaseOneGate(lease, gateOptions);
    if (gate.phaseOneFingerprint !== state.phaseOneFingerprint) throw Error('Base checkpoint changed before submission.');
    ledger = await readJson(join(options.output, 'ledger.json')); const call = ledger.calls.find(row => row.id === work.id);
    Object.assign(call, { status: 'requested', sentAt: new Date().toISOString() }); await persistLedger(lease, ledger);
    let response;
    try { response = await adapter.request(work.params, work.stage); }
    catch { call.status = 'uncertain'; call.errorKind = 'benchmark-submit-outcome-unknown'; await persistLedger(lease, ledger); throw Error('Benchmark outcome is unknown; reservation retained and automatic retry prohibited.'); }
    const raw = await persistRawResponse(lease, request, response);
    return { ...await finish(lease, work, request, raw), replayed: false };
  });
}
export const dispatchCheapBenchmark = options => action(options, () => createCheapBenchmarkAdapter());
export const dispatchCheapBenchmarkWithMockSdk = (options, sdk) => {
  if (sdk?.testOnly !== true || sdk.networkEnabled !== false) throw Error('Only an explicitly network-disabled mock SDK is allowed.');
  return action(options, () => createCheapBenchmarkAdapter({ client: sdk }));
};
