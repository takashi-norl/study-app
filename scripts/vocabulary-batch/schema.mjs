import { createHash } from 'node:crypto';
import { z } from 'zod';
import { candidateContextForms, meaningPromptIdentifiesLemma } from './structural-forms.mjs';

export const GRADES = { grade3: { label: '3級', target: 2100 }, pre2: { label: '準2級', target: 1500 }, grade2: { label: '2級', target: 1500 }, pre1: { label: '準1級', target: 2400 } };
export const MODES = ['meaning', 'word', 'context', 'usage'];
export const normalizeLemma = value => value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashVocabularyEntry = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const text = (max = 400) => z.string().trim().min(1).max(max);
export const lemmaSchema = z.object({ word: text(60).regex(/^[a-z]+(?:[-'][a-z]+)*$/), partOfSpeech: z.enum(['名詞', '動詞', '形容詞', '副詞', '代名詞', '前置詞', '接続詞', '冠詞', '助動詞', '間投詞']), meaning: text(120), cefr: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']), domains: z.array(text(40)).min(1).max(4) }).strict();
export const inventorySchema = z.object({ words: z.array(lemmaSchema).min(1).max(100) }).strict();
export function validInventoryCandidates(raw, needed, excluded = new Set()) {
  if (!raw || !Array.isArray(raw.words) || !Number.isInteger(needed) || needed < 1 || needed > 100) throw new Error('Unusable inventory response.');
  const known = new Set(excluded), accepted = [];
  for (const candidate of raw.words.slice(0, 200)) {
    const parsed = lemmaSchema.safeParse(candidate);
    if (!parsed.success || known.has(normalizeLemma(parsed.data.word))) continue;
    known.add(normalizeLemma(parsed.data.word)); accepted.push(parsed.data);
    if (accepted.length === needed) break;
  }
  return accepted;
}
const forms = z.object({ base: z.array(text(60)).min(1).max(2), past: z.array(text(60)).min(1).max(3), pastParticiple: z.array(text(60)).min(1).max(3), presentParticiple: z.array(text(60)).min(1).max(2), thirdPersonSingular: z.array(text(60)).min(1).max(2) }).strict();
const choice = z.object({ text: text(220), meaning: text(160) }).strict();
const alternative = z.object({ answer: text(80), explanation: text(240) }).strict();
const authoredTest = z.object({ mode: z.enum(MODES), prompt: text(500), choices: z.array(choice).length(4), correctIndex: z.number().int().min(0).max(3), explanation: text(500), alternatives: z.array(alternative).max(3) }).strict();
export const generatedEntrySchema = z.object({
  word: text(60), ipa: text(120), ipaLabel: z.enum(['米音', '英音']), partOfSpeech: lemmaSchema.shape.partOfSpeech,
  definition: text(240), meaning: text(120), usageTip: text(320),
  examples: z.array(z.object({ context: text(80), text: text(240), translation: text(240) }).strict()).length(3),
  verbForms: forms.nullable(), cefr: lemmaSchema.shape.cefr, domains: lemmaSchema.shape.domains,
  tests: z.array(authoredTest).length(4),
}).strict();
export const generationSchema = z.object({ entries: z.array(generatedEntrySchema).min(1).max(10) }).strict();
export const reviewSchema = z.object({ verdicts: z.array(z.object({ word: text(60), approved: z.boolean(), issues: z.array(text(500)).max(12) }).strict()).min(1).max(10) }).strict();

export function validateGeneratedBatch(raw, inventory) {
  const parsed = generationSchema.parse(raw);
  const expected = new Map(inventory.map(item => [normalizeLemma(item.word), item]));
  if (expected.size !== inventory.length || parsed.entries.length !== inventory.length) throw new Error('Generated entry count does not match the exact requested inventory.');
  const seen = new Set();
  for (const entry of parsed.entries) {
    const key = normalizeLemma(entry.word), seed = expected.get(key);
    if (!seed || seen.has(key) || entry.word !== key) throw new Error(`Unexpected or duplicate lemma: ${entry.word}`);
    seen.add(key);
    if (entry.partOfSpeech !== seed.partOfSpeech) throw new Error(`${key}: part of speech differs from inventory.`);
    if (seed.preferredIpaLabel && entry.ipaLabel !== seed.preferredIpaLabel) throw new Error(`${key}: IPA region differs from the assigned voice.`);
    if ((entry.partOfSpeech === '動詞') !== !!entry.verbForms) throw new Error(`${key}: verb conjugation table is required only for verbs.`);
    if (entry.verbForms && !entry.verbForms.base.includes(entry.word)) throw new Error(`${key}: missing base verb form.`);
    if (new Set(entry.examples.map(item => normalizeLemma(item.text))).size !== 3) throw new Error(`${key}: examples must be distinct.`);
    if (new Set(entry.tests.map(item => item.mode)).size !== 4) throw new Error(`${key}: all four test modes are required.`);
    for (const test of entry.tests) {
      if (new Set(test.choices.map(item => normalizeLemma(item.text))).size !== 4) throw new Error(`${key}: duplicate choices in ${test.mode}.`);
      if (test.mode === 'meaning' && !meaningPromptIdentifiesLemma(test.prompt, entry)) throw new Error(`${key}: meaning prompt must identify the target lemma, an explicit sense, or an evidenced construction.`);
      if (test.mode === 'word' && normalizeLemma(test.choices[test.correctIndex].text) !== key) throw new Error(`${key}: word test must select the target lemma.`);
      // Meaning glosses may select one stated sense or use a natural paraphrase. Correctness
      // is semantic: the mandatory independent reviewer checks all four choices, not equality.
      if (test.mode === 'context' && !/_{3,}/.test(test.prompt)) throw new Error(`${key}: context test needs an empty cloze.`);
      if (test.mode === 'context' && !candidateContextForms(entry).has(normalizeLemma(test.choices[test.correctIndex].text))) throw new Error(`${key}: context answer must be the target lemma or a candidate inflected form; semantic correctness still requires review.`);
      if (/(?:選択肢|正解は|答えは)\s*[1-4]|\b(?:option|choice)\s*[1-4]\b/i.test(test.explanation)) throw new Error(`${key}: explanations must not depend on shuffled choice numbers.`);
      if (test.mode !== 'context' && test.alternatives.length) throw new Error(`${key}: alternatives belong to context test only.`);
      const wrong = new Set(test.choices.filter((_, index) => index !== test.correctIndex).map(item => normalizeLemma(item.text)));
      if (test.alternatives.some(item => wrong.has(normalizeLemma(item.answer)))) throw new Error(`${key}: accepted synonym is a wrong choice.`);
    }
  }
  return parsed.entries;
}

export function materializeEntry(entry, seed, index = 0) {
  const expectedIpaLabel = index % 2 ? '英音' : '米音';
  if (entry.ipaLabel !== expectedIpaLabel) throw new Error(`${entry.word}: regional IPA must match the assigned voice (${expectedIpaLabel}).`);
  const context = entry.tests.find(item => item.mode === 'context');
  const usage = entry.tests.find(item => item.mode === 'usage');
  return {
    id: seed.id, word: entry.word, level: GRADES[seed.grade].label, ipa: entry.ipa, ipaLabel: entry.ipaLabel,
    partOfSpeech: entry.partOfSpeech, ...(entry.verbForms ? { verbForms: entry.verbForms } : {}),
    definition: entry.definition, meaning: entry.meaning, usageTip: entry.usageTip, voice: index % 2 ? 'male' : 'female',
    examples: entry.examples.map((example, position) => ({ id: `example-${position + 1}`, ...example })),
    tests: entry.tests,
    recall: { prompt: context.prompt, answers: [context.choices[context.correctIndex].text], explanation: context.explanation, alternatives: context.alternatives },
    production: { prompt: `${entry.word}を使って、自分の生活に関する英文を1文作ってみましょう。`, modelAnswer: entry.examples[0].text, checkpoints: ['意味が場面に合っている', '品詞と文の形が合っている', '自分の伝えたいことを表している'] },
    questions: [{ id: `${seed.id}-usage`, type: 'usage', prompt: usage.prompt, choices: usage.choices.map(item => item.text), correctIndex: usage.correctIndex, explanation: usage.explanation }],
    metadata: { schemaVersion: 2, cefrEstimate: entry.cefr, domains: entry.domains, gradeEstimate: GRADES[seed.grade].label, levelPolicy: 'AI-estimated learning bands, not an official examination list or a score guarantee.' },
  };
}

export function validateReview(raw, entries) {
  const parsed = reviewSchema.parse(raw);
  const expected = new Set(entries.map(entry => entry.word));
  if (parsed.verdicts.length !== entries.length || new Set(parsed.verdicts.map(item => item.word)).size !== entries.length || parsed.verdicts.some(item => !expected.has(item.word))) throw new Error('Review must address each requested lemma exactly once.');
  if (parsed.verdicts.some(item => item.approved !== (item.issues.length === 0))) throw new Error('Review verdict and issues disagree.');
  return parsed.verdicts;
}

export const jsonSchema = schema => z.toJSONSchema(schema, { target: 'draft-7' });
