#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { GRADES, hashVocabularyEntry, normalizeLemma } from './schema.mjs';
import { assertCatalogFamilies, assertFamilyContent, familyFor, seedBeforeFamily } from './canonical-policy.mjs';
import { catalogCounts } from './catalog-policy.mjs';
import { atomicJson, readJson, withLock } from './storage.mjs';
import { withSharedSpendingFence } from '../shared-spending-fence.mjs';

const text = z.string().trim().min(1).max(1000), hash = z.string().regex(/^[a-f0-9]{64}$/), slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const memberSchema = z.object({ id: text, seedSha256: hash, contentSha256: hash, contentReviewSha256: hash.nullable(), sourceKind: z.enum(['approved', 'frozen']) }).strict();
export const familyProposalSchema = z.object({ schemaVersion: z.literal(1), id: slug, createdBy: text, auditSourceSha256: hash, auditEvidenceSha256: hash,
  groups: z.array(z.object({ familyId: slug, canonicalId: text, reason: text, members: z.array(memberSchema).min(2).max(10) }).strict()).min(1).max(100) }).strict();
export const familyReviewSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: hash, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(z.object({ familyId: text, approved: z.literal(true), issues: z.array(text).length(0) }).strict()).min(1).max(100) }).strict();

/** A family merges counting only. Every sense card, learner id and paid asset survives. */
export function planCatalogFamilies({ state, proposal: rawProposal, review: rawReview, records, appliedAt = new Date().toISOString() }) {
  const proposal = familyProposalSchema.parse(rawProposal), review = familyReviewSchema.parse(rawReview);
  const proposalSha256 = hashVocabularyEntry(rawProposal), reviewSha256 = hashVocabularyEntry(rawReview);
  if (review.proposalSha256 !== proposalSha256 || normalizeLemma(proposal.createdBy) === normalizeLemma(review.reviewedBy)) throw new Error('An independent review of the exact family proposal is required.');
  const familyIds = new Set(proposal.groups.map(group => group.familyId));
  if (familyIds.size !== proposal.groups.length || review.verdicts.length !== familyIds.size || new Set(review.verdicts.map(v => v.familyId)).size !== familyIds.size || review.verdicts.some(v => !familyIds.has(v.familyId))) throw new Error('Review must approve every family exactly once.');
  if (state.schemaVersion !== 1 || !Array.isArray(state.words)) throw new Error('Invalid manifest.');
  assertCatalogFamilies(state.words);
  for (const grade of Object.keys(GRADES)) if (state.gradeTargets?.[grade]?.target !== GRADES[grade].target) throw new Error('Grade targets must remain unchanged.');
  const previous = state.catalogFamilyReceipts?.[proposal.id];
  if (previous && (previous.proposalSha256 !== proposalSha256 || previous.reviewSha256 !== reviewSha256)) throw new Error('Family identity already has different evidence.');
  const byId = new Map(state.words.map(seed => [seed.id, seed])), seen = new Set(), changes = [];
  for (const group of proposal.groups) {
    const ids = group.members.map(member => member.id).sort(), canonical = byId.get(group.canonicalId);
    if (new Set(ids).size !== ids.length || !ids.includes(group.canonicalId) || !canonical || !Object.hasOwn(GRADES, canonical.grade)) throw new Error('Canonical target must be a member with an existing grade.');
    if (state.words.some(seed => seed.catalogFamily?.familyId === group.familyId && seed.catalogFamily.proposalId !== proposal.id)) throw new Error('An existing family identity cannot be reused.');
    for (const member of group.members) {
      const seed = byId.get(member.id), row = records.get(member.id);
      if (seen.has(member.id)) throw new Error('A card cannot belong to overlapping canonical families.'); seen.add(member.id);
      if (!seed || seed.inventoryHold || seed.catalogDisposition || !['approved', 'preserved'].includes(seed.status)
        || hashVocabularyEntry(seedBeforeFamily(seed)) !== member.seedSha256 || !row?.entry || row.entry.id !== seed.id || row.entry.word !== seed.word
        || hashVocabularyEntry(row.entry) !== member.contentSha256) throw new Error('Family needs exact completed, retained seed and content evidence.');
      if (member.sourceKind === 'frozen' ? !seed.frozen || seed.status !== 'preserved' || member.contentReviewSha256 !== null || row.contentSha256 !== member.contentSha256
        : seed.frozen || seed.status !== 'approved' || row.review?.status !== 'approved' || row.review.contentSha256 !== member.contentSha256 || hashVocabularyEntry(row.review) !== member.contentReviewSha256) throw new Error('Family needs the exact original approval or frozen snapshot proof.');
      const family = { schemaVersion: 1, ...member, familyId: group.familyId, canonicalId: canonical.id, canonicalLemma: canonical.word, canonicalGrade: canonical.grade,
        memberIds: ids, proposalId: proposal.id, proposalSha256, reviewSha256, reason: group.reason,
        reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt, appliedAt: previous?.appliedAt ?? appliedAt };
      if (seed.catalogFamily && (!previous || hashVocabularyEntry(familyFor(seed)) !== hashVocabularyEntry(family))) throw new Error('An existing canonical family cannot be replaced.');
      if (previous && !seed.catalogFamily) throw new Error('Previously applied family metadata is missing.');
      changes.push({ id: seed.id, catalogFamily: family });
    }
  }
  const byChange = new Map(changes.map(change => [change.id, change.catalogFamily]));
  const nextWords = state.words.map(seed => byChange.has(seed.id) ? { ...seed, catalogFamily: byChange.get(seed.id) } : seed);
  assertCatalogFamilies(nextWords);
  return { proposal, review, proposalSha256, reviewSha256, changes, nextWords, previous, replayed: !!previous };
}

