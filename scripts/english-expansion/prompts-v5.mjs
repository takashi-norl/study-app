import { z } from 'zod';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { generationOutputSchema, reviewOutputSchema, parseGenerated, parseReviewed } from './prompts.mjs';
import { canonicalJson, hashContent, normalizeForm, validateSeed, validateUnit } from './schema.mjs';

export const PROMPT_VERSION = 'v5';
export const AUTHOR_ID_V5 = 'anthropic-expansion-author-v5';
export const REVIEWER_ID_V5 = 'anthropic-expansion-independent-reviewer-v5';
// Reuse the frozen v4 language-quality instructions verbatim. Only the version,
// single-item boundary and explicit generation thinking policy differ.
import { AUTHOR_SYSTEM_V4, AUTHOR_TASK_V4, REVIEW_SYSTEM_V4, REVIEW_TASK_V4 } from './prompts-v4.mjs';
export const AUTHOR_SYSTEM_V5 = AUTHOR_SYSTEM_V4;
export const AUTHOR_TASK_V5 = AUTHOR_TASK_V4;
export const REVIEW_SYSTEM_V5 = REVIEW_SYSTEM_V4;
export const REVIEW_TASK_V5 = REVIEW_TASK_V4;

const workId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const format = schema => JSON.parse(JSON.stringify(jsonSchemaOutputFormat(z.toJSONSchema(schema, { target: 'draft-7' }))));
export const GENERATION_POLICY_V5 = Object.freeze({ promptVersion: PROMPT_VERSION, model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 16000, thinking: { type: 'disabled' },
  serviceTier: 'standard_only', inferenceGeo: 'global', system: AUTHOR_SYSTEM_V5, task: AUTHOR_TASK_V5, format: format(generationOutputSchema) });
export const REVIEW_POLICY_V5 = Object.freeze({ promptVersion: PROMPT_VERSION, model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 8000,
  serviceTier: 'standard_only', inferenceGeo: 'global', system: REVIEW_SYSTEM_V5, task: REVIEW_TASK_V5, format: format(reviewOutputSchema) });
export const GENERATION_POLICY_SHA256_V5 = hashContent(GENERATION_POLICY_V5);
export const REVIEW_POLICY_SHA256_V5 = hashContent(REVIEW_POLICY_V5);

function identity(id, createdAt, rows) {
  if (!workId.safeParse(id).success || !z.string().datetime().safeParse(createdAt).success || rows.length !== 1 || rows.some(row => row.kind !== 'phrase')
    || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('The v5 benchmark needs a stable ID/date and exactly one phrase.');
}
function params(policy, payload) {
  return JSON.parse(JSON.stringify({ model: policy.model, max_tokens: policy.maxTokens, service_tier: policy.serviceTier, inference_geo: policy.inferenceGeo,
    ...(policy.thinking ? { thinking: policy.thinking } : {}), system: policy.system, messages: [{ role: 'user', content: canonicalJson(payload) }], output_config: { effort: policy.effort, format: policy.format } }));
}
export function generationWorkV5(seeds, { model = GENERATION_POLICY_V5.model, createdAt, id } = {}) {
  if (model !== GENERATION_POLICY_V5.model) throw new Error('The v5 generation model is fixed to its Haiku benchmark policy.');
  const checked = seeds.map(validateSeed); identity(id, createdAt, checked);
  return { promptVersion: PROMPT_VERSION, id, stage: 'generation', unitIds: checked.map(seed => seed.id), seeds: checked, createdAt,
    params: params(GENERATION_POLICY_V5, { workflow: { promptVersion: PROMPT_VERSION, id, createdAt }, task: AUTHOR_TASK_V5, seeds: checked }) };
}
export function reviewWorkV5(units, { model = REVIEW_POLICY_V5.model, createdAt, id } = {}) {
  if (model !== REVIEW_POLICY_V5.model) throw new Error('The v5 review model is fixed to its independent Sonnet policy.');
  const checked = units.map(validateUnit); identity(id, createdAt, checked);
  return { promptVersion: PROMPT_VERSION, id, stage: 'review', unitIds: checked.map(unit => unit.id), units: checked, createdAt,
    params: params(REVIEW_POLICY_V5, { workflow: { promptVersion: PROMPT_VERSION, id, createdAt }, task: REVIEW_TASK_V5,
      units: checked.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit), unit })) }) };
}
export function checkedWorkV5(work) {
  if (work?.promptVersion !== PROMPT_VERSION || !['generation', 'review'].includes(work?.stage)) throw new Error('Expected exact v5 benchmark work.');
  const options = { id: work.id, createdAt: work.createdAt, model: work.params?.model };
  const expected = work.stage === 'generation' ? generationWorkV5(work.seeds, options) : reviewWorkV5(work.units, options);
  if (hashContent(expected) !== hashContent(work)) throw new Error('The v5 work differs from its fixed prompt, payload or model policy.');
  return work;
}
export function parseGeneratedV5(response, work) {
  checkedWorkV5(work);
  if (work.stage !== 'generation') throw new Error('Expected v5 generation work.');
  return parseGenerated(response, work).map(unit => {
    const allowed = new Set([unit.lemma, ...unit.aliases].map(normalizeForm));
    for (const sense of unit.senses) {
      const context = sense.tests.find(test => test.mode === 'context');
      if (!allowed.has(normalizeForm(context.choices[context.correctIndex].text))) throw new Error('The v5 context answer must preserve the registered lemma or reviewed alias. Keep raw; no automatic retry.');
    }
    return validateUnit({ ...unit, provenance: { ...unit.provenance, author: AUTHOR_ID_V5 } });
  });
}
export function parseReviewedV5(response, work, reviewedAt = work.createdAt) {
  checkedWorkV5(work);
  if (work.stage !== 'review') throw new Error('Expected v5 review work.');
  return parseReviewed(response, work, reviewedAt).map(({ unit, receipt }) => ({ unit, receipt: { ...receipt, reviewer: REVIEWER_ID_V5 } }));
}
