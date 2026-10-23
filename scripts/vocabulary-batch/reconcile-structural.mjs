import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicJson, readJson, withLock } from './storage.mjs';
import { generationSchema, hashVocabularyEntry, materializeEntry, validateGeneratedBatch } from './schema.mjs';
import { structuredResult } from './provider.mjs';

const mechanicalIssue = /^[a-z]+(?:[-'][a-z]+)*: (?:meaning test must select the stored meaning\.|meaning prompt must be the target lemma only\.|context answer must be the target lemma or its verb form\.|accepted synonym is a wrong choice\.|word test must select the target lemma\.)$/;
const assert = (value, message) => { if (!value) throw new Error(message); };

/** Offline, submission-scoped repair of old mechanical rejections. No provider calls.
 * Original raw responses and rejection records stay unchanged. A recovered draft is NOT
 * approved: the normal builder must still prepare/run its independent review request.
 */
export async function reconcileStructuralRejections(output, submissionId, { write = false } = {}) {
  assert(/^batch-[a-f0-9]{24}$/.test(submissionId), 'Use one exact saved submission ID.');
  return withLock(output, async () => {
    const state = await readJson(join(output, 'manifest.json'));
    assert(state.schemaVersion === 1 && Array.isArray(state.words) && hashVocabularyEntry(await readJson(join(output, 'frozen-100.json'))) === state.frozenSha256, 'Manifest or frozen snapshot failed validation.');
    const submission = await readJson(join(output, 'batches', `${submissionId}.json`));
    const ledger = await readJson(join(output, 'ledger.json'));
    assert(submission.id === submissionId && submission.status === 'complete' && Array.isArray(submission.requestIds) && new Set(submission.requestIds).size === submission.requestIds.length, 'Submission is not a complete, unique generation receipt.');
    const plans = [], held = [], skipped = [], diagnostics = [];
    for (const requestId of submission.requestIds) {
      assert(/^generate-[a-z0-9-]{1,55}$/.test(requestId), 'Submission contains a non-generation request.');
      const batchId = requestId.slice('generate-'.length), reviewId = `review-${batchId}`;
      const rejected = await readJson(join(output, 'rejected', `${batchId}.json`), null);
      if (!rejected?.entries?.length) { skipped.push({ batchId, reason: 'no-rejection-record' }); continue; }
      if (state.batches?.[batchId] || ledger.calls.some(call => call.id === reviewId)
        || await readJson(join(output, 'raw', `${reviewId}.json`), null)
        || await readJson(join(output, 'prepared', `${reviewId}.json`), null)) {
        skipped.push({ batchId, reason: 'independent-review-exists' }); continue;
      }
      if (rejected.batchId !== batchId || rejected.entries.some(item => item.review?.status !== 'rejected' || item.review.requestId !== requestId || !Array.isArray(item.review.issues) || item.review.issues.length !== 1 || !mechanicalIssue.test(item.review.issues[0]))) {
        skipped.push({ batchId, reason: 'not-an-old-mechanical-rejection' }); continue;
      }
      const seeds = rejected.entries.map(item => state.words.find(seed => seed.id === item.entry?.id));
      if (seeds.some((seed, index) => !seed || seed.frozen || seed.status !== 'rejected' || seed.batchId !== batchId || seed.word !== rejected.entries[index].entry.word)) {
        skipped.push({ batchId, reason: 'state-no-longer-mechanically-rejected' }); continue;
      }
      assert(new Set(seeds.map(seed => seed.id)).size === seeds.length && seeds.length <= 5 && new Set(seeds.map(seed => seed.grade)).size === 1, `Invalid rejected inventory for ${batchId}.`);
      const approved = await readJson(join(output, 'approved', seeds[0].grade, `${batchId}.json`), null);
      if (approved) { skipped.push({ batchId, reason: 'approval-record-exists' }); continue; }
      const receipt = ledger.calls.find(call => call.id === requestId);
      const raw = await readJson(join(output, 'raw', `${requestId}.json`));
      const prepared = await readJson(join(output, 'prepared', `${requestId}.json`));
      const result = await readJson(join(output, 'batch-results', `${requestId}.json`));
      assert(receipt?.status === 'complete' && receipt.submissionId === submissionId && receipt.providerBatchId === submission.providerBatchId, `Missing confirmed ledger receipt for ${requestId}.`);
      assert(prepared.id === requestId && raw.id === requestId && raw.providerBatchId === submission.providerBatchId && prepared.requestHash === raw.requestHash && receipt.requestHash === raw.requestHash && hashVocabularyEntry(prepared.params) === raw.requestHash, `Request integrity mismatch for ${requestId}.`);
      assert(result.custom_id === requestId && result.result?.type === 'succeeded' && hashVocabularyEntry(result.result.message) === hashVocabularyEntry(raw.response), `Raw response differs from collected result for ${requestId}.`);
      const user = prepared.params.messages?.find(message => message.role === 'user');
      assert(typeof user?.content === 'string', 'Prepared inventory prompt is missing.');
      const requested = JSON.parse(user.content).entries;
      assert(Array.isArray(requested) && requested.length === seeds.length && new Set(requested.map(item => item.word)).size === seeds.length, `Prepared inventory changed for ${requestId}.`);
      for (const seed of seeds) {
        const expected = requested.find(item => item.word === seed.word), index = state.words.findIndex(item => item.id === seed.id);
        assert(expected && expected.partOfSpeech === seed.partOfSpeech && expected.meaning === seed.meaning && expected.preferredIpaLabel === (index % 2 ? '英音' : '米音'), `Seed or voice assignment changed for ${seed.word}.`);
      }
      let candidates;
      try { candidates = generationSchema.parse(structuredResult(raw.response, 'create_vocabulary')).entries; }
      catch (error) { held.push({ batchId, words: seeds.map(seed => seed.word), reason: error.name === 'ZodError' ? 'Generated response still fails its required structure.' : String(error.message).slice(0, 500) }); continue; }
      assert(candidates.length === requested.length && new Set(candidates.map(entry => entry.word)).size === candidates.length && candidates.every(entry => requested.some(seed => seed.word === entry.word)), `Generated inventory differs from the exact submitted request ${requestId}.`);
      const checked = [], invalid = [];
      for (const candidate of candidates) {
        try { checked.push(validateGeneratedBatch({ entries: [candidate] }, [requested.find(seed => seed.word === candidate.word)])[0]); }
        catch (error) { invalid.push({ word: candidate.word, entry: candidate, issue: error.name === 'ZodError' ? 'Generated entry still fails its required structure.' : String(error.message).slice(0, 500) }); }
      }
      if (invalid.length) {
        held.push({ batchId, words: invalid.map(item => item.word), reasons: invalid.map(item => item.issue) });
        diagnostics.push({ schemaVersion: 1, batchId, requestId, responseSha256: hashVocabularyEntry(raw.response), entries: invalid });
      }
      if (!checked.length) continue;
      const recoveredSeeds = seeds.filter(seed => checked.some(entry => entry.word === seed.word));
      const recoveryBatchId = invalid.length ? `${seeds[0].grade}-recover-${hashVocabularyEntry({ requestId, ids: recoveredSeeds.map(seed => seed.id) }).slice(0, 20)}-r0` : batchId;
      const entries = checked.map(entry => {
        const seed = seeds.find(item => item.word === entry.word);
        return materializeEntry(entry, seed, state.words.findIndex(item => item.id === seed.id));
      });
      const draft = { schemaVersion: 1, batchId: recoveryBatchId, entries, generatedBy: raw.response.model, generatedRequestId: requestId,
        structuralRecovery: { version: 1, submissionId, originalBatchId: batchId, requestHash: raw.requestHash, responseSha256: hashVocabularyEntry(raw.response), rejectionSha256: hashVocabularyEntry(rejected) } };
      const previous = await readJson(join(output, 'drafts', `${recoveryBatchId}.json`), null);
      assert(!previous || hashVocabularyEntry(previous) === hashVocabularyEntry(draft), `An existing draft would be replaced for ${recoveryBatchId}.`);
      if (recoveryBatchId !== batchId) assert(!state.batches?.[recoveryBatchId] && !ledger.calls.some(call => call.id === `review-${recoveryBatchId}`)
        && !await readJson(join(output, 'prepared', `review-${recoveryBatchId}.json`), null)
        && !await readJson(join(output, 'raw', `review-${recoveryBatchId}.json`), null)
        && !await readJson(join(output, 'approved', seeds[0].grade, `${recoveryBatchId}.json`), null), `Recovered batch already entered review: ${recoveryBatchId}.`);
      plans.push({ batchId: recoveryBatchId, seeds: recoveredSeeds, draft });
    }
    // Validate the complete plan before changing any state or draft. Raw/approved/rejected
    // files are never modified, and a crash before the manifest update is safe to rerun.
    if (write && plans.length) {
      for (const plan of plans) await atomicJson(join(output, 'drafts', `${plan.batchId}.json`), plan.draft);
      for (const diagnostic of diagnostics) await atomicJson(join(output, 'structural-recovery', `${diagnostic.batchId}.json`), diagnostic);
      for (const plan of plans) for (const seed of plan.seeds) { seed.status = 'salvaged'; seed.salvageBatchId = plan.batchId; }
      state.structuralReconciliations ??= {};
      state.structuralReconciliations[submissionId] = { version: 1, reconciledAt: new Date().toISOString(), batches: plans.map(plan => ({ batchId: plan.batchId, entryCount: plan.seeds.length, ...plan.draft.structuralRecovery })) };
      state.updatedAt = new Date().toISOString();
      await atomicJson(join(output, 'manifest.json'), state);
    }
    return { mode: write ? 'written' : 'dry-run', submissionId, recoveredBatches: plans.length, recoveredEntries: plans.reduce((count, plan) => count + plan.seeds.length, 0),
      reviewPendingBatchIds: plans.map(plan => plan.batchId), held, skipped };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, submission: { type: 'string' }, write: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (!values.out || !values.submission) throw new Error('Usage: node scripts/vocabulary-batch/reconcile-structural.mjs --out /private/output --submission batch-<24hex> [--write]');
  reconcileStructuralRejections(resolve(values.out), values.submission, { write: values.write }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