async function immutableEvidence(file, value, write) {
  const prior = await readJson(file, null);
  if (prior) { if (hashVocabularyEntry(prior) !== hashVocabularyEntry(value)) throw new Error('Immutable family evidence differs.'); }
  else if (write) await atomicJson(file, value);
}
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function assertStopped(output, runtime) {
  if (!await exists(join(runtime, 'stop-production'))) throw new Error('An explicit stopped worker checkpoint is required.');
  for (const path of [join(runtime, 'production.lock'), join(output, 'audio', 'batch.lock')]) if (await exists(path)) throw new Error('A production or audio worker is still active.');
  if (await exists(join(runtime, 'phase-two-handoff.json'))) throw new Error('Base identity is frozen after phase-two spending handoff.');
}

export async function applyCatalogFamilies({ output, proposalPath, reviewPath, runtimeDirectory, write = false }) {
  if (![output, proposalPath, reviewPath].every(path => typeof path === 'string' && isAbsolute(path)) || typeof write !== 'boolean'
    || (write && (typeof runtimeDirectory !== 'string' || !isAbsolute(runtimeDirectory)))) throw new Error('Absolute paths and an explicit stopped runtime directory for write mode are required.');
  const execute = () => withLock(output, async () => {
    if (write) await assertStopped(output, runtimeDirectory);
    const [state, proposal, review, ledger, frozen] = await Promise.all([
      readJson(join(output, 'manifest.json')), readJson(proposalPath), readJson(reviewPath), readJson(join(output, 'ledger.json')), readJson(join(output, 'frozen-100.json')),
    ]);
    if (hashVocabularyEntry(frozen) !== state.frozenSha256 || frozen.some(row => hashVocabularyEntry(row.entry) !== row.contentSha256)) throw new Error('Frozen snapshot integrity failed.');
    if (!Array.isArray(ledger.calls) || ledger.calls.some(call => call.status !== 'complete')) throw new Error('All paid text outcomes must be settled before canonical counting changes.');
    const parsed = familyProposalSchema.parse(proposal), records = new Map();
    for (const member of parsed.groups.flatMap(group => group.members)) {
      const seed = state.words.find(word => word.id === member.id); if (!seed) throw new Error('Missing family seed.');
      let rows;
      if (seed.frozen) rows = frozen.filter(row => row.entry.id === seed.id);
      else {
        if (!/^[a-z0-9-]+$/.test(seed.batchId ?? '') || !Object.hasOwn(GRADES, seed.grade) || seed.status !== 'approved') throw new Error('Missing approved asset identity.');
        const batch = await readJson(join(output, 'approved', seed.grade, `${seed.batchId}.json`));
        if (batch.batchId !== seed.batchId || !Array.isArray(batch.entries)) throw new Error('Saved family batch differs.');
        rows = batch.entries.filter(row => row.entry?.id === seed.id);
      }
      if (rows.length !== 1) throw new Error('Expected exactly one original family asset.'); records.set(seed.id, rows[0]);
    }
    const plan = planCatalogFamilies({ state, proposal, review, records });
    const directory = join(output, 'catalog-families', plan.proposal.id), receiptPath = join(directory, 'receipt.json'), prior = await readJson(receiptPath, null);
    const receipt = prior ?? { schemaVersion: 1, kind: 'reviewed-canonical-counting', proposalId: plan.proposal.id, proposalSha256: plan.proposalSha256,
      reviewSha256: plan.reviewSha256, manifestBeforeSha256: hashVocabularyEntry(state), appliedAt: plan.changes[0].catalogFamily.appliedAt, changes: plan.changes, paidCalls: 0 };
    if (!plan.replayed && prior) for (const change of plan.changes) change.catalogFamily.appliedAt = receipt.appliedAt;
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'reviewed-canonical-counting' || receipt.proposalId !== plan.proposal.id || receipt.proposalSha256 !== plan.proposalSha256
      || receipt.reviewSha256 !== plan.reviewSha256 || receipt.paidCalls !== 0 || hashVocabularyEntry(receipt.changes) !== hashVocabularyEntry(plan.changes)) throw new Error('Family receipt differs from the reviewed proposal.');
    if (plan.replayed && (!prior || hashVocabularyEntry(plan.previous) !== hashVocabularyEntry(receipt))) throw new Error('Prior immutable family receipt is missing or changed.');
    if (!plan.replayed && prior && receipt.manifestBeforeSha256 !== hashVocabularyEntry(state)) throw new Error('Interrupted family baseline changed; operator reconciliation required.');
    if (plan.replayed) for (const [name, value] of [['proposal.json', proposal], ['review.json', review]]) {
      if (hashVocabularyEntry(await readJson(join(directory, name))) !== hashVocabularyEntry(value)) throw new Error('Applied family evidence differs.');
    } else {
      await immutableEvidence(join(directory, 'proposal.json'), proposal, write); await immutableEvidence(join(directory, 'review.json'), review, write); await immutableEvidence(receiptPath, receipt, write);
    }
    for (const change of plan.changes) assertFamilyContent(plan.nextWords.find(seed => seed.id === change.id), records.get(change.id));
    const next = { ...state, words: plan.nextWords, catalogFamilyReceipts: { ...(state.catalogFamilyReceipts ?? {}), [plan.proposal.id]: receipt } };
    if (write && !plan.replayed) { await assertStopped(output, runtimeDirectory); await atomicJson(join(output, 'manifest.json'), { ...next, updatedAt: new Date().toISOString() }); }
    return { mode: write ? 'write' : 'dry-run', replayed: plan.replayed, proposalId: plan.proposal.id, unchangedSenseCards: plan.changes.length,
      before: catalogCounts(state.words), after: catalogCounts(next.words), grades: Object.fromEntries(Object.keys(GRADES).map(grade => [grade, { target: GRADES[grade].target, before: catalogCounts(state.words, grade), after: catalogCounts(next.words, grade) }])), paidCalls: 0 };
  });
  return write ? withSharedSpendingFence({ output, sharedLockDirectory: join(runtimeDirectory, 'shared-spending.lock'), ownerKind: 'phase-one' }, execute) : execute();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, proposal: { type: 'string' }, review: { type: 'string' }, runtime: { type: 'string' }, write: { type: 'boolean' } }, strict: true });
  applyCatalogFamilies({ output: values.out, proposalPath: values.proposal, reviewPath: values.review, runtimeDirectory: values.runtime, write: !!values.write })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
