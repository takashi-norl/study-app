import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPENDING_FENCE_PROTOCOL } from '../shared-spending-fence.mjs';
import { assertPricingFresh, PRICING_POLICY_SHA256 } from './anthropic-adapter.mjs';
import { validateHistoricalCommitments } from './historical-costs.mjs';
import { hashContent, validateSeed } from './schema.mjs';
import { validateQualityBenchmark } from './prompts-v3.mjs';
import { validateRepairAuthority } from './pilot-repair.mjs';
import { validateEditorialAuthority } from './pilot-editorial.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const scripts = ['shared-spending-fence.mjs', ...['canonical-policy', 'catalog-policy', 'holds', 'schema', 'structural-forms'].map(name => `vocabulary-batch/${name}.mjs`), ...['activation', 'anthropic-adapter', 'prompts', 'prompts-v2', 'prompts-v3', 'work-versions', 'pilot-repair', 'pilot-editorial', 'pilot-editorial-cli', 'live-pilot', 'dispatcher', 'store', 'budget', 'historical-costs', 'schema', 'canonical-families', 'registry', 'loaders', 'audio-adapter', 'allocation'].map(name => `english-expansion/${name}.mjs`)];
export function integrationFiles(runtimeDirectory) {
  return [...['production.mjs', 'run.mjs'].map(name => ({ id: `phase-one/${name}`, path: join(runtimeDirectory, name) })),
    ...scripts.map(name => ({ id: `scripts/${name}`, path: join(REPO_ROOT, 'scripts', name) }))];
}
export const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');
export function validateReviewedSeeds(source, review) {
  if (source?.schemaVersion !== 1 || !source.id || !source.createdBy || !Array.isArray(source.seeds) || !source.seeds.length || source.seeds.length > 20) throw new Error('A bounded authored pilot inventory is required.');
  const seeds = source.seeds.map(validateSeed);
  if (new Set(seeds.map(seed => seed.id)).size !== seeds.length || review?.schemaVersion !== 1 || review.sourceSha256 !== hashContent(source) || !review.reviewedBy || review.reviewedBy === source.createdBy || !Number.isFinite(Date.parse(review.reviewedAt)) || !Array.isArray(review.verdicts) || review.verdicts.length !== seeds.length) throw new Error('Pilot inventory requires independent exact-source review.');
  const seen = new Set();
  for (const verdict of review.verdicts) {
    if (seen.has(verdict.id) || !seeds.some(seed => seed.id === verdict.id) || verdict.approved !== true || !Array.isArray(verdict.issues) || verdict.issues.length) throw new Error('Only a fully approved bounded pilot inventory can be activated.');
    seen.add(verdict.id);
  }
  return seeds;
}
/** Missing approval is deliberate. This function never creates or upgrades it. */
export async function verifyIntegration(options, now = new Date()) {
  const { phaseOneOutput, runtimeDirectory, output, sharedLockDirectory } = options;
  if (![phaseOneOutput, runtimeDirectory, output, sharedLockDirectory].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Absolute phase-one, phase-two and shared-fence paths are required.');
  if (resolve(sharedLockDirectory) !== join(resolve(runtimeDirectory), 'shared-spending.lock') || resolve(output) === resolve(phaseOneOutput) || resolve(output).startsWith(`${resolve(phaseOneOutput)}/`) || resolve(phaseOneOutput).startsWith(`${resolve(output)}/`)) throw new Error('The reviewed runtime fence and a separate expansion directory are required.');
  let config;
  try { config = JSON.parse(await readFile(join(runtimeDirectory, 'shared-spending-integration.json'), 'utf8')); }
  catch { throw new Error('Live expansion remains disabled: reviewed shared-spending integration receipt is missing or unreadable.'); }
  if (config.schemaVersion !== 1 || config.protocol !== SPENDING_FENCE_PROTOCOL || config.enabled !== true || config.scope !== 'phase-two-initial-pilot' || config.textOnly !== true || config.pilot?.maxUnits !== 20 || config.pilot?.maxPaidRequests !== 10 || !config.reviewedBy || !Number.isFinite(Date.parse(config.reviewedAt)) || config.pricingPolicySha256 !== PRICING_POLICY_SHA256 || config.expenseCoverage !== 'reviewed-ledgers-plus-bounded-historical-allowance' || !Array.isArray(config.cashPurchases)) throw new Error('Live expansion integration receipt is incomplete or exceeds the bounded authority.');
  const historical = validateHistoricalCommitments(config.historicalCommitments);
  if (config.pilotRepair !== undefined) validateRepairAuthority(config.pilotRepair);
  if (config.pilotEditorial !== undefined) validateEditorialAuthority(config.pilotEditorial, config.pilotRepair);
  if (config.cashPurchases.filter(p => p.provider === 'elevenlabs' && p.fundingPool === 'audio').reduce((sum, p) => sum + p.amountUsdPreTax, 0) < historical.confirmedAudioPrepaymentUsd) throw new Error('Confirmed historical audio prepayment is missing from cash obligations.');
  for (const key of ['phaseOneOutput', 'runtimeDirectory', 'output', 'sharedLockDirectory']) if (config.paths?.[key] !== resolve(options[key])) throw new Error('Integration receipt is bound to different private directories.');
  const expected = integrationFiles(runtimeDirectory);
  if (!Array.isArray(config.files) || config.files.length !== expected.length || new Set(config.files.map(file => file.id)).size !== expected.length) throw new Error('Every phase-one entry point and phase-two spending module must be reviewed.');
  for (const file of expected) {
    const record = config.files.find(row => row.id === file.id);
    if (!record || !/^[a-f0-9]{64}$/.test(record.sha256) || await realpath(file.path) !== resolve(file.path) || await sha256File(file.path) !== record.sha256) throw new Error('Reviewed runtime or provider code changed; integration approval is stale.');
  }
  assertPricingFresh(now);
  const seeds = validateReviewedSeeds(config.inventory?.source, config.inventory?.review);
  if (config.qualityBenchmark !== undefined) validateQualityBenchmark(config.qualityBenchmark, seeds);
  if (!config.canonicalAudit?.proposal || !config.canonicalAudit?.review) throw new Error('Canonical-family audit must precede live expansion.');
  return { config, configSha256: hashContent(config), seeds, cashPurchases: config.cashPurchases, historicalCommitments: config.historicalCommitments, canonicalAudit: config.canonicalAudit };
}
