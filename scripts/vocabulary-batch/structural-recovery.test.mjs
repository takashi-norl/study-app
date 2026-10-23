import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateContextForms } from './structural-forms.mjs';
import { hashVocabularyEntry, validateGeneratedBatch, validateReview } from './schema.mjs';
import { reconcileStructuralRejections } from './reconcile-structural.mjs';
import { atomicJson, readJson } from './storage.mjs';

function entry(word = 'apple', ipaLabel = '米音') {
  const choices = [{ text: word, meaning: 'りんご' }, { text: 'chair', meaning: '椅子' }, { text: 'river', meaning: '川' }, { text: 'tree', meaning: '木' }];
  return { word, ipa: '/test/', ipaLabel, partOfSpeech: '名詞', definition: 'A fruit.', meaning: 'りんご・りんごの実', usageTip: '数えられる名詞です。', verbForms: null, cefr: 'A1', domains: ['food'],
    examples: [{ context: '食事', text: `I ate an ${word}.`, translation: 'りんごを食べた。' }, { context: '料理', text: `Cut the ${word}.`, translation: 'りんごを切って。' }, { context: '買い物', text: `Buy an ${word}.`, translation: 'りんごを買って。' }],
    tests: [
      { mode: 'meaning', prompt: `${word}（果実の意味）`, choices: choices.map(item => ({ text: item.meaning, meaning: item.meaning })), correctIndex: 0, explanation: '果実です。', alternatives: [] },
      { mode: 'word', prompt: 'りんご', choices: structuredClone(choices), correctIndex: 0, explanation: '英単語を選びます。', alternatives: [] },
      { mode: 'context', prompt: 'I bought two ___.', choices: [{ text: `${word}s`, meaning: 'りんご' }, ...structuredClone(choices.slice(1))], correctIndex: 0, explanation: '複数です。', alternatives: [] },
      { mode: 'usage', prompt: '自然な文は？', choices: ['I ate an apple.', 'I apple a chair.', 'She apple a river.', 'I am apple to work.'].map(text => ({ text, meaning: '例文です。' })), correctIndex: 0, explanation: '名詞です。', alternatives: [] },
    ] };
}
const seed = word => ({ id: `vocab-${word}`, word, grade: 'grade3', partOfSpeech: '名詞', meaning: 'りんご・りんごの実' });
test('structural validation allows a selected sense/paraphrase but does not approve its semantics', () => {
  const value = entry();
  assert.doesNotThrow(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]));
  value.tests[0].choices[0].text = '木になる丸い果実';
  assert.doesNotThrow(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]));
  // A wrong Japanese gloss cannot be decided by string equality. It remains rejectable by
  // the mandatory independent review, and structural validity never produces approval.
  value.tests[0].choices[0].text = '走る';
  const [draft] = validateGeneratedBatch({ entries: [value] }, [seed('apple')]);
  assert.equal(draft.review, undefined);
  assert.equal(validateReview({ verdicts: [{ word: 'apple', approved: false, issues: ['The selected Japanese gloss is a verb, not the fruit.'] }] }, [draft])[0].approved, false);
  assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: true, issues: ['Wrong gloss.'] }] }, [draft]));
});
test('sense-bearing prompts retain lexical identity and phrases require exact authored evidence', () => {
  const value = entry();
  value.tests[0].prompt = 'applesauce (fruit)';
  assert.throws(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]), /identify the target/);
  value.tests[0].prompt = 'apple pie';
  assert.throws(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]), /identify the target/);
  value.examples[0].text = 'I made an apple pie today.';
  assert.doesNotThrow(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]));
});
test('candidate inflections are bounded by part of speech and do not accept derivatives or arbitrary answers', () => {
  for (const [word, partOfSpeech, expected] of [['cloud', '名詞', 'clouds'], ['device', '名詞', 'devices'], ['city', '名詞', 'cities'], ['child', '名詞', 'children'], ['big', '形容詞', 'bigger'], ['happy', '形容詞', 'happiest'], ['good', '形容詞', 'better'], ['difficult', '形容詞', 'more difficult']]) assert.ok(candidateContextForms({ word, partOfSpeech }).has(expected));
  for (const [word, partOfSpeech, invalid] of [['cloud', '名詞', 'cloudy'], ['child', '名詞', 'childs'], ['good', '形容詞', 'gooder'], ['each', '代名詞', 'received'], ['off', '副詞', 'set off']]) assert.equal(candidateContextForms({ word, partOfSpeech }).has(invalid), false);
  const value = entry(); value.tests[2].choices[0].text = 'received';
  assert.throws(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]), /target lemma/);
});
test('uniqueness, word key, and alternative-as-wrong-choice guards remain mandatory', () => {
  for (const mutate of [value => { value.tests[0].choices[1] = value.tests[0].choices[0]; }, value => { value.tests[1].correctIndex = 1; }, value => { value.tests[2].alternatives = [{ answer: 'chair', explanation: 'This must be rejected.' }]; }]) {
    const value = entry(); mutate(value); assert.throws(() => validateGeneratedBatch({ entries: [value] }, [seed('apple')]));
  }
});

