import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, hashVocabularyEntry, validateGeneratedBatch, materializeEntry, validateReview, inventorySchema, validInventoryCandidates } from './schema.mjs';
import { reserveBudget, responseCost, createProvider, messageParams, tokenCountParams, structuredResult } from './provider.mjs';
import { atomicJson, readJson, withLock } from './storage.mjs';
import { planningProvider, submitBatch, collectBatches } from './batches.mjs';
import { completeEntryPrefix, salvageResponses } from './salvage.mjs';

const seed = { id: 'vocab-apple', word: 'apple', grade: 'grade3', partOfSpeech: '名詞', meaning: 'りんご' };
function entry() {
  const choices = [{ text: 'apple', meaning: 'りんご' }, { text: 'chair', meaning: '椅子' }, { text: 'river', meaning: '川' }, { text: 'cloud', meaning: '雲' }];
  return { word: 'apple', ipa: '/ˈæpəl/', ipaLabel: '米音', partOfSpeech: '名詞', definition: 'A round fruit that grows on a tree.', meaning: 'りんご', usageTip: '数えられる名詞です。', verbForms: null, cefr: 'A1', domains: ['food'],
    examples: [{ context: '食事', text: 'I ate an apple after lunch.', translation: '昼食後にりんごを食べた。' }, { context: '買い物', text: 'These apples are cheaper than those pears.', translation: 'このりんごはあの梨より安い。' }, { context: '料理', text: 'Cut the apple into small pieces.', translation: 'りんごを小さく切って。' }],
    tests: [
      { mode: 'meaning', prompt: 'apple', choices: choices.map(item => ({ text: item.meaning, meaning: item.meaning })), correctIndex: 0, explanation: 'appleはりんごです。', alternatives: [] },
      { mode: 'word', prompt: 'りんご', choices, correctIndex: 0, explanation: 'appleはりんごです。', alternatives: [] },
      { mode: 'context', prompt: 'りんごを食べた。 I ate an ___ after lunch.', choices, correctIndex: 0, explanation: 'appleは食べられる果物です。', alternatives: [] },
      { mode: 'usage', prompt: 'appleの自然な使い方は？', choices: [{ text: 'She ate an apple.', meaning: '彼女はりんごを食べた。' }, { text: 'She apple the bus.', meaning: '動詞として使っている。' }, { text: 'The apple drove a car.', meaning: 'りんごが車を運転した。' }, { text: 'He is an apple teacher.', meaning: '不自然な修飾です。' }], correctIndex: 0, explanation: '果物として食べる文が適切です。', alternatives: [] },
    ] };
}
const response = (tool = 'result') => ({ id: 'msg-test', model: 'claude-sonnet-4-6', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'tool-test', name: tool, input: { ok: true } }] });
const input = { system: 'system', prompt: 'prompt', toolName: 'result', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, maxTokens: 1000 };
async function temporary(action) { const output = await mkdtemp(join(tmpdir(), 'hibi-text-test-')); try { return await action(output); } finally { await rm(output, { recursive: true, force: true }); } }

