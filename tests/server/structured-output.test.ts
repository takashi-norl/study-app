import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { LearningPlan, PlanningTurn, Profile, StudyData } from '../../src/lib/types';
import type { StudyEvent } from '../../src/server/google-store';
import { buildPlanningContext, requestPlanningReply } from '../../src/server/planning';
import { structuredOutput, usesJsonSchemaOutput } from '../../src/server/structured-output';

const tool: Pick<Anthropic.Tool, 'name' | 'description' | 'input_schema'> = {
  name: 'return_questions', description: 'Return complete questions.', input_schema: {
    type: 'object', properties: {
      count: { type: 'integer', minimum: 1, maximum: 300 },
      questions: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', properties: {
        prompt: { type: 'string', minLength: 5, maxLength: 1200, description: 'Complete question' },
        sourceId: { type: 'string', format: 'uuid' },
        choices: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' } },
      }, required: ['prompt', 'choices', 'sourceId'] } },
      tags: { type: 'array', minItems: 1, items: { type: 'string' } },
    }, required: ['count', 'questions', 'tags'],
  },
};

function message(content: unknown[], stop_reason = 'end_turn', model = 'claude-sonnet-5-5'): Anthropic.Messages.Message {
  return { id: 'msg_mock', model, type: 'message', role: 'assistant', stop_reason, stop_sequence: null, content,
    usage: { input_tokens: 100, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as Anthropic.Messages.Message;
}
const textMessage = (value: unknown, reason = 'end_turn') => message([{ type: 'text', text: JSON.stringify(value), citations: null }], reason);
function field(value: unknown, ...path: string[]): unknown {
  for (const key of path) { assert.ok(value && typeof value === 'object'); value = (value as Record<string, unknown>)[key]; }
  return value;
}

test('legacy models keep the original forced tool and only accept its single completed result', () => {
  const output = structuredOutput('claude-sonnet-4-6', tool);
  assert.deepEqual(output.params, { tools: [tool], tool_choice: { type: 'tool', name: tool.name } });
  assert.match(output.instruction, /指定tool/);
  const block = { type: 'tool_use', id: 'tool_1', name: tool.name, input: { count: 3 } };
  assert.deepEqual(output.parse(message([block], 'tool_use')), { count: 3 });
  for (const invalid of [message([block]), message([{ ...block, name: 'different' }], 'tool_use'),
    message([block, { ...block, id: 'tool_2' }], 'tool_use'), textMessage({ count: 3 })]) {
    assert.throws(() => output.parse(invalid), { code: 'INVALID_AI_OUTPUT' });
  }
  assert.equal(usesJsonSchemaOutput('future-model'), false);
  assert.equal(usesJsonSchemaOutput('claude-sonnet-5-50'), false);
});

test('5.5 models use SDK-transformed JSON schemas, keeping limits as descriptions and the original intact', () => {
  const before = structuredClone(tool);
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5-20260928']) {
    const output = structuredOutput(model, tool);
    assert.equal(output.params.tools, undefined);
    assert.equal(output.params.tool_choice, undefined);
    assert.match(output.instruction, /JSONオブジェクトのみ/);
    const format = output.params.output_config?.format;
    assert.equal(format?.type, 'json_schema');
    assert.equal(Object.hasOwn(format!, 'parse'), false, 'SDK callbacks never enter the wire params');
    const schema = format!.schema;
    assert.equal(field(schema, 'additionalProperties'), false);
    assert.equal(field(schema, 'properties', 'questions', 'items', 'additionalProperties'), false);
    assert.equal(field(schema, 'properties', 'count', 'maximum'), undefined);
    assert.match(String(field(schema, 'properties', 'count', 'description')), /minimum: 1.*maximum: 300/);
    assert.equal(field(schema, 'properties', 'questions', 'minItems'), undefined);
    assert.equal(field(schema, 'properties', 'questions', 'maxItems'), undefined);
    assert.match(String(field(schema, 'properties', 'questions', 'description')), /maxItems: 3.*minItems: 3/);
    assert.equal(field(schema, 'properties', 'questions', 'items', 'properties', 'prompt', 'maxLength'), undefined);
    assert.match(String(field(schema, 'properties', 'questions', 'items', 'properties', 'prompt', 'description')), /Complete question[\s\S]*maxLength: 1200/);
    assert.equal(field(schema, 'properties', 'questions', 'items', 'properties', 'sourceId', 'format'), 'uuid');
    assert.equal(field(schema, 'properties', 'tags', 'minItems'), 1);
    assert.deepEqual(tool, before);
  }
});

test('JSON parsing rejects partial, refused, ambiguous and non-object responses without extracting arbitrary prose', () => {
  const output = structuredOutput('claude-haiku-5-5', tool);
  const value = { count: 3, questions: [] };
  assert.deepEqual(output.parse(message([{ type: 'thinking', thinking: 'internal', signature: 'opaque' },
    { type: 'text', text: JSON.stringify(value), citations: null }])), value);
  for (const invalid of [textMessage(value, 'refusal'), textMessage(value, 'pause_turn'), textMessage(value, 'stop_sequence'),
    textMessage([]), textMessage(null), textMessage('not an object'), message([]),
    message([{ type: 'text', text: '{broken' }]), message([{ type: 'text', text: '```json\n{}\n```' }]),
    message([{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }]),
    message([{ type: 'text', text: '{}' }, { type: 'tool_use', name: tool.name, input: {} }])]) {
    assert.throws(() => output.parse(invalid), { code: 'INVALID_AI_OUTPUT' });
  }
  assert.throws(() => output.parse(textMessage(value, 'max_tokens')), { code: 'AI_OUTPUT_TOO_LONG' });
});

const profile: Profile = { id: 'learner', familyId: 'family', role: 'student', name: 'Learner' };
const plan: LearningPlan = { id: 'plan', ownerId: profile.id, title: 'English', subject: '英語', goal: '語彙を学ぶ', difficulty: '標準', dailyQuestionTarget: 10,
  sourceIds: [], version: 2, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
const turn: PlanningTurn = { id: 'turn', planId: plan.id, requestedBy: profile.id, message: '3問を試したい', version: 2,
  status: 'queued', samplePreview: true, createdAt: plan.createdAt };
const data: StudyData = { profiles: [profile], plans: [plan], planningTurns: [], topics: [], questions: [], sources: [], jobs: [], sessions: [], attempts: [], exposures: [] };
function reply() {
  return { reply: '3問を用意しました。', proposals: [{ title: '語彙の練習', subject: '英語', description: '基本語彙を確認', instructions: '基本語彙の四択', difficulty: '標準', targetCount: 10,
    format: 'multiple-choice', sourceIds: [], samples: [0, 1, 2].map(index => ({ prompt: `英単語についての設問${index}`, choices: ['答え', '別の選択肢', '別の語', 'もう一つの語'],
      correctIndex: 0, explanation: '正しい意味を確認します。', learningPoint: `語彙${index}`, sourceIds: [], sourceNote: 'AI作成・資料なし', needsReview: false })) }] };
}
function enabled(t: TestContext) {
  for (const [key, value] of Object.entries({ AI_GENERATION_ENABLED: 'true', ANTHROPIC_API_KEY: 'unused-test-key', ANTHROPIC_MODEL: 'claude-sonnet-4-6' })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('planning selects the opt-in model and records usage before the same reply validation, with no real provider calls', async t => {
  enabled(t);
  const context = buildPlanningContext(data, [], plan, turn, profile);
  for (const policy of ['legacy', 'economy'] as const) {
    const events: StudyEvent[] = [];
    let calls = 0;
    const result = await requestPlanningReply(context, plan, turn.id, {
      modelPolicy: { profile: policy, env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' } },
      ai: { append: async event => { events.push(event); }, create: async params => {
        calls++;
        assert.equal(events[0].type, 'ai.requested');
        assert.equal(params.model, policy === 'economy' ? 'claude-sonnet-5-5' : 'claude-sonnet-4-6');
        assert.equal(params.max_tokens, 12000);
        if (policy === 'economy') {
          assert.equal(params.tools, undefined); assert.equal(params.tool_choice, undefined);
          assert.equal(params.output_config?.format?.type, 'json_schema');
          assert.doesNotMatch(String(params.system), /出力は指定toolのみ/);
          return message([{ type: 'text', text: JSON.stringify(reply()) }], 'end_turn', params.model);
        }
        assert.deepEqual(params.tool_choice, { type: 'tool', name: 'suggest_learning' });
        return message([{ type: 'tool_use', id: 'tool', name: 'suggest_learning', input: reply() }], 'tool_use', params.model);
      } },
    });
    assert.equal(calls, 1); assert.equal(result.proposals[0].samples?.length, 3);
    assert.deepEqual(events.map(event => event.type), ['ai.requested', 'ai.usage']);
    assert.equal(events[1].payload.model, policy === 'economy' ? 'claude-sonnet-5-5' : 'claude-sonnet-4-6');
    assert.equal(JSON.stringify(events).includes('英単語についての設問'), false);
  }
});

test('planning still rejects relaxed numeric and array constraints after recording usage, without paid retries', async t => {
  enabled(t);
  const context = buildPlanningContext(data, [], plan, turn, profile);
  for (const mutate of [(value: ReturnType<typeof reply>) => { value.proposals[0].targetCount = 301; },
    (value: ReturnType<typeof reply>) => { value.proposals[0].samples.pop(); },
    (value: ReturnType<typeof reply>) => { value.proposals[0].samples[0].correctIndex = 4; }]) {
    const invalid = reply(); mutate(invalid);
    const events: StudyEvent[] = [];
    let calls = 0;
    await assert.rejects(requestPlanningReply(context, plan, turn.id, { modelPolicy: { profile: 'economy', env: {} }, ai: {
      append: async event => { events.push(event); }, create: async () => { calls++; return textMessage(invalid); },
    } }));
    assert.equal(calls, 1);
    assert.deepEqual(events.map(event => event.type), ['ai.requested', 'ai.usage']);
  }
});
