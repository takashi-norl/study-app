#!/usr/bin/env node
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { hashVocabularyEntry as hash, materializeEntry, normalizeLemma, validateGeneratedBatch } from './schema.mjs';
import { structuredResult } from './provider.mjs';
import { isBaseCandidate } from './holds.mjs';
import { atomicJson, readJson, withLock } from './storage.mjs';
import { loadAudioReservations } from '../english-expansion/audio-adapter.mjs';

const text = z.string().trim().min(1), sha = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({ word: text, seedHash: sha, seed: z.object({ id: text, word: text, grade: text, batchId: text }).passthrough(),
  entry: z.object({ id: text, word: text }).passthrough(), contentSha256: sha,
  rejectionFile: text, rejectionSha256: sha, rawFile: text, rawSha256: sha,
  issues: z.array(z.string()), structural: z.unknown(), originalContentSha256: sha.optional(), changes: z.union([text, z.array(text).min(1).max(30)]).optional(),
}).strict();
export const editorialProposalSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  createdBy: text, purpose: text.optional(), references: z.array(z.object({ word: text, url: z.string().url() }).strict()).optional(), rows: z.array(rowSchema).min(1).max(100) }).strict();
export const editorialReviewSchema = z.object({ schemaVersion: z.literal(1), proposalSha256: sha, reviewedBy: text, reviewedAt: z.string().datetime(),
  verdicts: z.array(z.object({ word: text, contentSha256: sha, approved: z.boolean(), issues: z.array(text).max(20) }).strict()).min(1).max(100) }).strict();

/** Validate the authored card and every derived legacy mirror; no semantic approval here. */
export function validateEditorialCard(entry, seed, index) {
  if (!entry.metadata || !Array.isArray(entry.examples)) throw new Error('Complete materialized card is required.');
  const generated = { word: entry.word, ipa: entry.ipa, ipaLabel: entry.ipaLabel, partOfSpeech: entry.partOfSpeech,
    definition: entry.definition, meaning: entry.meaning, usageTip: entry.usageTip,
    examples: entry.examples.map(({ id: _id, ...example }) => example), verbForms: entry.verbForms ?? null,
    cefr: entry.metadata.cefrEstimate, domains: entry.metadata.domains, tests: entry.tests };
  const [checked] = validateGeneratedBatch({ entries: [generated] }, [{ ...seed, preferredIpaLabel: index % 2 ? '英音' : '米音' }]);
  if (hash(materializeEntry(checked, seed, index)) !== hash(entry)) throw new Error('Materialized card or legacy mirrors differ from validated content.');
}