test('canonical content hash ignores object property order but not changed text', () => {
  assert.equal(hashVocabularyEntry({ b: 1, a: [{ y: 2, x: 3 }] }), hashVocabularyEntry({ a: [{ x: 3, y: 2 }], b: 1 }));
  assert.notEqual(hashVocabularyEntry(entry()), hashVocabularyEntry({ ...entry(), meaning: '違う' }));
  assert.equal(canonicalJson({ b: undefined, a: 1 }), '{"a":1}');
});
test('valid schema includes original3examples,4authored modes, choice meanings and audio-compatible fields', () => {
  const [validated] = validateGeneratedBatch({ entries: [entry()] }, [seed]);
  const materialized = materializeEntry(validated, seed);
  assert.equal(materialized.examples.length, 3); assert.equal(materialized.tests.length, 4);
  assert.deepEqual(materialized.examples.map(item => item.id), ['example-1', 'example-2', 'example-3']);
  assert.equal(materialized.voice, 'female'); assert.equal(materialized.level, '3級'); assert.equal(materialized.metadata.cefrEstimate, 'A1');
  assert.equal(materialized.questions[0].correctIndex, 0); assert.deepEqual(materialized.recall.answers, ['apple']);
});
test('schema rejects changed lemma, duplicate examples/modes/choices and unreviewed synonyms', () => {
  for (const mutate of [item => { item.word = 'pear'; }, item => { item.examples[1].text = item.examples[0].text; }, item => { item.tests[1].mode = 'meaning'; }, item => { item.tests[0].choices[1] = item.tests[0].choices[0]; }, item => { item.tests[2].alternatives = [{ answer: 'chair', explanation: 'wrong' }]; }, item => { item.verbForms = { base: ['apple'], past: ['appled'], pastParticiple: ['appled'], presentParticiple: ['appling'], thirdPersonSingular: ['apples'] }; }]) {
    const candidate = entry(); mutate(candidate); assert.throws(() => validateGeneratedBatch({ entries: [candidate] }, [seed]));
  }
});
test('inventory excludes inflection phrases/proper case and constrains reusable metadata', () => {
  const word = { word: 'apple', partOfSpeech: '名詞', meaning: 'りんご', cefr: 'A1', domains: ['food'] };
  assert.equal(inventorySchema.parse({ words: [word] }).words.length, 1);
  assert.throws(() => inventorySchema.parse({ words: [{ ...word, word: 'in order to' }] }));
  assert.throws(() => inventorySchema.parse({ words: [{ ...word, word: 'London' }] }));
  assert.throws(() => inventorySchema.parse({ words: [{ ...word, score: 800 }] }));
});
test('oversized inventory raw response skips malformed and duplicate candidates without changing schema', () => {
  const base = { partOfSpeech: '名詞', meaning: '意味', cefr: 'A1', domains: ['general'] };
  assert.deepEqual(validInventoryCandidates({ words: [{ ...base, word: 'known' }, { ...base, word: 'bad', domains: undefined, doms: ['general'] }, { ...base, word: 'apple' }, { ...base, word: 'apple' }, { ...base, word: 'pear' }] }, 2, new Set(['known'])).map(item => item.word), ['apple', 'pear']);
});
test('authored answer and voice metadata invariants prevent structural false positives', () => {
  const candidate = entry(); candidate.tests[1].correctIndex = 1;
  assert.throws(() => validateGeneratedBatch({ entries: [candidate] }, [seed]), /target lemma/);
  assert.throws(() => materializeEntry(entry(), seed, 1), /regional IPA/);
  assert.throws(() => validateGeneratedBatch({ entries: [entry()] }, [{ ...seed, preferredIpaLabel: '英音' }]), /assigned voice/);
  const numeric = entry(); numeric.tests[3].explanation = '正解は1です。';
  assert.throws(() => validateGeneratedBatch({ entries: [numeric] }, [seed]), /choice numbers/);
});
test('review must independently address every lemma and cannot approve with issues', () => {
  assert.equal(validateReview({ verdicts: [{ word: 'apple', approved: true, issues: [] }] }, [entry()])[0].approved, true);
  assert.throws(() => validateReview({ verdicts: [{ word: 'apple', approved: true, issues: ['Ambiguous.'] }] }, [entry()]));
  assert.throws(() => validateReview({ verdicts: [{ word: 'pear', approved: true, issues: [] }] }, [entry()]));
});
test('budget uses actual completed cost and max next reservation, hard100USD cap', () => {
  const ledger = { calls: [{ id: 'one', status: 'complete', actualUsd: 99, reservedUsd: 100 }] };
  assert.equal(reserveBudget(ledger, 'two', 1).remaining, 0);
  assert.throws(() => reserveBudget(ledger, 'two', 1.01), /budget stop/);
  assert.throws(() => reserveBudget({ calls: [] }, 'two', 1, 101));
  assert.throws(() => reserveBudget({ calls: [{ id: 'one', status: 'uncertain', reservedUsd: 1 }] }, 'two', 1), /unresolved/);
  assert.throws(() => reserveBudget(ledger, 'one', 1), /Duplicate/);
  assert.throws(() => reserveBudget({ calls: [] }, 'one', NaN));
});
test('pricing rejects unknown model or unknown counters', () => {
  assert.equal(responseCost(response()), 0.0033);
  assert.throws(() => responseCost({ ...response(), model: 'future-model' }));
  assert.throws(() => responseCost({ ...response(), usage: { input_tokens: 1, output_tokens: null } }));
});
test('5.5 uses supported structured JSON while older saved tool request parameters stay unchanged', () => {
  const modern = messageParams('claude-sonnet-5-5', input), legacy = messageParams('claude-sonnet-4-6', input);
  assert.equal(modern.tool_choice, undefined); assert.equal(modern.tools, undefined);
  assert.equal(modern.output_config.format.type, 'json_schema');
  assert.equal(tokenCountParams(modern).max_tokens, undefined);
  assert.deepEqual(tokenCountParams(modern).output_config, modern.output_config);
  assert.deepEqual(legacy.tool_choice, { type: 'tool', name: 'result' }); assert.equal(legacy.output_config, undefined);
  assert.deepEqual(structuredResult({ ...response(), content: [{ type: 'text', text: '{"ok":true}' }] }, 'result'), { ok: true });
  assert.throws(() => structuredResult({ ...response(), content: [{ type: 'text', text: 'Here is JSON: {"ok":true}' }] }, 'result'), /structured result/);
});
test('durable raw result is reusable and paid request never repeated after resume', async () => temporary(async output => {
  let calls = 0;
  const client = { messages: { countTokens: async () => ({ input_tokens: 100 }), create: async () => { calls++; assert.equal((await readJson(join(output, 'ledger.json'))).calls[0].status, 'requested'); return response(); } } };
  const provider = createProvider(output, { client });
  assert.deepEqual(await provider('one', input), { ok: true });
  assert.deepEqual(await provider('one', input), { ok: true });
  assert.equal(calls, 1);
  assert.ok((await readJson(join(output, 'raw', 'one.json'))).response.content);
  assert.equal((await readJson(join(output, 'ledger.json'))).calls[0].status, 'complete');
  await assert.rejects(provider('one', { ...input, prompt: 'changed' }), /different inputs/);
}));
test('raw result saved before parsing failures; malformed result cannot trigger paid retry', async () => temporary(async output => {
  let calls = 0;
  const provider = createProvider(output, { client: { messages: { countTokens: async () => ({ input_tokens: 100 }), create: async () => { calls++; return response('unexpected'); } } } });
  await assert.rejects(provider('one', input), /structured result/);
  assert.ok(await readFile(join(output, 'raw', 'one.json')));
  await assert.rejects(provider('one', input), /structured result/); assert.equal(calls, 1);
}));
test('saved raw provider result repairs a crash between raw persist and ledger completion', async () => temporary(async output => {
  let calls = 0;
  const provider = createProvider(output, { client: { messages: { countTokens: async () => ({ input_tokens: 100 }), create: async () => { calls++; return response(); } } } });
  await provider('one', input);
  const ledger = await readJson(join(output, 'ledger.json')); ledger.calls[0].status = 'requested'; delete ledger.calls[0].actualUsd; await atomicJson(join(output, 'ledger.json'), ledger);
  assert.deepEqual(await provider('one', input), { ok: true }); assert.equal(calls, 1);
  assert.equal((await readJson(join(output, 'ledger.json'))).calls[0].recovered, true);
}));
test('uncertain provider failure stops current and all later generation without retries', async () => temporary(async output => {
  let calls = 0;
  const provider = createProvider(output, { client: { messages: { countTokens: async () => ({ input_tokens: 100 }), create: async () => { calls++; throw new Error('timeout'); } } } });
  await assert.rejects(provider('one', input), /uncertain/);
  await assert.rejects(provider('one', input), /already sent/);
  await assert.rejects(provider('two', input), /unresolved/); assert.equal(calls, 1);
}));
test('budget stop happens before the paid provider request', async () => temporary(async output => {
  let calls = 0;
  const provider = createProvider(output, { budgetUsd: 0.001, client: { messages: { countTokens: async () => ({ input_tokens: 100 }), create: async () => { calls++; return response(); } } } });
  await assert.rejects(provider('one', input), /budget stop/); assert.equal(calls, 0);
}));
test('exclusive lock prevents two builders sharing a ledger', async () => temporary(async output => {
  await withLock(output, async () => { await assert.rejects(withLock(output, async () => {}), /Another text build/); });
  await withLock(output, async () => {});
}));
test('batch planning creates no paid request and refuses changed prepared inputs', async () => temporary(async output => {
  const plan = planningProvider(output);
  await assert.rejects(plan('one', input), error => error.code === 'BATCH_QUEUED');
  assert.equal((await readJson(join(output, 'prepared', 'one.json'))).params.model, 'claude-sonnet-4-6');
  await assert.rejects(plan('one', { ...input, prompt: 'different' }), /different inputs/);
  assert.equal(await readJson(join(output, 'ledger.json'), null), null);
}));
test('batch aggregate reservation precedes create, collection applies50percent and reusesraw', async () => temporary(async output => {
  const plan = planningProvider(output);
  await assert.rejects(plan('one', input)); await assert.rejects(plan('two', input));
  let creates = 0;
  const client = { messages: { countTokens: async () => ({ input_tokens: 100 }), batches: {
    create: async ({ requests }) => { creates++; const ledger = await readJson(join(output, 'ledger.json')); assert.equal(ledger.calls.length, 2); assert.ok(ledger.calls.every(item => item.status === 'requested')); assert.equal(requests.length, 2); return { id: 'msgbatch-test', processing_status: 'in_progress' }; },
    retrieve: async () => ({ id: 'msgbatch-test', processing_status: 'ended' }),
    results: async () => (async function* () { for (const id of ['two', 'one']) yield { custom_id: id, result: { type: 'succeeded', message: response() } }; })(),
  } } };
  const sent = await submitBatch(output, { client }); assert.equal(sent.submitted, 2);
  await assert.rejects(submitBatch(output, { client }), /outstanding/);
  const collected = await collectBatches(output, { client }); assert.equal(collected[0].status, 'complete');
  const ledger = await readJson(join(output, 'ledger.json')); assert.equal(ledger.calls[0].actualUsd, 0.00165);
  assert.deepEqual(await plan('one', input), { ok: true });
  assert.deepEqual(await submitBatch(output, { client }), { submitted: 0 }); assert.equal(creates, 1);
}));
test('batch budget cap can select only a bounded prefix before spending', async () => temporary(async output => {
  const plan = planningProvider(output);
  await assert.rejects(plan('one', input)); await assert.rejects(plan('two', input));
  let count = 0;
  const client = { messages: { countTokens: async () => ({ input_tokens: 100 }), batches: { create: async ({ requests }) => { count = requests.length; return { id: 'batch-small', processing_status: 'in_progress' }; } } } };
  const sent = await submitBatch(output, { client, budgetUsd: 0.01 });
  assert.equal(sent.submitted, 1); assert.equal(count, 1);
}));
test('provider batch wave is bounded at500 requests and refuses501 before any API operation', async () => temporary(async output => {
  let counted = 0, created = 0;
  const client = { messages: { countTokens: async () => { counted++; return { input_tokens: 100 }; }, batches: { create: async () => { created++; return { id: 'unused' }; } } } };
  assert.deepEqual(await submitBatch(output, { client, maxRequests: 500 }), { submitted: 0 });
  await assert.rejects(submitBatch(output, { client, maxRequests: 501 }), /maximum500/);
  assert.equal(counted, 0); assert.equal(created, 0);
}));
test('uncertain batch submission is never repeated and keeps all reservations', async () => temporary(async output => {
  await assert.rejects(planningProvider(output)('one', input));
  let calls = 0;
  const client = { messages: { countTokens: async () => ({ input_tokens: 100 }), batches: { create: async () => { calls++; throw new Error('private provider response'); } } } };
  await assert.rejects(submitBatch(output, { client }), /uncertain/);
  await assert.rejects(submitBatch(output, { client }), /outstanding/);
  assert.equal(calls, 1); assert.equal((await readJson(join(output, 'ledger.json'))).calls[0].status, 'uncertain');
}));
test('Haiku5.5 pricing rejects requests beyond approved short-context tier before generation', async () => temporary(async output => {
  let calls = 0;
  const provider = createProvider(output, { model: 'claude-haiku-5-5', client: { messages: { countTokens: async () => ({ input_tokens: 100001 }), create: async () => { calls++; return response(); } } } });
  await assert.rejects(provider('one', input), /context tier/); assert.equal(calls, 0);
  assert.throws(() => responseCost({ ...response(), model: 'claude-haiku-5-5', usage: { input_tokens: 100001, output_tokens: 1 } }), /price tier/);
}));
test('truncated JSON salvage extracts only fully closed objects with escaped quotes/braces', () => {
  const first = { word: 'one', text: 'A {brace}, a [bracket], and an escaped "quote" \\ end.' };
  assert.deepEqual(completeEntryPrefix(`{"entries":[${JSON.stringify(first)},{"word":"two","text":"cut`), [first]);
  assert.deepEqual(completeEntryPrefix('{"entries":[{"word":"cut'), []);
  assert.throws(() => completeEntryPrefix('prefix {"entries":[]}'), /not an entries array/);
  assert.throws(() => completeEntryPrefix('{"entries":[{"word":"one"]'), /Mismatched/);
});
test('offline salvage preserves raw/history and holds exact complete entries for separate review', async () => temporary(async output => {
  const requestId = 'generate-grade3-old-r0', batchId = 'grade3-old-r0';
  const words = [{ ...seed, frozen: false, status: 'rejected', batchId }, { ...seed, id: 'vocab-pear', word: 'pear', frozen: false, status: 'rejected', batchId }];
  await atomicJson(join(output, 'manifest.json'), { schemaVersion: 1, words });
  const ledger = { calls: [{ id: requestId, status: 'complete', requestHash: 'known', actualUsd: 0.2 }] };
  await atomicJson(join(output, 'ledger.json'), ledger);
  const raw = { id: requestId, requestHash: 'known', response: { ...response(), stop_reason: 'max_tokens', content: [{ type: 'text', text: `{"entries":[${JSON.stringify(entry())},{"word":"pear","meaning":"cut` }] } };
  const rawPath = join(output, 'raw', `${requestId}.json`); await atomicJson(rawPath, raw);
  const summary = await salvageResponses(output);
  assert.equal(summary[0].salvaged, 1); assert.deepEqual(summary[0].missingOrInvalid, ['pear']);
  const manifest = await readJson(join(output, 'manifest.json'));
  assert.equal(manifest.words[0].status, 'salvaged'); assert.equal(manifest.words[1].status, 'rejected');
  const draft = await readJson(join(output, 'drafts', `${manifest.words[0].salvageBatchId}.json`));
  assert.equal(draft.entries[0].word, 'apple'); assert.equal(draft.generatedRequestId, requestId);
  assert.deepEqual(await readJson(rawPath), raw); assert.deepEqual(await readJson(join(output, 'ledger.json')), ledger);
  assert.deepEqual(await salvageResponses(output), summary);
}));

