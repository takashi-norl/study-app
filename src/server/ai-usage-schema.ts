import { z } from 'zod';

const id = z.string().min(1).max(200);
const tokens = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const aiRequestedSchema = z.object({
  invocationId: z.string().uuid(), requestId: id,
  feature: z.enum(['source-analysis', 'question-generation', 'planning', 'profile']),
  model: z.string().min(1).max(150),
}).strict();
export const aiUsageSchema = aiRequestedSchema.extend({
  responseId: id.nullable(), status: z.enum(['complete', 'failed']),
  inputTokens: tokens.nullable(), outputTokens: tokens.nullable(), cacheReadTokens: tokens.nullable(),
  cacheWrite5mTokens: tokens.nullable(), cacheWrite1hTokens: tokens.nullable(), cacheWriteUnknownTokens: tokens.nullable(),
  estimatedUsd: z.number().finite().min(0).nullable(),
  unknownReason: z.enum(['unknown-model', 'cache-duration-unknown', 'usage-unavailable', 'request-failed', 'unsupported-billing']).nullable(),
  pricingAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict().refine(value => (value.estimatedUsd === null) === (value.unknownReason !== null), 'Unknown cost requires a reason');
export type AiRequested = z.infer<typeof aiRequestedSchema>;
export type AiUsage = z.infer<typeof aiUsageSchema>;
