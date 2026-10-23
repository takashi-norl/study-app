import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MODES = ['meaning', 'word', 'context', 'usage'];
export const GENRES = ['general', 'academic', 'crime-suspense', 'romance', 'urban', 'science-fiction', 'comedy', 'action'];
export const COLLECTIONS = ['eiken-1', 'advanced-reading', 'screen-everyday', 'idioms-phrasal', 'genre-language', 'teen-contemporary'];
export const normalizeForm = value => value.normalize('NFKC').trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[‐‑–—]/g, '-').replace(/[.!?。！？]+$/u, '').trim().replace(/\s+/g, ' ');
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashContent = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const unitIdFor = (kind, lemma) => `en-${kind}-${hashContent(['en', kind, normalizeForm(lemma)]).slice(0, 24)}`;
export const senseIdFor = (unitId, senseKey) => `${unitId}:${senseKey}`;
const text = (max = 500) => z.string().trim().min(1).max(max);
const unique = values => new Set(values.map(normalizeForm)).size === values.length;
const level = z.object({ cefrEstimate: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']), eikenEstimates: z.array(z.enum(['grade3', 'pre2', 'grade2', 'pre1', 'grade1'])).max(5), policy: z.literal('estimated-not-official') }).strict();
export const seedSchema = z.object({
  id: text(80), kind: z.enum(['word', 'phrase']), lemma: text(120), aliases: z.array(text(120)).max(20),
  primaryCollection: z.enum(COLLECTIONS), level, genres: z.array(z.enum(GENRES)).min(1).max(GENRES.length),
  register: z.enum(['formal', 'neutral', 'informal', 'slang', 'vulgar']),
  audience: z.object({ suitableFor: z.enum(['general', 'teens-and-adults', 'adults']), noteJa: text(300) }).strict(),
  pitfalls: z.array(z.object({ kind: z.enum(['grammar', 'meaning', 'literal-reading', 'register', 'regional', 'dated', 'offensive']), noteJa: text(300) }).strict()).min(1).max(8),
}).strict();
const choiceSchema = z.object({ text: text(300), meaningJa: text(250), feedbackJa: text(500) }).strict();
const testSchema = z.object({
  mode: z.enum(MODES), prompt: text(700), choices: z.array(choiceSchema).length(4), correctIndex: z.number().int().min(0).max(3), explanationJa: text(700),
  alternatives: z.array(z.object({ text: text(120), meaningJa: text(250), noteJa: text(350) }).strict()).max(4),
}).strict();
const relationSchema = z.object({
  type: z.enum(['synonym', 'antonym', 'confusable', 'collocation', 'prerequisite']),
  targetUnitId: text(160), targetSenseId: text(240), contextJa: text(350),
  substitutable: z.boolean(), limitationJa: text(350),
}).strict();
const senseSchema = z.object({
  id: text(180), key: text(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), partOfSpeech: text(60), meaningEn: text(500), meaningJa: text(300),
  examples: z.array(z.object({ id: text(200), text: text(450), meaningJa: text(400), contextJa: text(200) }).strict()).length(3),
  tests: z.array(testSchema).length(4), relations: z.array(relationSchema).max(12),
}).strict();
export const unitSchema = seedSchema.extend({
  schemaVersion: z.literal(1), senses: z.array(senseSchema).min(1).max(6),
  provenance: z.object({ authorship: z.literal('original'), author: text(100), createdAt: z.string().datetime(), usageReferences: z.array(z.object({ title: text(200), url: z.string().url().startsWith('https://') }).strict()).max(12) }).strict(),
}).strict();
export function validateSeed(raw) {
  const seed = seedSchema.parse(raw);
  if (seed.lemma !== normalizeForm(seed.lemma) || !/^[a-z]+(?:[-' ][a-z]+)*$/.test(seed.lemma)) throw new Error('Canonical English lemma/expression required.');
  if ((seed.kind === 'phrase') !== seed.lemma.includes(' ')) throw new Error('Words and multiword phrases must use the correct item type.');
  if (seed.id !== unitIdFor(seed.kind, seed.lemma)) throw new Error('Unit ID differs from its stable canonical identity.');
  if (!unique([seed.lemma, ...seed.aliases]) || !unique(seed.genres) || !unique(seed.level.eikenEstimates)) throw new Error('Duplicate aliases, genre or level tags.');
  return seed;
}
export function validateUnit(raw) {
  const unit = unitSchema.parse(raw);
  validateSeed(seedSchema.parse(Object.fromEntries(Object.keys(seedSchema.shape).map(key => [key, unit[key]]))));
  if (!unique(unit.senses.map(sense => sense.key))) throw new Error('Sense keys must be unique within one lexical unit.');
  for (const sense of unit.senses) {
    if (sense.id !== senseIdFor(unit.id, sense.key)) throw new Error('Sense ID must be scoped to its unit and stable key.');
    if (!unique(sense.examples.map(example => example.text))) throw new Error('Three distinct original examples required.');
    sense.examples.forEach((example, index) => { if (example.id !== `${sense.id}:example-${index + 1}`) throw new Error('Example identity must be sense scoped.'); });
    if (new Set(sense.tests.map(item => item.mode)).size !== 4) throw new Error('Each sense requires all four authored multiple-choice modes, including phrases.');
    for (const question of sense.tests) {
      if (!unique(question.choices.map(choice => choice.text))) throw new Error('Four distinct answer choices required.');
      if (question.mode === 'word' && normalizeForm(question.choices[question.correctIndex].text) !== unit.lemma) throw new Error('Word/phrase selection must choose the canonical target.');
      if (question.mode === 'context' && !/_{3,}/.test(question.prompt)) throw new Error('Context question must include a cloze.');
      if (question.mode !== 'context' && question.alternatives.length) throw new Error('Contextual synonyms belong only to a context question.');
      const wrong = new Set(question.choices.filter((_, index) => index !== question.correctIndex).map(choice => normalizeForm(choice.text)));
      if (question.alternatives.some(alt => wrong.has(normalizeForm(alt.text)))) throw new Error('A defensible alternative cannot be marked as a wrong answer.');
      for (const explanation of [question.explanationJa, ...question.choices.map(choice => choice.feedbackJa)]) {
        if (/(?:選択肢|正解は|答えは)\s*[1-4]|\b(?:option|choice)\s*[1-4]\b/i.test(explanation)) throw new Error('Feedback must not depend on shuffled choice numbers.');
      }
    }
    for (const relation of sense.relations) {
      if (!relation.targetSenseId.startsWith(`${relation.targetUnitId}:`)) throw new Error('Relations require a target sense within the declared target unit.');
      if (relation.type !== 'synonym' && relation.substitutable) throw new Error('Only context-reviewed synonyms can be substitutable.');
    }
  }
  return unit;
}
export function validateRelations(units, knownSenseIds) {
  const known = new Set([...knownSenseIds, ...units.flatMap(unit => unit.senses.map(sense => sense.id))]);
  for (const unit of units) for (const sense of unit.senses) for (const relation of sense.relations) {
    if (!known.has(relation.targetSenseId)) throw new Error(`Unresolved sense relation: ${relation.targetSenseId}`);
  }
  return true;
}
export function approveUnit(raw, receipt) {
  const unit = validateUnit(raw);
  const review = z.object({ reviewer: text(100), reviewedAt: z.string().datetime(), unitId: text(80), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), approved: z.literal(true), issues: z.array(text()).length(0) }).strict().parse(receipt);
  if (review.reviewer === unit.provenance.author || review.unitId !== unit.id || review.contentSha256 !== hashContent(unit)) throw new Error('Independent approval must bind the complete current unit.');
  return { unit, review };
}
