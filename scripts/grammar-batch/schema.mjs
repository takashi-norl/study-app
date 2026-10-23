import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const SERIES = {
  grammar: { titleJa: '文法で読み解く・書く', file: 'grammar-lessons.mjs' },
  prepositions: { titleJa: '前置詞の使い分け', file: 'preposition-lessons.mjs' },
  verbs: { titleJa: '基本動詞・句動詞の使い分け', file: 'verb-lessons.mjs' },
};
const domains = JSON.parse(readFileSync(new URL('../../content/vocabulary-knowledge/taxonomy.json', import.meta.url))).domains.map(item => item.id);
const text = max => z.string().trim().min(1).max(max);
const id = text(120).regex(/^[a-z0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const lessonSchema = z.object({
  id, series: z.enum(['grammar', 'prepositions', 'verbs']), titleJa: text(180),
  levelTargets: z.array(z.enum(['A2', 'B1', 'B2', 'C1'])).min(1).max(4),
  goalJa: text(800), conceptJa: text(2200), commonTrapJa: text(1200), usageNotes: z.array(text(1200)).min(1).max(10),
  examples: z.array(z.object({ id, text: text(1000), meaningJa: text(1000), contextJa: text(500) }).strict()).length(4),
  contrasts: z.array(z.object({ leftEnglish: text(1000), rightEnglish: text(1000), noteJa: text(1800) }).strict()).length(2),
  questions: z.array(z.object({
    id, type: z.enum(['context', 'usage', 'intent', 'meaning']), scenarioJa: text(1000), prompt: text(1200),
    choices: z.array(z.object({ text: text(1000), feedbackJa: text(1500) }).strict()).length(4),
    correctIndex: z.number().int().min(0).max(3), explanationJa: text(1800), focusJa: text(500),
  }).strict()).length(6),
  domainIds: z.array(z.enum(domains)).min(1).max(6),
  sourceReferences: z.array(z.object({ title: text(300), url: z.string().url().refine(url => new URL(url).protocol === 'https:', 'Source must use HTTPS.') }).strict()).min(1).max(12),
}).strict();

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashLesson = lesson => createHash('sha256').update(canonicalJson(lessonSchema.parse(lesson))).digest('hex');
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unique = (items, label) => assert(new Set(items).size === items.length, `${label}: duplicate value.`);
export function validateLesson(raw) {
  const lesson = lessonSchema.parse(raw);
  assert(lesson.id.startsWith(`${lesson.series}-`), `${lesson.id}: ID must identify its series.`);
  unique(lesson.domainIds, `${lesson.id} domains`);
  unique(lesson.levelTargets, `${lesson.id} levels`);
  unique([...lesson.examples, ...lesson.questions].map(item => item.id), `${lesson.id} item IDs`);
  unique(lesson.examples.map(item => normalized(item.text)), `${lesson.id} example text`);
  unique(lesson.questions.map(item => normalized(`${item.scenarioJa} ${item.prompt}`)), `${lesson.id} questions`);
  for (const question of lesson.questions) {
    unique(question.choices.map(choice => normalized(choice.text)), `${question.id} choices`);
    const feedback = [question.explanationJa, ...question.choices.map(choice => choice.feedbackJa)];
    assert(feedback.every(value => !/(?:選択肢|正解は|答えは)\s*[1-4]|\b(?:option|choice)\s*[1-4]\b/i.test(value)), `${question.id}: feedback must not depend on option positions.`);
  }
  return lesson;
}
export function validateCourse(raw) {
  assert(Array.isArray(raw) && raw.length === 36, 'The initial course requires 36 lessons.');
  const lessons = raw.map(validateLesson);
  unique(lessons.map(item => item.id), 'Lesson IDs');
  unique(lessons.flatMap(item => [...item.examples, ...item.questions].map(part => part.id)), 'Course item IDs');
  for (const series of Object.keys(SERIES)) assert(lessons.filter(item => item.series === series).length === 12, `${series}: exactly 12 lessons required.`);
  return lessons;
}
export const reviewReceiptSchema = z.object({
  reviewer: text(160), reviewedAt: z.string().datetime(),
  lessons: z.array(z.object({ id, contentSha256: digest, approved: z.boolean(), issues: z.array(text(3000)).max(20) }).strict()).min(1).max(36),
}).strict();
const approvedLessonSchema = lessonSchema.extend({
  contentSha256: digest,
  review: z.object({ status: z.literal('approved'), method: z.literal('independent-ai-review'), reviewer: text(160), reviewedAt: z.string().datetime(), contentSha256: digest }).strict(),
  audio: z.object({ status: z.literal('not-generated') }).strict(),
}).strict();
export function validateApprovedLessons(raw) {
  const approved = z.array(approvedLessonSchema).parse(raw);
  const lessons = validateCourse(approved.map(({ contentSha256, review, audio, ...lesson }) => lesson));
  for (let index = 0; index < lessons.length; index++) {
    const evidence = approved[index], hash = hashLesson(lessons[index]);
    assert(evidence.contentSha256 === hash && evidence.review.contentSha256 === hash, `${evidence.id}: missing or stale independent review hashes.`);
  }
  return approved;
}
export function applyReviews(rawLessons, rawReceipts) {
  const lessons = validateCourse(rawLessons);
  assert(Array.isArray(rawReceipts) && rawReceipts.length > 0, 'Independent reviews required.');
  const verdicts = rawReceipts.map(receipt => reviewReceiptSchema.parse(receipt)).flatMap(receipt => receipt.lessons.map(verdict => ({ ...verdict, reviewer: receipt.reviewer, reviewedAt: receipt.reviewedAt })));
  assert(verdicts.length === lessons.length, 'Review must cover every lesson exactly once.');
  unique(verdicts.map(item => item.id), 'Review lesson IDs');
  return lessons.map(lesson => {
    const verdict = verdicts.find(item => item.id === lesson.id), contentSha256 = hashLesson(lesson);
    assert(verdict && verdict.contentSha256 === contentSha256, `${lesson.id}: missing or stale review.`);
    assert(verdict.approved && verdict.issues.length === 0, `${lesson.id}: unresolved review issues.`);
    return { ...lesson, contentSha256, review: { status: 'approved', method: 'independent-ai-review', reviewer: verdict.reviewer, reviewedAt: verdict.reviewedAt, contentSha256 }, audio: { status: 'not-generated' } };
  });
}
