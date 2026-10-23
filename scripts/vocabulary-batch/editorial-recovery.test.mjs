import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashVocabularyEntry as hash, materializeEntry } from './schema.mjs';
import { planEditorialRecovery, recoverEditorialCards, validateEditorialCard } from './editorial-recovery.mjs';

const put = async (file, data) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data)); };
const read = async file => JSON.parse(await readFile(file, 'utf8'));
function generated() {
  const choices = ['apple', 'chair', 'river', 'cloud'].map((text, index) => ({ text, meaning: ['りんご', '椅子', '川', '雲'][index] }));
  return { word: 'apple', ipa: '/ˈæpəl/', ipaLabel: '米音', partOfSpeech: '名詞', definition: 'A round fruit.', meaning: 'りんご', usageTip: '数えられる名詞です。', verbForms: null, cefr: 'A1', domains: ['food'],
    examples: ['I ate an apple.', 'She bought two apples.', 'Cut the apple in half.'].map(text => ({ context: '食事', text, translation: 'りんごの例文です。' })),
    tests: ['meaning', 'word', 'context', 'usage'].map(mode => ({ mode, prompt: mode === 'context' ? 'I ate an ___.' : mode === 'meaning' ? 'apple' : 'りんご',
      choices: mode === 'meaning' ? choices.map(choice => ({ text: choice.meaning, meaning: choice.meaning })) : choices,
      correctIndex: 0, explanation: 'りんごの意味です。', alternatives: [] })) };
}
function data() {
  const seed = { id: 'vocab-apple', word: 'apple', partOfSpeech: '名詞', meaning: 'りんご', grade: 'grade3', status: 'rejected', attempt: 2, frozen: false, batchId: 'grade3-apple-r2' };
  const source = generated(), entry = materializeEntry(source, seed, 0), id = `generate-${seed.batchId}`;
  const params = { model: 'test-model', messages: [{ role: 'user', content: JSON.stringify({ entries: [{ ...seed, preferredIpaLabel: '米音' }] }) }] };
  const prepared = { id, requestHash: hash(params), params };
  const raw = { id, requestHash: hash(params), response: { model: 'test-model', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ entries: [source] }) }] } };
  const rejection = { schemaVersion: 1, batchId: seed.batchId, entries: [{ entry, review: { status: 'rejected', issues: ['The old reviewer requested an independent check.'] } }] };
  const row = { word: seed.word, seedHash: hash(seed), seed, entry, contentSha256: hash(entry), rejectionFile: '/placeholder/rejection.json', rejectionSha256: hash(rejection), rawFile: '/placeholder/raw.json', rawSha256: hash(raw), issues: rejection.entries[0].review.issues, structural: null };
  const proposal = { schemaVersion: 1, id: 'editorial-test', createdBy: 'author', rows: [row] };
  const review = { schemaVersion: 1, proposalSha256: hash(proposal), reviewedBy: 'independent', reviewedAt: '2026-10-24T00:00:00.000Z', verdicts: [{ word: row.word, contentSha256: row.contentSha256, approved: true, issues: [] }] };
  const ledger = { schemaVersion: 1, calls: [{ id, requestHash: raw.requestHash, model: 'test-model', status: 'complete', actualUsd: 0.02, reservedUsd: 1 }] };
  return { state: { schemaVersion: 1, words: [seed], batches: {} }, proposal, review, ledger, evidence: new Map([[seed.word, { raw, rejection, prepared }]]) };
}
function rebind(d) { d.review.proposalSha256 = hash(d.proposal); d.review.verdicts[0].contentSha256 = d.proposal.rows[0].contentSha256; }
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-editorial-')), d = data(), output = join(root, 'assets'), runtimeDirectory = join(root, 'runtime');
  const proposalPath = join(output, 'reviews', 'proposal.json'), reviewPath = join(output, 'reviews', 'review.json');
  const row = d.proposal.rows[0], saved = d.evidence.get('apple');
  row.rawFile = join(output, 'raw', `${saved.raw.id}.json`); row.rejectionFile = join(output, 'rejected', `${row.seed.batchId}.json`); rebind(d);
  d.state.frozenSha256 = hash([]);
  try {
    await put(join(output, 'manifest.json'), d.state); await put(join(output, 'frozen-100.json'), []); await put(join(output, 'ledger.json'), d.ledger);
    await put(row.rawFile, saved.raw); await put(row.rejectionFile, saved.rejection); await put(join(output, 'prepared', `${saved.prepared.id}.json`), saved.prepared);
    await mkdir(join(output, 'audio', 'reservations'), { recursive: true }); await mkdir(runtimeDirectory, { recursive: true }); await writeFile(join(runtimeDirectory, 'stop-production'), '');
    await put(proposalPath, d.proposal); await put(reviewPath, d.review);
    return await action({ ...d, root, output, runtimeDirectory, proposalPath, reviewPath });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('full card validation catches changed derived answers, voice, example IDs and metadata', () => {
  const d = data(), row = d.proposal.rows[0]; validateEditorialCard(row.entry, row.seed, 0);
  for (const mutate of [e => { e.recall.answers = ['chair']; }, e => { e.voice = 'male'; }, e => { e.examples[0].id = 'example-9'; }, e => { e.metadata.levelPolicy = 'official'; }, e => { e.questions[0].correctIndex = 2; }]) {
    const entry = structuredClone(row.entry); mutate(entry); assert.throws(() => validateEditorialCard(entry, row.seed, 0), /mirrors/);
  }
});
test('independent exact full-card approval creates a new stable batch and preserves original request attribution', () => {
  const d = data(), before = hash(d.state), plan = planEditorialRecovery(d), change = plan.changes[0];
  assert.equal(hash(d.state), before); assert.equal(change.nextSeed.status, 'approved'); assert.equal(change.nextSeed.attempt, 2);
  assert.match(change.batchId, /^grade3-editorial-[a-f0-9]{20}$/);
  assert.deepEqual(change.approved.entries[0].entry, d.proposal.rows[0].entry);
  assert.equal(change.approved.entries[0].review.method, 'independent-agent-editorial-review');
  assert.equal(change.approved.entries[0].review.reviewedBy, 'independent');
  assert.equal(change.approved.entries[0].provenance.generatedRequestId, d.ledger.calls[0].id);
});
test('partial review only recovers approved rows; declined cards cannot be silently approved', () => {
  const d = data(); d.review.verdicts[0].approved = false; d.review.verdicts[0].issues = ['Needs a further correction.'];
  assert.equal(planEditorialRecovery(d).changes.length, 0);
  d.review.verdicts[0].approved = true; assert.throws(() => planEditorialRecovery(d), /issues only/);
});
test('stale status, wrong attempt, frozen/held/excluded and self-reviewed proposals fail closed', () => {
  for (const mutate of [d => { d.state.words[0].status = 'approved'; }, d => { d.state.words[0].attempt = 1; }, d => { d.state.words[0].frozen = true; },
    d => { d.state.words[0].inventoryHold = { reviewId: 'hold' }; }, d => { d.state.words[0].catalogDisposition = {}; }, d => { d.review.reviewedBy = 'author'; }]) {
    const d = data(); mutate(d); assert.throws(() => planEditorialRecovery(d));
  }
});
test('paid raw, rejected evidence, prepared parameters and ledger identity are independently verified', () => {
  for (const mutate of [d => { d.evidence.get('apple').raw.response.content[0].text = '{}'; }, d => { d.evidence.get('apple').rejection.entries[0].review.issues = ['new']; },
    d => { d.evidence.get('apple').prepared.params.model = 'changed'; }, d => { d.ledger.calls[0].requestHash = '0'.repeat(64); }, d => { d.ledger.calls[0].status = 'uncertain'; }]) {
    const d = data(); mutate(d); assert.throws(() => planEditorialRecovery(d));
  }
});
test('legacy synchronous raw can be recovered without prepared file; batch requests cannot use that exception', () => {
  const d = data(); d.evidence.get('apple').prepared = null;
  assert.equal(planEditorialRecovery(d).changes[0].approved.entries[0].provenance.editorialRecovery.requestEvidence, 'synchronous-ledger-and-raw');
  d.ledger.calls[0].providerBatchId = 'provider-batch'; assert.throws(() => planEditorialRecovery(d), /requires its saved prepared/);
});
test('targeted corrections bind old complete raw and new reviewed card, with no invented source', () => {
  const d = data(), row = d.proposal.rows[0]; row.originalContentSha256 = row.contentSha256;
  const changed = generated(); changed.tests[0].explanation = '独立レビュー対象の修正された説明です。';
  row.entry = materializeEntry(changed, row.seed, 0); row.contentSha256 = hash(row.entry); row.changes = 'Clarified a test explanation.'; rebind(d);
  assert.equal(planEditorialRecovery(d).changes.length, 1);
  row.originalContentSha256 = '0'.repeat(64); rebind(d); assert.throws(() => planEditorialRecovery(d), /saved paid raw/);
});
test('reviewed correction notes may be a nonempty string array without rewriting proposal content', () => {
  const d = data(), row = d.proposal.rows[0]; row.originalContentSha256 = row.contentSha256;
  const changed = generated(); changed.usageTip = '可算名詞なので冠詞と複数形にも注意します。';
  row.entry = materializeEntry(changed, row.seed, 0); row.contentSha256 = hash(row.entry);
  row.changes = ['Clarified countability.', 'Spoken examples preserved.']; rebind(d);
  const originalHash = hash(d.proposal), plan = planEditorialRecovery(d);
  assert.deepEqual(plan.changes[0].approved.entries[0].provenance.editorialRecovery.changes, row.changes);
  assert.equal(hash(d.proposal), originalHash);
  row.changes = []; rebind(d); assert.throws(() => planEditorialRecovery(d));
});
test('filesystem apply is offline, preserves old paid evidence, then replays without any second change', async () => fixture(async f => {
  const files = [join(f.output, 'ledger.json'), f.proposal.rows[0].rawFile, f.proposal.rows[0].rejectionFile, join(f.output, 'frozen-100.json')];
  const before = await Promise.all(files.map(file => readFile(file, 'utf8'))), manifestBefore = await readFile(join(f.output, 'manifest.json'), 'utf8');
  assert.equal((await recoverEditorialCards(f)).mode, 'dry-run'); assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), manifestBefore);
  const result = await recoverEditorialCards({ ...f, write: true }); assert.equal(result.approved, 1); assert.equal(result.paidCalls, 0);
  const manifestAfter = await readFile(join(f.output, 'manifest.json'), 'utf8');
  assert.equal((await recoverEditorialCards({ ...f, write: true })).replayed, true);
  assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), manifestAfter);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.ok((await read(join(f.output, 'manifest.json'))).editorialRecoveryReceipts['editorial-test']);
}));
test('interruption after immutable evidence but before pointer commit recovers exactly once', async () => fixture(async f => {
  const before = await readFile(join(f.output, 'manifest.json'), 'utf8');
  const first = await recoverEditorialCards({ ...f, write: true });
  const approvedPath = join(f.output, 'approved', 'grade3', `${first.batches[0]}.json`), approvedBefore = await readFile(approvedPath, 'utf8');
  await writeFile(join(f.output, 'manifest.json'), before);
  assert.equal((await recoverEditorialCards({ ...f, write: true })).approved, 1);
  assert.equal(await readFile(approvedPath, 'utf8'), approvedBefore);
  assert.equal((await recoverEditorialCards({ ...f, write: true })).replayed, true);
}));
test('missing saved applied asset or review evidence cannot be silently recreated', async () => fixture(async f => {
  const result = await recoverEditorialCards({ ...f, write: true });
  await rm(join(f.output, 'approved', 'grade3', `${result.batches[0]}.json`));
  await assert.rejects(recoverEditorialCards({ ...f, write: true }), /ENOENT/);
}));
test('stop marker, process locks, pending billing and unknown audio outcomes all block', async () => {
  const mutations = [
    async f => rm(join(f.runtimeDirectory, 'stop-production')),
    async f => mkdir(join(f.runtimeDirectory, 'production.lock')),
    async f => mkdir(join(f.output, '.text-build-lock')),
    async f => mkdir(join(f.output, 'audio', 'batch.lock')),
    async f => put(join(f.output, 'ledger.json'), { calls: [{ status: 'batch_pending' }] }),
    async f => put(join(f.output, 'audio', 'reservations', `${'a'.repeat(64)}.json`), { cacheKey: 'a'.repeat(64), requestId: 'unknown', characters: 100, reservedMicroUsd: 18200 }),
  ];
  for (const mutate of mutations) await fixture(async f => {
    const before = await readFile(join(f.output, 'manifest.json'), 'utf8'); await mutate(f);
    await assert.rejects(recoverEditorialCards({ ...f, write: true }), /checkpoint|lock|settled/);
    assert.equal(await readFile(join(f.output, 'manifest.json'), 'utf8'), before);
  });
});
test('realpath containment rejects external or symlink-escaped paid evidence before apply', async () => fixture(async f => {
  const row = f.proposal.rows[0], outside = join(f.root, 'outside.json');
  await put(outside, f.evidence.get('apple').raw); await rm(row.rawFile); await symlink(outside, row.rawFile);
  await assert.rejects(recoverEditorialCards({ ...f, write: true }), /escaped/);
}));