test('5.5 batch preparation hashes the serialized wire request, not the SDK parse function', async () => temporary(async output => {
  const plan = planningProvider(output, 'claude-sonnet-5-5');
  await assert.rejects(plan('wire-payload-test', input), error => error.code === 'BATCH_QUEUED');
  const saved = await readJson(join(output, 'prepared', 'wire-payload-test.json'));
  assert.equal(hashVocabularyEntry(saved.params), saved.requestHash);
  await assert.rejects(plan('wire-payload-test', input), error => error.code === 'BATCH_QUEUED');
  const result = await submitBatch(output, { maxRequests: 1, client: { messages: {
    countTokens: async () => ({ input_tokens: 100 }),
    batches: { create: async ({requests}) => { assert.equal(requests.length, 1); return {id: 'batch-wire', processing_status: 'in_progress'}; } },
  } } });
  assert.equal(result.submitted, 1);
}));


test('confirmed in-progress batches retain full reservation while allowing bounded independent work', () => {
  const ledger = {calls:[{id:'batch-item',status:'batch_pending',providerBatchId:'msgbatch-known',submissionId:'batch-known',billing:'batch-50-percent',reservedUsd:95}]};
  assert.equal(reserveBudget(ledger,'inventory-next',4,100).remaining,1);
  assert.throws(()=>reserveBudget(ledger,'inventory-over',6,100),/budget stop/);
  assert.throws(()=>reserveBudget({calls:[{...ledger.calls[0],providerBatchId:undefined}]},'unsafe',1),/unresolved/);
});
