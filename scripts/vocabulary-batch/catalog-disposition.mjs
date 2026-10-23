#!/usr/bin/env node
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { hashVocabularyEntry, normalizeLemma } from './schema.mjs';
import { assertDispositionContent, catalogCounts, dispositionFor, dispositionKinds, originalSeed } from './catalog-policy.mjs';
import { atomicJson, readJson, withLock } from './storage.mjs';

const text = z.string().trim().min(1).max(1000), hash = z.string().regex(/^[a-f0-9]{64}$/);
const decisionSchema = z.object({ id: text, seedSha256: hash, contentSha256: hash, contentReviewSha256: hash,
  kind: z.enum(dispositionKinds), reason: text, targetId: text.optional(), canonicalLemma: text.optional() }).strict();
export const dispositionProposalSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  createdBy: text, decisions: z.array(decisionSchema).min(1).max(100) }).strict();
export const dispositionReviewSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: hash, reviewedBy: text,
  reviewedAt: z.string().datetime(), verdicts: z.array(z.object({ id: text, approved: z.literal(true), issues: z.array(text).length(0) }).strict()).min(1).max(100) }).strict();

/** Only reviewed metadata changes. Content, billing receipts, statuses and order are immutable. */
export function planCatalogDispositions({ state, proposal: rawProposal, review: rawReview, records, appliedAt = new Date().toISOString() }) {
  const proposal = dispositionProposalSchema.parse(rawProposal), review = dispositionReviewSchema.parse(rawReview);
  const proposalSha256 = hashVocabularyEntry(rawProposal), reviewSha256 = hashVocabularyEntry(rawReview);
  if (review.proposalSha256 !== proposalSha256 || normalizeLemma(proposal.createdBy) === normalizeLemma(review.reviewedBy)) throw new Error('An independent review of the exact proposal is required.');
  const ids = new Set(proposal.decisions.map(decision => decision.id));
  if (ids.size !== proposal.decisions.length || review.verdicts.length !== ids.size || new Set(review.verdicts.map(v => v.id)).size !== ids.size || review.verdicts.some(v => !ids.has(v.id))) throw new Error('Review must approve every decision exactly once.');
  if (state.schemaVersion !== 1 || !Array.isArray(state.words) || new Set(state.words.map(word => word.id)).size !== state.words.length) throw new Error('Invalid manifest identities.');
  const previous = state.catalogDispositionReceipts?.[proposal.id];
  if (previous && (previous.proposalSha256 !== proposalSha256 || previous.reviewSha256 !== reviewSha256)) throw new Error('Disposition identity already has different evidence.');
  const byId = new Map(state.words.map(word => [word.id, word]));
  const changes = proposal.decisions.map(decision => {
    const seed = byId.get(decision.id), row = records.get(decision.id);
    if (seed?.catalogFamily) throw new Error('A grouped sense card needs an explicit family migration before disposition.');
    if (!seed || seed.frozen || seed.inventoryHold || !['approved', 'rejected'].includes(seed.status)
      || hashVocabularyEntry(originalSeed(seed)) !== decision.seedSha256) throw new Error('Disposition seed is stale, held, frozen or still in progress.');
    if (!row || row.entry?.id !== seed.id || row.entry.word !== seed.word || row.review?.status !== seed.status
      || hashVocabularyEntry(row.entry) !== decision.contentSha256 || hashVocabularyEntry(row.review) !== decision.contentReviewSha256
      || (seed.status === 'approved' && row.review.contentSha256 !== decision.contentSha256)) throw new Error('Exact current content and its original review are required.');
    if (decision.kind === 'expansion-only' && (seed.status !== 'approved' || decision.targetId || decision.canonicalLemma)) throw new Error('Expansion-only applies to approved content, not aliases or invalid lemmas.');
    if (decision.kind === 'alias-only') {
      const target = byId.get(decision.targetId);
      if (!target || target.id === seed.id || ids.has(target.id) || !['approved', 'preserved'].includes(target.status) || target.inventoryHold || dispositionFor(target) || decision.canonicalLemma) throw new Error('Alias must point to a retained approved canonical identity.');
    }
    if (decision.kind === 'invalid-lemma' && (seed.status !== 'rejected' || decision.targetId || !decision.canonicalLemma
      || decision.canonicalLemma !== normalizeLemma(decision.canonicalLemma) || !/^[a-z]+(?:[-'][a-z]+)*$/.test(decision.canonicalLemma) || decision.canonicalLemma === seed.word)) throw new Error('Invalid lemma needs a rejected asset and an explicit corrected canonical spelling.');
    const disposition = { schemaVersion: 1, ...decision, proposalId: proposal.id, proposalSha256, reviewSha256,
      reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt, appliedAt: previous?.appliedAt ?? appliedAt };
    if (seed.catalogDisposition && (!previous || hashVocabularyEntry(dispositionFor(seed)) !== hashVocabularyEntry(disposition))) throw new Error('An existing disposition cannot be replaced.');
    if (previous && !seed.catalogDisposition) throw new Error('Previously applied disposition is missing.');
    return { id: seed.id, catalogDisposition: disposition };
  });
  return { proposal, review, proposalSha256, reviewSha256, changes, previous, replayed: !!previous };
}

async function immutableEvidence(file, value, write) {
  const prior = await readJson(file, null);
  if (prior) { if (hashVocabularyEntry(prior) !== hashVocabularyEntry(value)) throw new Error('Immutable disposition evidence differs.'); }
  else if (write) await atomicJson(file, value);
}

export async function applyCatalogDispositions({ output, proposalPath, reviewPath, write = false }) {
  if (![output, proposalPath, reviewPath].every(path => typeof path === 'string' && isAbsolute(path)) || typeof write !== 'boolean') throw new Error('Absolute paths and explicit write mode are required.');
  return withLock(output, async () => {
    const [state, proposal, review, ledger, frozen] = await Promise.all([
      readJson(join(output, 'manifest.json')), readJson(proposalPath), readJson(reviewPath), readJson(join(output, 'ledger.json')), readJson(join(output, 'frozen-100.json')),
    ]);
    if (hashVocabularyEntry(frozen) !== state.frozenSha256) throw new Error('Frozen snapshot integrity failed.');
    if (!Array.isArray(ledger.calls) || ledger.calls.some(call => call.status !== 'complete')) throw new Error('Collect and settle all text requests before applying dispositions.');
    const parsed = dispositionProposalSchema.parse(proposal), records = new Map();
    for (const decision of parsed.decisions) {
      const seed = state.words.find(word => word.id === decision.id);
      if (!seed || !/^[a-z0-9-]+$/.test(seed.batchId ?? '') || !/^[a-z0-9-]+$/.test(seed.grade ?? '') || !['approved', 'rejected'].includes(seed.status)) throw new Error('Missing settled asset identity.');
      const file = seed.status === 'approved' ? join(output, 'approved', seed.grade, `${seed.batchId}.json`) : join(output, 'rejected', `${seed.batchId}.json`);
      const batch = await readJson(file);
      if (batch.batchId !== seed.batchId || !Array.isArray(batch.entries)) throw new Error('Saved asset batch differs.');
      const matches = batch.entries.filter(row => row.entry?.id === seed.id);
      if (matches.length !== 1) throw new Error('Expected exactly one saved asset record.');
      records.set(seed.id, matches[0]);
    }
    const plan = planCatalogDispositions({ state, proposal, review, records });
    const directory = join(output, 'catalog-dispositions', plan.proposal.id), receiptPath = join(directory, 'receipt.json');
    const prior = await readJson(receiptPath, null);
    const receipt = prior ?? { schemaVersion: 1, kind: 'reviewed-catalog-disposition', proposalId: plan.proposal.id,
      proposalSha256: plan.proposalSha256, reviewSha256: plan.reviewSha256, manifestBeforeSha256: hashVocabularyEntry(state),
      appliedAt: plan.changes[0].catalogDisposition.appliedAt, changes: plan.changes, paidCalls: 0 };
    // A crash after evidence but before manifest commit reuses the original timestamp.
    if (!plan.replayed && prior) for (const change of plan.changes) change.catalogDisposition.appliedAt = receipt.appliedAt;
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'reviewed-catalog-disposition' || receipt.proposalId !== plan.proposal.id
      || receipt.proposalSha256 !== plan.proposalSha256 || receipt.reviewSha256 !== plan.reviewSha256 || receipt.paidCalls !== 0
      || hashVocabularyEntry(receipt.changes) !== hashVocabularyEntry(plan.changes)) throw new Error('Disposition receipt differs from the reviewed proposal.');
    if (plan.replayed && (!prior || hashVocabularyEntry(plan.previous) !== hashVocabularyEntry(receipt))) throw new Error('Prior immutable disposition receipt is missing or changed.');
    if (!plan.replayed && prior && receipt.manifestBeforeSha256 !== hashVocabularyEntry(state)) throw new Error('Interrupted disposition baseline changed; operator reconciliation required.');
    if (plan.replayed) for (const [name, value] of [['proposal.json', proposal], ['review.json', review]]) {
      if (hashVocabularyEntry(await readJson(join(directory, name))) !== hashVocabularyEntry(value)) throw new Error('Applied disposition evidence differs.');
    }
    else {
      await immutableEvidence(join(directory, 'proposal.json'), proposal, write);
      await immutableEvidence(join(directory, 'review.json'), review, write);
      await immutableEvidence(receiptPath, receipt, write);
    }
    const byId = new Map(plan.changes.map(change => [change.id, change.catalogDisposition]));
    const next = { ...state, words: state.words.map(seed => byId.has(seed.id) ? { ...seed, catalogDisposition: byId.get(seed.id) } : seed),
      catalogDispositionReceipts: { ...(state.catalogDispositionReceipts ?? {}), [plan.proposal.id]: receipt } };
    for (const change of plan.changes) assertDispositionContent(next.words.find(seed => seed.id === change.id), records.get(change.id));
    if (write && !plan.replayed) await atomicJson(join(output, 'manifest.json'), { ...next, updatedAt: new Date().toISOString() });
    return { mode: write ? 'write' : 'dry-run', proposalId: plan.proposal.id, replayed: plan.replayed,
      changes: plan.changes.map(change => ({ id: change.id, kind: change.catalogDisposition.kind })), before: catalogCounts(state.words), after: catalogCounts(next.words), paidCalls: 0 };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, proposal: { type: 'string' }, review: { type: 'string' }, write: { type: 'boolean' } }, strict: true });
  if (!values.out || !values.proposal || !values.review) throw new Error('Usage: node scripts/vocabulary-batch/catalog-disposition.mjs --out /absolute/assets --proposal /absolute/proposal.json --review /absolute/review.json [--write]');
  applyCatalogDispositions({ output: values.out, proposalPath: values.proposal, reviewPath: values.review, write: !!values.write })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
