import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  analyzeDocument, buildQuestionGenerationContent, generateQuestions,
  type GenerationDependencies, type QuestionGenerationInput,
} from '../../src/server/generation';
import type { AiCallContext } from '../../src/server/ai-usage';
import type { AiModelProfile } from '../../src/server/ai-model-policy';

const sourceId = '11111111-1111-4111-8111-111111111111';
const otherSourceId = '22222222-2222-4222-8222-222222222222';
const context: AiCallContext = { actorId: 'owner', feature: 'question-generation', requestId: 'generation:job:batch:0' };
const questions = [
  { prompt: '【意味】古語「あはれなり」の基本的な意味として最も適切なのは？',
    choices: ['さびしい', 'おそろしい', '感慨深い', '騒がしい'], correctIndex: 2,
    explanation: '「あはれなり」は、心を動かされて感慨深く感じる様子を表す。', learningPoint: '古文単語｜あはれなり',
    sourceIds: [sourceId], sourceNote: 'テスト用教材：あはれなり、感慨深い。', needsReview: false },
  { prompt: '【意味】古語「おろかなり」の基本的な意味として最も適切なのは？',
    choices: ['いい加減だ', '美しい', '親しい', 'まぶしい'], correctIndex: 0,
    explanation: '「おろかなり」は、不十分でいい加減な様子を表す。', learningPoint: '古文単語｜おろかなり',
    sourceIds: [sourceId], sourceNote: 'テスト用教材：おろかなり、いい加減だ。', needsReview: false },
];
const input: QuestionGenerationInput = {
  title: '古文の単語', subject: '古文', questionTemplate: 'kobun-vocabulary', count: 2,
  approvedInstructions: '教材にある二語から意味を問う。例文を作る場合は自作と明記する。',
  approvedSamples: [{ ...questions[0], prompt: '【意味】「あはれなり」の意味を選んでください。' }],
  sources: [{ id: sourceId, name: 'テスト用教材', text: JSON.stringify({
    text: 'あはれなり：感慨深い。おろかなり：いい加減だ。', learningPoints: ['二語の意味'], uncertainties: ['欄外は判読不可'],
  }) }], existing: [], existingVocabulary: [],
};

type Call = NonNullable<GenerationDependencies['call']>;
type RecordedCall = { context: AiCallContext; params: Parameters<Call>[1] };

