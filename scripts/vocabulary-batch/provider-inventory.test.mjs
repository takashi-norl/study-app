import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { messageParams, tokenCountParams } from './provider.mjs';
import { hashVocabularyEntry } from './schema.mjs';

const input = { system: 'inventory system', prompt: 'inventory prompt', toolName: 'inventory_words', schema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } }, required: ['words'], additionalProperties: false }, maxTokens: 10000 };

test('Haiku 5.5 inventory disables hidden thinking while retaining JSON output and its spending limit', () => {
  const params = messageParams('claude-haiku-5-5', input);
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.max_tokens, 10000);
  assert.equal(params.tools, undefined);
  assert.deepEqual(tokenCountParams(params).thinking, params.thinking);
  assert.equal(tokenCountParams(params).max_tokens, undefined);
});

test('generation, review, Sonnet inventory, and legacy inventory preserve their prior request settings', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
    for (const toolName of ['generate_vocabulary', 'review_vocabulary']) {
      const params = messageParams(model, { ...input, toolName });
      assert.equal(params.thinking, undefined);
      assert.equal(params.output_config.effort, toolName === 'review_vocabulary' ? 'medium' : 'low');
    }
  }
  assert.equal(messageParams('claude-sonnet-5-5', input).thinking, undefined);
  for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']) {
    const params = messageParams(model, input);
    assert.equal(params.thinking, undefined);
    assert.equal(params.output_config, undefined);
    assert.deepEqual(params.tool_choice, { type: 'tool', name: 'inventory_words' });
  }
});

test('only the new Haiku inventory request hash changes; other modern saved request hashes remain identical', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
    for (const toolName of ['inventory_words', 'generate_vocabulary', 'review_vocabulary']) {
      const prior = { model, max_tokens: input.maxTokens, system: `${input.system}\nFor this request return only the JSON object matching the output schema; no tool call.`, messages: [{ role: 'user', content: input.prompt }], output_config: { effort: toolName === 'review_vocabulary' ? 'medium' : 'low', format: jsonSchemaOutputFormat(input.schema) } };
      const actualHash = hashVocabularyEntry(messageParams(model, { ...input, toolName }));
      const priorHash = hashVocabularyEntry(prior);
      if (model === 'claude-haiku-5-5' && toolName === 'inventory_words') assert.notEqual(actualHash, priorHash);
      else assert.equal(actualHash, priorHash);
    }
  }
});
