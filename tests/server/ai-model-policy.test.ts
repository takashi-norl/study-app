import assert from 'node:assert/strict';
import test from 'node:test';
import { ECONOMY_AI_MODELS, resolveAiModel, resolveAiModelProfile, type AiModelStage } from '../../src/server/ai-model-policy';

const stages: AiModelStage[] = ['source-analysis', 'question-generation', 'planning', 'question-verification', 'profile'];

test('without an explicit economy opt-in every stage preserves the configured legacy model', () => {
  for (const AI_MODEL_PROFILE of [undefined, '', 'legacy']) {
    const env = Object.freeze({ ANTHROPIC_MODEL: 'explicit-existing-model', AI_MODEL_PROFILE });
    assert.equal(resolveAiModelProfile({ env }), 'legacy');
    for (const stage of stages) assert.equal(resolveAiModel(stage, { env }), 'explicit-existing-model');
  }
});

test('economy selects Haiku for reading and drafts, Sonnet for previews and verification', () => {
  const env = Object.freeze({ ANTHROPIC_MODEL: 'explicit-existing-model', AI_MODEL_PROFILE: 'economy' });
  assert.equal(resolveAiModelProfile({ env }), 'economy');
  assert.equal(resolveAiModel('source-analysis', { env }), 'claude-haiku-5-5');
  assert.equal(resolveAiModel('question-generation', { env }), 'claude-haiku-5-5');
  assert.equal(resolveAiModel('planning', { env }), 'claude-sonnet-5-5');
  assert.equal(resolveAiModel('question-verification', { env }), 'claude-sonnet-5-5');
  assert.equal(resolveAiModel('profile', { env }), 'explicit-existing-model');
  assert.deepEqual(Object.keys(ECONOMY_AI_MODELS).sort(), stages.filter(stage => stage !== 'profile').sort());
});

test('explicit stage overrides survive either profile and cannot change other stages', () => {
  const overrides = [
    ['source-analysis', 'ANTHROPIC_SOURCE_MODEL'], ['question-generation', 'ANTHROPIC_DRAFT_MODEL'],
    ['planning', 'ANTHROPIC_PLANNING_MODEL'], ['question-verification', 'ANTHROPIC_VERIFICATION_MODEL'],
    ['profile', 'ANTHROPIC_PROFILE_MODEL'],
  ] as const;
  for (const profile of ['legacy', 'economy'] as const) {
    for (const [stage, name] of overrides) {
      const env = Object.freeze({ ANTHROPIC_MODEL: 'existing-model', [name]: ' custom-stage-model ' });
      assert.equal(resolveAiModel(stage, { env, profile }), 'custom-stage-model');
      for (const other of stages.filter(value => value !== stage)) {
        assert.notEqual(resolveAiModel(other, { env, profile }), 'custom-stage-model');
      }
    }
  }
});

test('server-selected profile is explicit and can retain legacy behavior during an economy rollout', () => {
  assert.equal(resolveAiModel('question-generation', { profile: 'legacy', env: { AI_MODEL_PROFILE: 'economy', ANTHROPIC_MODEL: 'existing-model' } }), 'existing-model');
  assert.equal(resolveAiModel('question-generation', { profile: 'economy', env: { AI_MODEL_PROFILE: 'legacy', ANTHROPIC_MODEL: 'existing-model' } }), 'claude-haiku-5-5');
  assert.equal(resolveAiModel('planning', { profile: 'economy', env: {} }), 'claude-sonnet-5-5');
  assert.throws(() => resolveAiModel('profile', { profile: 'economy', env: {} }), { code: 'NOT_CONFIGURED' });
});

test('invalid policy or explicit model configuration fails instead of silently changing spending', () => {
  assert.throws(() => resolveAiModel('planning', { env: { AI_MODEL_PROFILE: 'econmy', ANTHROPIC_MODEL: 'existing-model' } }), { code: 'INVALID_AI_MODEL_POLICY' });
  assert.throws(() => resolveAiModel('planning', { env: {} }), { code: 'NOT_CONFIGURED' });
  assert.throws(() => resolveAiModel('planning', { env: { ANTHROPIC_MODEL: '   ' } }), { code: 'NOT_CONFIGURED' });
  for (const model of ['contains whitespace', 'secret\nvalue', 'x'.repeat(151)]) {
    assert.throws(() => resolveAiModel('source-analysis', { profile: 'economy', env: { ANTHROPIC_SOURCE_MODEL: model } }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(model), false); return true;
    });
  }
  assert.throws(() => resolveAiModel('unknown' as AiModelStage, { env: { ANTHROPIC_MODEL: 'existing-model' } }), { code: 'INVALID_AI_MODEL_POLICY' });
});
