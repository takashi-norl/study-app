import { z } from 'zod';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { AUTHOR_SYSTEM, AUTHOR_TASK, REVIEW_SYSTEM, generationOutputSchema, reviewOutputSchema, jsonResult, parseGenerated, parseReviewed } from './prompts.mjs';
import { canonicalJson, hashContent, unitSchema, validateSeed, validateUnit } from './schema.mjs';

export const PROMPT_VERSION = 'v2';
export const AUTHOR_ID_V2 = 'anthropic-expansion-author-v2';
export const REVIEWER_ID_V2 = 'anthropic-expansion-independent-reviewer-v2';
export const QUESTION_QUALITY_V2 = `Quality requirements for every question:
- Meaning: distinguish the target sense from genuinely confusable meanings. Do not add unsupported properties such as "lasting" when the word need not imply duration.
- Word: the correct answer is the canonical lemma OR a form explicitly present in the supplied reviewed aliases. Use four comparable lexical options; do not invent spellings or unauthorized synonyms as correct answers.
- Context: all four choices should have comparable parts of speech and forms that can grammatically occupy the blank. The decision should primarily test meaning, collocation or the specified intention, not merely one correctly inflected form among three broken forms. A multiword expression must retain its complete required grammatical structure.
- Usage: prefer four natural, meaningful sentences/situations; ask which fits a specific target sense, register or communicative intention. You need NOT insert the target word into every option. Another valid sentence can be wrong for this stated situation; feedback must then say it does not fit THIS situation, never falsely call its English ungrammatical. An alternative format may use a single realistic learner error (a genuinely wrong preposition, argument pattern or countability) in an otherwise coherent sentence. Do not use unrelated objects, impossible actions, invented word classes or random semantic substitutions. "We wore a conundrum", "intractable soup", "reciprocated a table to fix" and "The bus repercussions at six" are prohibited low-quality distractors.
- Every wrong option must expose a plausible misunderstanding that the Japanese feedback explains precisely. A joke or merely absurd sentence is not a learning objective. If a natural sentence could fit the context, revise the question rather than declaring it wrong.
- Context alternatives must fit the EXACT unchanged blank including all neighboring prepositions/objects/inflections. If not, omit the alternative. No numbered-choice references in feedback.

Worked example A (original; situational usage, all choices meaningful):
Question: Which situation could naturally be described as a "conundrum"?
Correct: The library must choose between two essential services because its budget cannot support both.
Distractor: The library follows a clear timetable showing when each shift starts.
Distractor: The librarian checks the delivered books against a complete order list.
Distractor: The library closes at its usual time after the visitors leave.
Why: The first situation is a difficult problem with competing needs. The other sentences are grammatical ordinary activities, but no difficult problem is described. Do not claim their English is incorrect.

Worked example B (original; realistic pattern errors in the same meaningful situation):
Context: Mina chooses a study location according to how long the bus journey takes.
Question: Which sentence correctly uses "depend on" to express that relationship?
Correct: Her choice depends on the bus journey time.
Distractor: Her choice depends of the bus journey time.
Distractor: Her choice depends the bus journey time.
Distractor: Her choice depends for the bus journey time.
Why: This sense requires depend ON something. Each error is a specific missing/wrong preposition; the situation and all other words remain coherent. Do not copy these example items into a different card or repeat the same defect mechanically for every word.

Before returning, check each correct answer and each distractor independently. Exactly one displayed answer must satisfy the actual prompt. Return fully authored Japanese meanings and useful feedback, not generic "does not make sense" dismissal.`;
export const AUTHOR_TASK_V2 = AUTHOR_TASK.replace('The word mode correct text must exactly equal the canonical lemma/expression.', 'The word mode correct text must be the canonical lemma/expression or an explicitly reviewed alias.') + '\n\n' + QUESTION_QUALITY_V2;
export const REVIEW_SYSTEM_V2 = REVIEW_SYSTEM + '\n\n' + QUESTION_QUALITY_V2 + '\nIndependently enforce these requirements. If a usage distractor is nonsense or arbitrary, reject the full card with the exact offending choice and a concrete repair direction. Do not relax this merely because the intended answer is obvious.';
const repairOutputSchema = z.object({ units: z.array(z.object({ unitId: z.string().min(1), sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/), tests: unitSchema.shape.senses.element.shape.tests }).strict()).min(1).max(5) }).strict();
function params(model, system, prompt, schema, maxTokens) {
  return JSON.parse(JSON.stringify({ model, max_tokens: maxTokens, service_tier: 'standard_only', inference_geo: 'global', system,
    messages: [{ role: 'user', content: canonicalJson(prompt) }], output_config: { effort: 'medium', format: jsonSchemaOutputFormat(z.toJSONSchema(schema, { target: 'draft-7' })) } }));
}
function identity(id, createdAt, rows) {
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/.test(id ?? '') || !z.string().datetime().safeParse(createdAt).success || !rows.length || rows.length > 5 || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Versioned work requires a stable ID/date and one to five unique items.');
}
export function generationWorkV2(seeds, { model = 'claude-sonnet-5-5', createdAt, id } = {}) {
  const checked = seeds.map(validateSeed); identity(id, createdAt, checked);
  return { promptVersion: PROMPT_VERSION, id, stage: 'generation', unitIds: checked.map(seed => seed.id), seeds: checked, createdAt,
    params: params(model, AUTHOR_SYSTEM, { workflow: { promptVersion: PROMPT_VERSION, id, createdAt }, task: AUTHOR_TASK_V2, seeds: checked }, generationOutputSchema, 20000) };
}
export function reviewWorkV2(units, { model = 'claude-sonnet-5-5', createdAt, id } = {}) {
  const checked = units.map(validateUnit); identity(id, createdAt, checked);
  return { promptVersion: PROMPT_VERSION, id, stage: 'review', unitIds: checked.map(unit => unit.id), units: checked, createdAt,
    params: params(model, REVIEW_SYSTEM_V2, { workflow: { promptVersion: PROMPT_VERSION, id, createdAt }, task: 'Independently judge every complete card against the quality criteria and worked examples. Return exact content hashes; approve only with no material issue.',
      units: checked.map(unit => ({ unitId: unit.id, contentSha256: hashContent(unit), unit })) }, reviewOutputSchema, 8000) };
}
export function repairWorkV2(units, plan, rejection, { model = 'claude-sonnet-5-5', createdAt, id } = {}) {
  const checked = units.map(validateUnit); identity(id, createdAt, checked);
  if (id !== plan?.repairWorkId || checked.some(unit => unit.senses.length !== 1)) throw new Error('Repair must name its authorized request and one existing core sense per card.');
  return { promptVersion: PROMPT_VERSION, kind: 'tests-only-repair', id, stage: 'generation', unitIds: checked.map(unit => unit.id), units: checked, repairPlan: plan, rejection, createdAt,
    params: params(model, AUTHOR_SYSTEM, { workflow: { promptVersion: PROMPT_VERSION, kind: 'tests-only-repair', id, createdAt, repairPlanSha256: hashContent(plan) },
      task: `Repair ONLY the four test modes of each supplied original card. Return all four tests with the exact original unit ID and content hash. Do not return or change its seed, meanings, examples, sense ID, external links or provenance. The local system will preserve those fields byte-for-byte. Address the independent rejection and the quality requirements. ${QUESTION_QUALITY_V2}`,
      plan, rejection, units: checked.map(unit => ({ unitId: unit.id, sourceContentSha256: hashContent(unit), unit })) }, repairOutputSchema, 20000) };
}
export function parseGeneratedV2(response, work) {
  return parseGenerated(response, work).map(unit => validateUnit({ ...unit, provenance: { ...unit.provenance, author: AUTHOR_ID_V2 } }));
}
export function parseRepairedV2(response, work) {
  const parsed = repairOutputSchema.parse(jsonResult(response)), expected = new Map(work.units.map(unit => [unit.id, unit]));
  if (parsed.units.length !== expected.size || new Set(parsed.units.map(row => row.unitId)).size !== expected.size) throw new Error('Repair must address every exact original card once.');
  return parsed.units.map(row => {
    const original = expected.get(row.unitId);
    if (!original || original.senses.length !== 1 || row.sourceContentSha256 !== hashContent(original)) throw new Error('Repair source hash differs from the approved original draft.');
    return validateUnit({ ...original, senses: [{ ...original.senses[0], tests: row.tests }] });
  });
}
export function parseReviewedV2(response, work, reviewedAt = work.createdAt) {
  return parseReviewed(response, work, reviewedAt).map(({ unit, receipt }) => ({ unit, receipt: { ...receipt, reviewer: REVIEWER_ID_V2 } }));
}
