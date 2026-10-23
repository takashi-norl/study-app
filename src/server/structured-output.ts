import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { ApiError } from './config';

type OutputTool = Pick<Anthropic.Tool, 'name' | 'description' | 'input_schema'>;
type OutputResponse = Pick<Anthropic.Messages.Message, 'content' | 'stop_reason'>;
type OutputParams = Pick<Anthropic.Messages.MessageCreateParamsNonStreaming, 'tools' | 'tool_choice' | 'output_config'>;

/** Explicit known family only; an unrelated or future model keeps the existing tool protocol. */
export function usesJsonSchemaOutput(model: string): boolean {
  return /^claude-(sonnet|haiku|opus)-5-5(?:-\d{8})?$/.test(model);
}

function invalidOutput(): never {
  throw new ApiError(422, 'AIから有効な形式の返答を受け取れませんでした。', 'INVALID_AI_OUTPUT');
}

/**
 * Adapt transport only. Callers must validate the returned unknown with their original business schema.
 * The SDK moves unsupported bounds into descriptions and closes nested objects without mutating input.
 * This helper never sends a request: callers retain trackedAnthropicMessage's durable usage receipts.
 */
export function structuredOutput(model: string, tool: OutputTool): {
  params: OutputParams; instruction: string; parse: (response: OutputResponse) => unknown;
} {
  const json = usesJsonSchemaOutput(model);
  const schema = { ...tool.input_schema, required: tool.input_schema.required ?? undefined };
  // Tool.InputSchema allows arbitrary unknown fields; these schemas are static server-owned JSON Schema.
  const format = json ? jsonSchemaOutputFormat(schema as Parameters<typeof jsonSchemaOutputFormat>[0]) : undefined;
  // Keep only the wire format; the SDK's parse callback is not a provider request parameter.
  const params: OutputParams = format
    ? { output_config: { format: { type: 'json_schema', schema: format.schema } } }
    : { tools: [tool], tool_choice: { type: 'tool', name: tool.name } };
  return {
    params,
    instruction: json
      ? `出力は指定JSONスキーマに従うJSONオブジェクトのみ。前置き・Markdown・コードブロックは付けません。${tool.description ?? ''}`
      : `出力は指定tool「${tool.name}」のみ。`,
    parse(response) {
      if (response.stop_reason === 'max_tokens') throw new ApiError(422, 'AIの返事が長くなりすぎました。', 'AI_OUTPUT_TOO_LONG');
      let value: unknown;
      if (json) {
        if (response.stop_reason !== 'end_turn' || response.content.some(block => block.type === 'tool_use')) return invalidOutput();
        const blocks = response.content.filter(block => block.type === 'text');
        if (blocks.length !== 1 || blocks[0].type !== 'text') return invalidOutput();
        try { value = JSON.parse(blocks[0].text); } catch { return invalidOutput(); }
      } else {
        if (response.stop_reason !== 'tool_use') return invalidOutput();
        const blocks = response.content.filter(block => block.type === 'tool_use');
        if (blocks.length !== 1 || blocks[0].type !== 'tool_use' || blocks[0].name !== tool.name) return invalidOutput();
        value = blocks[0].input;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidOutput();
      return value;
    },
  };
}
