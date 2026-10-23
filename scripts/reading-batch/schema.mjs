import { createHash } from 'node:crypto';
import { z } from 'zod';

export const READING_DOMAINS = ['medical', 'travel', 'business', 'technology', 'politics', 'economics'];
export const ALL_READING_DOMAINS = ['daily-life', 'education', 'work', 'business', 'economics', 'finance', 'technology', 'science', 'medical', 'health', 'environment', 'travel', 'transport', 'politics', 'law', 'society', 'communication', 'arts-culture', 'sports', 'food', 'relationships', 'media', 'logic-reasoning'];
export const VOLUME2_DOMAINS = ALL_READING_DOMAINS.filter(domain => !READING_DOMAINS.includes(domain));
export const READING_SERIES = { 'reading-domains-pilot-v1': READING_DOMAINS, 'reading-domains-volume2-v1': VOLUME2_DOMAINS };
export const READING_LEVELS = { '2級': { cefr: 'B1', minWords: 250, maxWords: 350 }, '準1級': { cefr: 'B2', minWords: 450, maxWords: 600 } };
const text = max => z.string().trim().min(1).max(max);
const id = text(100).regex(/^[a-z0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.object({ paragraphId: id, quote: text(900) }).strict();
export const questionSchema = z.object({
  id, type: z.enum(['detail', 'inference', 'purpose', 'main-idea', 'vocabulary']),
  prompt: text(500), choices: z.array(text(500)).length(4), correctIndex: z.number().int().min(0).max(3),
  explanationJa: text(1000), evidence: z.array(evidenceSchema).min(1).max(4),
}).strict();
const draftReview = z.object({ status: z.literal('draft'), method: z.literal('independent-ai-review-required') }).strict();
const approvedReview = z.object({ status: z.literal('approved'), method: z.literal('independent-ai-review'), reviewer: text(160), reviewedAt: z.string().datetime(), contentSha256: digest }).strict();
export const readingSchema = z.object({
  id, seriesId: id, level: z.enum(['2級', '準1級']), cefrEstimate: z.enum(['B1', 'B2']),
  domainIds: z.array(z.enum(ALL_READING_DOMAINS)).min(1).max(3), title: text(200), levelNote: text(300), scenarioPolicy: text(300),
  paragraphs: z.array(z.object({ id, text: text(2500) }).strict()).min(3).max(10),
  questions: z.array(questionSchema).min(3).max(5),
  vocabulary: z.array(z.object({ term: text(80), meaningJa: text(180), linkPolicy: z.literal('resolve-lemma-in-shared-catalog') }).strict()).max(12),
  wordCount: z.number().int().positive().optional(), contentSha256: digest.optional(),
  review: z.discriminatedUnion('status', [draftReview, approvedReview]), audio: z.object({ status: z.literal('not-generated') }).strict(),
}).strict();

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const countEnglishWords = value => (value.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) ?? []).length;
export const passageWordCount = reading => reading.paragraphs.reduce((count, paragraph) => count + countEnglishWords(paragraph.text), 0);
export function hashReading(reading) {
  const { review, audio, wordCount, contentSha256, ...content } = reading;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const unique = (items, label) => assert(new Set(items).size === items.length, `${label}: duplicate value.`);

export function validateReading(raw) {
  const reading = readingSchema.parse(raw);
  const config = READING_LEVELS[reading.level], words = passageWordCount(reading);
  assert(words >= config.minWords && words <= config.maxWords, `${reading.id}: ${words} words; expected ${config.minWords}–${config.maxWords}.`);
  assert(reading.cefrEstimate === config.cefr, `${reading.id}: inconsistent approximate difficulty metadata.`);
  assert(reading.wordCount === undefined || reading.wordCount === words, `${reading.id}: stale word count.`);
  unique(reading.domainIds, `${reading.id} domains`);
  unique(reading.paragraphs.map(p => p.id), `${reading.id} paragraphs`);
  unique(reading.questions.map(q => q.id), `${reading.id} questions`);
  unique(reading.questions.map(q => normalized(q.prompt)), `${reading.id} prompts`);
  unique(reading.vocabulary.map(v => normalized(v.term)), `${reading.id} vocabulary`);
  for (const [index, paragraph] of reading.paragraphs.entries()) assert(paragraph.id === `p${index + 1}`, `${reading.id}: paragraph IDs must follow reading order.`);
  for (const [index, question] of reading.questions.entries()) {
    assert(question.id === `q${index + 1}`, `${reading.id}: question IDs must follow display order.`);
    unique(question.choices.map(normalized), `${reading.id}/${question.id} choices`);
    assert(!/(?:選択肢|正解は|答えは)\s*[1-4]|\b(?:option|choice)\s*[1-4]\b/i.test(question.explanationJa), `${reading.id}/${question.id}: explanation depends on choice position.`);
    for (const evidence of question.evidence) {
      const paragraph = reading.paragraphs.find(p => p.id === evidence.paragraphId);
      assert(paragraph, `${reading.id}/${question.id}: evidence paragraph does not exist.`);
      assert(paragraph.text.includes(evidence.quote), `${reading.id}/${question.id}: evidence quote is not an exact substring.`);
    }
  }
  const hash = hashReading(reading);
  assert(!reading.contentSha256 || reading.contentSha256 === hash, `${reading.id}: stale content hash.`);
  if (reading.review.status === 'approved') assert(reading.review.contentSha256 === hash, `${reading.id}: content changed after independent review.`);
  return { ...reading, wordCount: words, contentSha256: hash };
}

export function validateSeries(rawReadings, seriesId) {
  const domains = READING_SERIES[seriesId];
  assert(domains, 'Unknown reading series.');
  assert(Array.isArray(rawReadings) && rawReadings.length === domains.length * 2, `${seriesId} requires exactly ${domains.length * 2} passages.`);
  const readings = rawReadings.map(validateReading);
  unique(readings.map(r => r.id), 'Reading IDs');
  unique(readings.map(r => normalized(r.title)), 'Reading titles');
  for (const level of Object.keys(READING_LEVELS)) for (const domain of domains) {
    assert(readings.filter(r => r.level === level && r.domainIds.includes(domain)).length === 1, `${seriesId} needs exactly one ${level}/${domain} passage.`);
  }
  assert(readings.every(r => r.seriesId === seriesId && r.domainIds.every(domain => domains.includes(domain))), 'Inconsistent reading series.');
  return readings;
}
export const validatePilot = rawReadings => validateSeries(rawReadings, 'reading-domains-pilot-v1');

export const reviewReceiptSchema = z.object({
  reviewer: text(160), reviewedAt: z.string().datetime(),
  passages: z.array(z.object({ id, contentSha256: digest, approved: z.boolean(), issues: z.array(text(1500)).max(20) }).strict()).min(1).max(100),
}).strict();
export function applyIndependentReview(rawReadings, rawReceipt) {
  return applySeriesReview(rawReadings, rawReceipt, 'reading-domains-pilot-v1');
}
export function applySeriesReview(rawReadings, rawReceipt, seriesId) {
  return applyReviewReceipts(rawReadings, [rawReceipt], seriesId);
}
export function applyReviewReceipts(rawReadings, rawReceipts, seriesId) {
  const readings = validateSeries(rawReadings, seriesId);
  assert(Array.isArray(rawReceipts) && rawReceipts.length > 0, 'Independent review receipts are required.');
  const verdicts = rawReceipts.map(receipt => reviewReceiptSchema.parse(receipt)).flatMap(receipt => receipt.passages.map(passage => ({ ...passage, reviewer: receipt.reviewer, reviewedAt: receipt.reviewedAt })));
  assert(verdicts.length === readings.length, 'Review must cover exactly the series passages.');
  unique(verdicts.map(r => r.id), 'Reviewed reading IDs');
  return readings.map(reading => {
    const verdict = verdicts.find(p => p.id === reading.id);
    assert(verdict && verdict.contentSha256 === reading.contentSha256, `${reading.id}: missing or outdated review receipt.`);
    assert(verdict.approved && verdict.issues.length === 0, `${reading.id}: unresolved review issues.`);
    return validateReading({ ...reading, review: { status: 'approved', method: 'independent-ai-review', reviewer: verdict.reviewer, reviewedAt: verdict.reviewedAt, contentSha256: reading.contentSha256 } });
  });
}