export function planEditorialRecovery({ state, proposal: rawProposal, review: rawReview, evidence, ledger }) {
  const proposal = editorialProposalSchema.parse(rawProposal), review = editorialReviewSchema.parse(rawReview);
  const proposalSha256 = hash(rawProposal), reviewSha256 = hash(rawReview);
  if (review.proposalSha256 !== proposalSha256 || normalizeLemma(proposal.createdBy) === normalizeLemma(review.reviewedBy)) throw new Error('Independent review must bind the exact editorial proposal.');
  if (state.schemaVersion !== 1 || !Array.isArray(state.words) || !Array.isArray(ledger.calls) || ledger.calls.some(call => call.status !== 'complete')) throw new Error('Manifest and fully settled spending history are required.');
  const words = new Set(proposal.rows.map(row => row.word));
  if (words.size !== proposal.rows.length || new Set(proposal.rows.map(row => row.seed.id)).size !== proposal.rows.length
    || review.verdicts.length !== words.size || new Set(review.verdicts.map(v => v.word)).size !== words.size
    || review.verdicts.some(v => !words.has(v.word) || v.approved !== (v.issues.length === 0))) throw new Error('Independent review must address every exact word once, with issues only for rejections.');
  const previous = state.editorialRecoveryReceipts?.[proposal.id];
  if (previous && (previous.proposalSha256 !== proposalSha256 || previous.reviewSha256 !== reviewSha256)) throw new Error('Recovery identity already has different evidence.');
  const changes = [];
  for (const row of proposal.rows) {
    const verdict = review.verdicts.find(item => item.word === row.word), saved = evidence.get(row.word);
    if (row.word !== row.seed.word || row.word !== row.entry.word || row.seed.id !== row.entry.id || hash(row.seed) !== row.seedHash
      || hash(row.entry) !== row.contentSha256 || verdict.contentSha256 !== row.contentSha256) throw new Error('Proposal seed or complete-card hash differs.');
    if (!saved || hash(saved.raw) !== row.rawSha256 || hash(saved.rejection) !== row.rejectionSha256
      || saved.rejection.batchId !== row.seed.batchId) throw new Error('Original immutable paid evidence differs.');
    const rejected = saved.rejection.entries?.filter(item => item.entry?.id === row.seed.id);
    if (rejected?.length !== 1 || rejected[0].entry.word !== row.word || rejected[0].review?.status !== 'rejected'
      || hash(rejected[0].review.issues) !== hash(row.issues)) throw new Error('Current rejection evidence does not match the proposed card.');
    const rawId = `generate-${row.seed.batchId}`, call = ledger.calls.find(item => item.id === rawId);
    if (saved.raw.id !== rawId || !call || call.status !== 'complete' || call.requestHash !== saved.raw.requestHash
      || !/^[a-f0-9]{64}$/.test(call.requestHash) || !Number.isFinite(call.actualUsd) || call.actualUsd < 0) throw new Error('Paid generation is not bound to its completed ledger.');
    const index = state.words.findIndex(item => item.id === row.seed.id);
    if (index < 0) throw new Error('Paid request inventory identity is missing.');
    if (saved.prepared) {
      if (saved.prepared.id !== rawId || saved.prepared.requestHash !== saved.raw.requestHash || hash(saved.prepared.params) !== saved.raw.requestHash) throw new Error('Saved prepared request differs.');
      const requested = JSON.parse(saved.prepared.params.messages.find(message => message.role === 'user').content).entries;
      const expected = requested.filter(item => item.word === row.word);
      if (expected.length !== 1 || expected[0].partOfSpeech !== row.seed.partOfSpeech || expected[0].meaning !== row.seed.meaning
        || expected[0].preferredIpaLabel !== (index % 2 ? '英音' : '米音')) throw new Error('Paid request inventory or stable voice position differs.');
    } else if (call.providerBatchId || call.submissionId || call.billing || saved.raw.providerBatchId || call.model !== saved.raw.response.model) {
      // The synchronous provider predates prepared files; batch evidence may never use this exception.
      throw new Error('Batch generation requires its saved prepared request.');
    }
    const original = structuredResult(saved.raw.response, 'create_vocabulary').entries.filter(item => item.word === row.word);
    if (original.length !== 1 || hash(materializeEntry(original[0], row.seed, index)) !== (row.originalContentSha256 ?? row.contentSha256)) throw new Error('Original complete card is not recoverable from the saved paid raw.');
    if (row.originalContentSha256 && (!row.changes || row.originalContentSha256 === row.contentSha256)) throw new Error('Corrections need an actual change and an editorial explanation.');
    if (!verdict.approved) continue;
    validateEditorialCard(row.entry, row.seed, index);
    const current = state.words[index];
    if (row.seed.frozen || row.seed.status !== 'rejected' || row.seed.attempt !== 2 || !isBaseCandidate(row.seed)
      || current.frozen || !isBaseCandidate(current)) throw new Error('Only non-frozen, non-excluded attempt-two rejections can be recovered.');
    const batchId = `${row.seed.grade}-editorial-${hash({ proposalId: proposal.id, proposalSha256, word: row.word }).slice(0, 20)}`;
    const recovery = { proposalId: proposal.id, proposalSha256, reviewSha256, originalBatchId: row.seed.batchId,
      originalContentSha256: row.originalContentSha256 ?? row.contentSha256, contentSha256: row.contentSha256 };
    const nextSeed = { ...row.seed, status: 'approved', batchId, editorialRecovery: recovery };
    if (hash(current) !== hash(previous ? nextSeed : row.seed)) throw new Error('Current seed changed since editorial review.');
    const approved = { schemaVersion: 1, batchId, entries: [{ entry: row.entry,
      review: { status: 'approved', contentSha256: row.contentSha256, method: 'independent-agent-editorial-review', reviewedBy: review.reviewedBy,
        reviewedAt: review.reviewedAt, proposalSha256, reviewSha256 },
      provenance: { original: true, generatedRequestId: rawId, gradePolicy: 'Approximate cumulative educational bands; not an official Eiken vocabulary list.',
        editorialRecovery: { ...recovery, rejectionSha256: row.rejectionSha256, rawSha256: row.rawSha256,
          requestEvidence: saved.prepared ? 'saved-prepared-request' : 'synchronous-ledger-and-raw',
          changes: row.changes ?? 'Independent adjudication without changing the saved complete card.' } },
    }] };
    changes.push({ id: row.seed.id, word: row.word, grade: row.seed.grade, batchId, nextSeed, approved });
  }
  return { proposal, review, proposalSha256, reviewSha256, previous, replayed: !!previous, changes };
}