/** Exercise the real model selection, wire protocol, parsing and validators without paid requests. */
function provider(responses: unknown[], profile: AiModelProfile = 'economy', env: Record<string, string> = {}) {
  const calls: RecordedCall[] = [];
  const call: Call = async (callContext, params) => {
    const index = calls.length;
    calls.push({ context: structuredClone(callContext), params: structuredClone(params) });
    assert.ok(index < responses.length, 'An unplanned AI call or automatic retry was attempted');
    const value = responses[index];
    if (value instanceof Error) throw value;
    const json = params.output_config?.format?.type === 'json_schema';
    const tool = params.tools?.find(candidate => 'name' in candidate);
    assert.ok(json || tool, 'Every call must request structured output');
    return {
      id: `test-message-${index}`, type: 'message', role: 'assistant', model: params.model,
      stop_reason: json ? 'end_turn' : 'tool_use', stop_sequence: null,
      content: json
        ? [{ type: 'text', text: JSON.stringify(value), citations: null }]
        : [{ type: 'tool_use', id: `tool-${index}`, name: tool!.name, input: value }],
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Anthropic.Messages.Message;
  };
  return { calls, dependencies: { call, modelPolicy: { profile, env } } satisfies GenerationDependencies };
}

function textBlocks(call: RecordedCall) {
  const content = call.params.messages[0].content;
  assert.ok(Array.isArray(content));
  return content.map(block => {
    assert.equal(block.type, 'text');
    if (block.type !== 'text') throw new Error('Expected text block');
    return block;
  });
}

test('economy verifies every accepted question with Sonnet, retaining evidence, answers and separate usage identity', async () => {
  const fake = provider([{ questions }, { checks: [{ index: 1, issues: [] }, { index: 0, issues: [] }] }]);
  const result = await generateQuestions(input, context, fake.dependencies);
  assert.deepEqual(result.questions, questions);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map(call => call.params.model), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(fake.calls.map(call => call.params.output_config?.effort), ['medium', 'medium']);
  assert.deepEqual(fake.calls.map(call => call.context), [context, { ...context, requestId: `${context.requestId}:verify` }]);
  const draft = textBlocks(fake.calls[0]);
  const verification = textBlocks(fake.calls[1]);
  assert.deepEqual(verification.slice(0, 2), draft);
  assert.deepEqual(JSON.parse(draft[0].text).untrustedSources, input.sources);
  assert.deepEqual(JSON.parse(draft[0].text).untrustedApprovedSamples, input.approvedSamples);
  assert.deepEqual(JSON.parse(verification[2].text).untrustedQuestions, questions.map((question, index) => ({ index, ...question })));
  assert.match(String(fake.calls[1].params.system), /OCRの読み取り結果で原画像ではなく/);
});

test('legacy keeps one model call and forced-tool output, while economy respects explicit stage overrides', async () => {
  const legacy = provider([{ questions }], 'legacy', { ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
  assert.deepEqual((await generateQuestions(input, context, legacy.dependencies)).questions, questions);
  assert.equal(legacy.calls.length, 1);
  assert.equal(legacy.calls[0].params.model, 'claude-sonnet-4-6');
  assert.deepEqual(legacy.calls[0].params.tool_choice, { type: 'tool', name: 'create_questions' });
  assert.equal(legacy.calls[0].params.output_config, undefined);
  const legacyContent = textBlocks(legacy.calls[0]);
  assert.equal(legacyContent.length, 1);
  assert.equal(legacyContent[0].cache_control, undefined);
  assert.deepEqual(JSON.parse(legacyContent[0].text).untrustedSources, input.sources);

  const legacyJson = provider([{ questions }], 'legacy', { ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
  assert.deepEqual((await generateQuestions(input, context, legacyJson.dependencies)).questions, questions);
  assert.equal(legacyJson.calls.length, 1);
  assert.equal(legacyJson.calls[0].params.output_config?.format?.type, 'json_schema');
  assert.equal(legacyJson.calls[0].params.output_config?.effort, undefined);
  assert.equal(textBlocks(legacyJson.calls[0]).length, 1);
  assert.equal(textBlocks(legacyJson.calls[0])[0].cache_control, undefined);

  const custom = provider([{ questions }, { checks: questions.map((_, index) => ({ index, issues: [] })) }], 'economy', {
    ANTHROPIC_MODEL: 'old-global-model', ANTHROPIC_DRAFT_MODEL: 'claude-haiku-4-5', ANTHROPIC_VERIFICATION_MODEL: 'claude-sonnet-4-6',
  });
  assert.deepEqual((await generateQuestions(input, context, custom.dependencies)).questions, questions);
  assert.deepEqual(custom.calls.map(call => call.params.model), ['claude-haiku-4-5', 'claude-sonnet-4-6']);
  assert.deepEqual(custom.calls[1].params.tool_choice, { type: 'tool', name: 'verify_questions' });
  assert.equal(custom.calls[0].params.output_config, undefined);
  assert.equal(custom.calls[1].params.output_config, undefined);
});

test('one semantic defect stops the entire batch without attempting a correction or a paid retry', async () => {
  const fake = provider([{ questions }, { checks: [{ index: 0, issues: [] }, { index: 1, issues: ['別の選択肢も文脈に合う'] }] }]);
  await assert.rejects(generateQuestions(input, context, fake.dependencies), { status: 422, code: 'AI_VERIFICATION_FAILED' });
  assert.equal(fake.calls.length, 2);
});

test('missing, duplicate, out-of-range and malformed check indices cannot certify a batch', async t => {
  const cases = [
    { name: 'missing', checks: [{ index: 0, issues: [] }] },
    { name: 'duplicate', checks: [{ index: 0, issues: [] }, { index: 0, issues: [] }] },
    { name: 'out of range', checks: [{ index: 0, issues: [] }, { index: 2, issues: [] }] },
    { name: 'negative', checks: [{ index: -1, issues: [] }, { index: 1, issues: [] }] },
    { name: 'fractional', checks: [{ index: 0, issues: [] }, { index: 0.5, issues: [] }] },
    { name: 'empty issue text', checks: [{ index: 0, issues: [] }, { index: 1, issues: ['  '] }] },
    { name: 'extra check', checks: [{ index: 0, issues: [] }, { index: 1, issues: [] }, { index: 2, issues: [] }] },
  ];
  for (const example of cases) await t.test(example.name, async () => {
    const fake = provider([{ questions }, { checks: example.checks }]);
    await assert.rejects(generateQuestions(input, context, fake.dependencies), { status: 422, code: 'AI_VERIFICATION_INCOMPLETE' });
    assert.equal(fake.calls.length, 2);
  });
});

test('draft uncertainty fails before verification, including ordinary non-template questions', async () => {
  for (const subject of ['古文', '国語']) {
    const fake = provider([{ questions: [{ ...questions[0], needsReview: true }] }]);
    await assert.rejects(generateQuestions({ ...input, subject }, context, fake.dependencies), { code: 'AI_VERIFICATION_FAILED' });
    assert.equal(fake.calls.length, 1);
  }
});

test('only current input source IDs are accepted; rejected evidence does not trigger verification', async () => {
  for (const profile of ['legacy', 'economy'] as const) {
    for (const sourceIds of [[otherSourceId], [], [sourceId, otherSourceId]]) {
      const fake = provider([{ questions: [{ ...questions[0], sourceIds }] }], profile, { ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
      await assert.rejects(generateQuestions(input, context, fake.dependencies), { code: 'INVALID_QUESTION_SOURCE' });
      assert.equal(fake.calls.length, 1);
    }
    const fake = provider([{ questions: [questions[0]] }], profile, { ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
    await assert.rejects(generateQuestions({ ...input, sources: [] }, context, fake.dependencies), { code: 'INVALID_QUESTION_SOURCE' });
    assert.equal(fake.calls.length, 1);
  }
});

test('source-free approved arrangements remain usable and are still verified in economy mode', async () => {
  const arranged = questions.map(question => ({ ...question, sourceIds: [], sourceNote: '元の問題を参考に作成。' }));
  const fake = provider([{ questions: arranged }, { checks: arranged.map((_, index) => ({ index, issues: [] })) }]);
  const result = await generateQuestions({ ...input, sources: [] }, context, fake.dependencies);
  assert.deepEqual(result.questions, arranged);
  assert.equal(fake.calls.length, 2);
  assert.match(JSON.parse(textBlocks(fake.calls[1])[0].text).sourcePolicy, /原本は今回提供されていません/);
});

test('both profiles retain shape and vocabulary safeguards before any semantic verification call', async () => {
  for (const profile of ['legacy', 'economy'] as const) {
    const leak = provider([{ questions: [{ ...questions[0], prompt: '【意味】「感慨深い」という意味の「あはれなり」の意味は？' }] }], profile, { ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
    await assert.rejects(generateQuestions(input, context, leak.dependencies), { code: 'INVALID_VOCABULARY_QUESTION' });
    assert.equal(leak.calls.length, 1);
    const duplicate = provider([{ questions: [{ ...questions[0], choices: ['同じ', '同じ', '異なる', '別の語'] }] }], profile, { ANTHROPIC_MODEL: 'claude-sonnet-4-6' });
    await assert.rejects(generateQuestions(input, context, duplicate.dependencies), z.ZodError);
    assert.equal(duplicate.calls.length, 1);
  }
});

test('verification sees the exact normalized choices and answer that will be returned to learners', async () => {
  const draft = { ...questions[0], choices: questions[0].choices.map((choice, index) => `${'ABCD'[index]}. ${choice}`), learningPoint: '古文単語:あはれなり' };
  const fake = provider([{ questions: [draft] }, { checks: [{ index: 0, issues: [] }] }]);
  const result = await generateQuestions(input, context, fake.dependencies);
  assert.deepEqual(result.questions, [questions[0]]);
  const checked = JSON.parse(textBlocks(fake.calls[1])[2].text).untrustedQuestions[0];
  assert.deepEqual(checked, { index: 0, ...result.questions[0] });
  assert.equal(checked.choices[checked.correctIndex], '感慨深い');
});

test('provider failures stop immediately and a source with no usable questions incurs no verification call', async () => {
  const failure = new Error('test provider unavailable');
  for (const responses of [[failure], [{ questions }, failure]]) {
    const fake = provider(responses);
    await assert.rejects(generateQuestions(input, context, fake.dependencies), error => error === failure);
    assert.equal(fake.calls.length, responses.length);
  }
  const empty = provider([{ questions: [] }]);
  assert.deepEqual(await generateQuestions(input, context, empty.dependencies), { questions: [] });
  assert.equal(empty.calls.length, 1);
});

test('cache prefix preserves exact evidence and approval while count, coverage and prior questions stay outside it', () => {
  const before = buildQuestionGenerationContent(input);
  const after = buildQuestionGenerationContent({ ...input, count: 1, existing: ['既に作った問題'], existingVocabulary: [questions[0]] });
  assert.equal(before.length, 2);
  assert.deepEqual(before[0], after[0]);
  assert.deepEqual(before[0].cache_control, { type: 'ephemeral' });
  assert.equal(before[1].cache_control, undefined);
  assert.notEqual(before[1].text, after[1].text);
  const fixed = JSON.parse(before[0].text);
  const dynamic = JSON.parse(after[1].text);
  assert.equal(fixed.arrangement, input.approvedInstructions);
  assert.deepEqual(fixed.untrustedSources, input.sources);
  assert.deepEqual(fixed.untrustedApprovedSamples, input.approvedSamples);
  assert.equal(fixed.request, undefined);
  assert.equal(fixed.existingPrompts, undefined);
  assert.equal(fixed.vocabularyCoverage, undefined);
  assert.deepEqual(dynamic.existingPrompts, ['既に作った問題']);
  assert.deepEqual(dynamic.vocabularyCoverage, [{ learningPoint: questions[0].learningPoint, count: 1 }]);
  assert.match(dynamic.request, /最大1問/);
  const revised = buildQuestionGenerationContent({ ...input, sources: [{ ...input.sources[0], text: '修正された読み取り' }] });
  assert.notEqual(before[0].text, revised[0].text);
});

test('economy source analysis selects Haiku and retains uncertainty; output schema still rejects unusable reading', async () => {
  const reading = { text: 'あはれなり：感慨深い。', learningPoints: ['あはれなり'], uncertainties: ['欄外は判読不可'] };
  const analysisContext: AiCallContext = { ...context, feature: 'source-analysis', requestId: 'generation:job:source:page' };
  const fake = provider([reading]);
  assert.deepEqual(await analyzeDocument(new Uint8Array([1, 2, 3]), 'image/jpeg', '教材写真', analysisContext, fake.dependencies), reading);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].params.model, 'claude-haiku-5-5');
  assert.equal(fake.calls[0].params.output_config?.effort, 'medium');
  assert.deepEqual(fake.calls[0].context, analysisContext);
  const bad = provider([{ ...reading, text: '' }]);
  await assert.rejects(analyzeDocument(new Uint8Array([1]), 'application/pdf', '教材PDF', analysisContext, bad.dependencies), z.ZodError);
  assert.equal(bad.calls.length, 1);
});