const submissionId = `batch-${'0'.repeat(24)}`, batchId = 'grade3-test-r0', requestId = `generate-${batchId}`;
async function fixture(action, partial = false) {
  const root = await mkdtemp(join(tmpdir(), 'vocabulary-reconcile-'));
  try {
    const entries = [entry(), entry('cloud', '英音')];
    if (partial) entries[1].tests[2].choices[0].text = 'received';
    const seeds = ['apple', 'cloud'].map(word => ({ ...seed(word), frozen: false, status: 'rejected', batchId, attempt: 0 }));
    const requested = seeds.map((item, index) => ({ word: item.word, partOfSpeech: item.partOfSpeech, meaning: item.meaning, preferredIpaLabel: index ? '英音' : '米音' }));
    const params = { model: 'fixture', messages: [{ role: 'user', content: JSON.stringify({ entries: requested }) }] }, requestHash = hashVocabularyEntry(params);
    const response = { model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ entries }) }] };
    const rejected = { schemaVersion: 1, batchId, entries: seeds.map(item => ({ entry: { id: item.id, word: item.word }, review: { status: 'rejected', requestId, issues: ['apple: meaning test must select the stored meaning.'] } })) };
    for (const [file, data] of Object.entries({
      'frozen-100.json': [], 'manifest.json': { schemaVersion: 1, words: seeds, batches: {}, frozenSha256: hashVocabularyEntry([]) },
      'ledger.json': { calls: [{ id: requestId, status: 'complete', requestHash, submissionId, providerBatchId: 'provider-batch' }] },
      [`batches/${submissionId}.json`]: { id: submissionId, status: 'complete', requestIds: [requestId], providerBatchId: 'provider-batch' },
      [`prepared/${requestId}.json`]: { id: requestId, requestHash, params },
      [`raw/${requestId}.json`]: { id: requestId, requestHash, response, providerBatchId: 'provider-batch' },
      [`batch-results/${requestId}.json`]: { custom_id: requestId, result: { type: 'succeeded', message: response } },
      [`rejected/${batchId}.json`]: rejected,
    })) await atomicJson(join(root, file), data);
    await action(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('submission-scoped recovery is offline, idempotent, preserves raw evidence and keeps cards unapproved', () => fixture(async root => {
  const manifestBefore = await readFile(join(root, 'manifest.json'), 'utf8'), rawBefore = await readFile(join(root, 'raw', `${requestId}.json`), 'utf8'), rejectedBefore = await readFile(join(root, 'rejected', `${batchId}.json`), 'utf8');
  assert.equal((await reconcileStructuralRejections(root, submissionId)).recoveredEntries, 2);
  assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), manifestBefore);
  assert.equal((await reconcileStructuralRejections(root, submissionId, { write: true })).recoveredEntries, 2);
  const state = await readJson(join(root, 'manifest.json'));
  assert.ok(state.words.every(item => item.status === 'salvaged' && item.salvageBatchId === batchId));
  const draft = await readJson(join(root, 'drafts', `${batchId}.json`));
  assert.equal(draft.entries.length, 2); assert.equal(draft.review, undefined);
  assert.equal(await readFile(join(root, 'raw', `${requestId}.json`), 'utf8'), rawBefore);
  assert.equal(await readFile(join(root, 'rejected', `${batchId}.json`), 'utf8'), rejectedBefore);
  assert.equal((await reconcileStructuralRejections(root, submissionId, { write: true })).recoveredEntries, 0);
}));
test('a bad card does not force regeneration of good siblings, and its exact entry and issue remain recorded', () => fixture(async root => {
  const report = await reconcileStructuralRejections(root, submissionId, { write: true });
  assert.equal(report.recoveredEntries, 1); assert.deepEqual(report.held[0].words, ['cloud']);
  assert.match(report.reviewPendingBatchIds[0], /^grade3-recover-/);
  const state = await readJson(join(root, 'manifest.json'));
  assert.equal(state.words[0].status, 'salvaged'); assert.equal(state.words[1].status, 'rejected');
  const failed = await readJson(join(root, 'structural-recovery', `${batchId}.json`));
  assert.equal(failed.entries[0].entry.tests[2].choices[0].text, 'received');
  assert.match(failed.entries[0].issue, /target lemma/);
}, true));
test('actual AI rejection or any existing independent review can never be resurrected', () => fixture(async root => {
  const rejected = await readJson(join(root, 'rejected', `${batchId}.json`));
  rejected.entries[0].review.requestId = `review-${batchId}`;
  await atomicJson(join(root, 'rejected', `${batchId}.json`), rejected);
  assert.equal((await reconcileStructuralRejections(root, submissionId, { write: true })).recoveredEntries, 0);
  rejected.entries[0].review.requestId = requestId;
  await atomicJson(join(root, 'rejected', `${batchId}.json`), rejected);
  await atomicJson(join(root, 'prepared', `review-${batchId}.json`), { id: `review-${batchId}` });
  assert.equal((await reconcileStructuralRejections(root, submissionId, { write: true })).recoveredEntries, 0);
}));
test('tampered raw or submitted parameters fail before the manifest changes', () => fixture(async root => {
  const before = await readFile(join(root, 'manifest.json'), 'utf8');
  const raw = await readJson(join(root, 'raw', `${requestId}.json`)); raw.response.content[0].text += ' ';
  await atomicJson(join(root, 'raw', `${requestId}.json`), raw);
  await assert.rejects(reconcileStructuralRejections(root, submissionId, { write: true }), /differs from collected/);
  assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), before);
}));