const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function assertStopped(output, runtimeDirectory) {
  if (!await exists(join(runtimeDirectory, 'stop-production'))) throw new Error('Worker stop checkpoint is required.');
  for (const file of [join(runtimeDirectory, 'production.lock'), join(runtimeDirectory, 'shared-spending.lock'), join(output, 'audio', 'batch.lock')]) {
    if (await exists(file)) throw new Error('A production, shared-spending or audio process lock is still present.');
  }
}
async function containedFile(output, file, expected) {
  if (!isAbsolute(file)) throw new Error('Evidence paths must be absolute and within the asset directory.');
  const [base, actual] = await Promise.all([realpath(output), realpath(file)]), rel = relative(base, actual);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || (expected && actual !== await realpath(expected))) throw new Error('Evidence path escaped its exact asset location.');
  return actual;
}
async function immutable(file, value, write) {
  const prior = await readJson(file, null);
  if (prior) { if (hash(prior) !== hash(value)) throw new Error('Existing recovery evidence or approved asset cannot be overwritten.'); }
  else if (write) await atomicJson(file, value);
}

export async function recoverEditorialCards({ output, runtimeDirectory, proposalPath, reviewPath, write = false }) {
  if (![output, runtimeDirectory, proposalPath, reviewPath].every(path => typeof path === 'string' && isAbsolute(path)) || typeof write !== 'boolean') throw new Error('Absolute paths and explicit write mode are required.');
  await assertStopped(output, runtimeDirectory);
  return withLock(output, async () => {
    await assertStopped(output, runtimeDirectory);
    await containedFile(output, proposalPath); await containedFile(output, reviewPath);
    const [state, proposal, review, ledger, frozen] = await Promise.all([readJson(join(output, 'manifest.json')), readJson(proposalPath), readJson(reviewPath), readJson(join(output, 'ledger.json')), readJson(join(output, 'frozen-100.json'))]);
    if (hash(frozen) !== state.frozenSha256) throw new Error('Frozen snapshot differs.');
    const audio = await loadAudioReservations(join(output, 'audio'));
    if (audio.some(record => !['ready', 'known-quota-rejection'].includes(record.outcome))) throw new Error('Audio outcomes must be settled before editorial recovery.');
    const parsed = editorialProposalSchema.parse(proposal), evidence = new Map();
    for (const row of parsed.rows) {
      if (!/^[a-z0-9-]+$/.test(row.seed.batchId)) throw new Error('Invalid original batch identity.');
      const raw = await containedFile(output, row.rawFile, join(output, 'raw', `generate-${row.seed.batchId}.json`));
      const rejection = await containedFile(output, row.rejectionFile, join(output, 'rejected', `${row.seed.batchId}.json`));
      const preparedFile = join(output, 'prepared', `generate-${row.seed.batchId}.json`);
      const prepared = await exists(preparedFile) ? await readJson(await containedFile(output, preparedFile)) : null;
      evidence.set(row.word, { raw: await readJson(raw), rejection: await readJson(rejection), prepared });
    }
    const plan = planEditorialRecovery({ state, proposal, review, evidence, ledger });
    if (!plan.changes.length) return { mode: write ? 'write' : 'dry-run', approved: 0, declined: proposal.rows.length, paidCalls: 0 };
    const dir = join(output, 'editorial-recoveries', plan.proposal.id), receiptPath = join(dir, 'receipt.json');
    const prior = await readJson(receiptPath, null);
    const summary = plan.changes.map(change => ({ id: change.id, word: change.word, batchId: change.batchId, seedSha256: hash(change.nextSeed), approvedSha256: hash(change.approved) }));
    const receipt = prior ?? { schemaVersion: 1, kind: 'independent-agent-editorial-recovery', proposalId: plan.proposal.id,
      proposalSha256: plan.proposalSha256, reviewSha256: plan.reviewSha256, manifestBeforeSha256: hash(state), appliedAt: new Date().toISOString(), changes: summary, paidCalls: 0 };
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'independent-agent-editorial-recovery' || receipt.proposalId !== plan.proposal.id
      || receipt.proposalSha256 !== plan.proposalSha256 || receipt.reviewSha256 !== plan.reviewSha256 || receipt.paidCalls !== 0 || hash(receipt.changes) !== hash(summary)) throw new Error('Recovery receipt differs from reviewed content.');
    if (plan.replayed && (!prior || hash(plan.previous) !== hash(receipt))) throw new Error('Previously applied recovery receipt is missing or changed.');
    if (!plan.replayed && prior && receipt.manifestBeforeSha256 !== hash(state)) throw new Error('Interrupted recovery baseline changed; operator reconciliation required.');
    if (plan.replayed) {
      for (const [name, value] of [['proposal.json', proposal], ['review.json', review]]) if (hash(await readJson(join(dir, name))) !== hash(value)) throw new Error('Applied recovery evidence is missing or changed.');
      for (const change of plan.changes) if (hash(await readJson(join(output, 'approved', change.grade, `${change.batchId}.json`))) !== hash(change.approved)) throw new Error('Applied approved recovery asset is missing or changed.');
    } else {
      // Every immutable prerequisite precedes the single manifest pointer change.
      await immutable(join(dir, 'proposal.json'), proposal, write);
      await immutable(join(dir, 'review.json'), review, write);
      await immutable(receiptPath, receipt, write);
      for (const change of plan.changes) await immutable(join(output, 'approved', change.grade, `${change.batchId}.json`), change.approved, write);
      await assertStopped(output, runtimeDirectory);
      if (write) {
        const byId = new Map(plan.changes.map(change => [change.id, change.nextSeed]));
        await atomicJson(join(output, 'manifest.json'), { ...state, words: state.words.map(seed => byId.get(seed.id) ?? seed),
          batches: { ...(state.batches ?? {}), ...Object.fromEntries(plan.changes.map(change => [change.batchId, { grade: change.grade, approved: 1, rejected: 0, reviewedAt: plan.review.reviewedAt, method: 'independent-agent-editorial-review', proposalId: plan.proposal.id }])) },
          editorialRecoveryReceipts: { ...(state.editorialRecoveryReceipts ?? {}), [plan.proposal.id]: receipt }, updatedAt: new Date().toISOString() });
      }
    }
    return { mode: write ? 'write' : 'dry-run', proposalId: plan.proposal.id, replayed: plan.replayed, approved: plan.changes.length,
      declined: plan.proposal.rows.length - plan.changes.length, batches: summary.map(row => row.batchId), paidCalls: 0 };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, runtime: { type: 'string' }, proposal: { type: 'string' }, review: { type: 'string' }, write: { type: 'boolean' } }, strict: true });
  if (!values.out || !values.runtime || !values.proposal || !values.review) throw new Error('Usage: node scripts/vocabulary-batch/editorial-recovery.mjs --out /absolute/assets --runtime /absolute/runtime --proposal /absolute/assets/reviews/proposal.json --review /absolute/assets/reviews/review.json [--write]');
  recoverEditorialCards({ output: values.out, runtimeDirectory: values.runtime, proposalPath: values.proposal, reviewPath: values.review, write: !!values.write })
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
