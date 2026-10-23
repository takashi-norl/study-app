#!/usr/bin/env node
import { assertCatalogFamilies, assertFamilyContent } from './canonical-policy.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GRADES, hashVocabularyEntry, lemmaSchema, normalizeLemma } from './schema.mjs';
import { candidateContextForms } from './structural-forms.mjs';
import { baseCount } from './holds.mjs';
import { atomicJson, readJson, withLock } from './storage.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = z.string().trim().min(1).max(500);
const formList = z.array(z.string().trim().min(1).max(60)).max(10);
const curatedLemma = lemmaSchema.extend({
  aliases: formList.optional(),
  verbForms: z.object({ base: formList, past: formList, pastParticiple: formList, presentParticiple: formList, thirdPersonSingular: formList }).strict().optional(),
}).strict();
export const curatedSourceSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/), grade: z.enum(Object.keys(GRADES)), createdBy: text, words: z.array(curatedLemma).min(1).max(500) }).strict();
export const curatedReviewSchema = z.object({ schemaVersion: z.literal(1).optional(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewedBy: text, reviewedAt: z.string().datetime().optional(), verdicts: z.array(z.object({ word: text, approved: z.boolean(), issues: z.array(text).max(20) }).strict()).min(1).max(500) }).strict();

/** Candidate forms flag collisions for review, not semantic equivalence or a new count. */
export function inventoryForms(entry) {
  const forms = candidateContextForms(entry), word = normalizeLemma(entry.word);
  for (const alias of entry.aliases ?? []) forms.add(normalizeLemma(alias));
  if (entry.partOfSpeech === '動詞') {
    // Existing authored irregular tables take priority; conservative regular variants
    // also protect inventoried verbs whose complete learning card is not built yet.
    if (/[^aeiou]y$/.test(word)) { forms.add(`${word.slice(0, -1)}ies`); forms.add(`${word.slice(0, -1)}ied`); }
    else { forms.add(`${word}s`); forms.add(`${word}${word.endsWith('e') ? 'd' : 'ed'}`); }
    if (/(?:s|x|z|ch|sh|o)$/.test(word)) forms.add(`${word}es`);
    forms.add(`${word.endsWith('e') && !word.endsWith('ee') ? word.slice(0, -1) : word}ing`);
    if (/ie$/.test(word)) forms.add(`${word.slice(0, -2)}ying`);
    if (/^[a-z]*[^aeiou][aeiou][^aeiouwxy]$/.test(word)) { forms.add(`${word}${word.at(-1)}ed`); forms.add(`${word}${word.at(-1)}ing`); }
  }
  return forms;
}

function verifySourceAndReview(rawSource, rawReview, domainIds) {
  const source = curatedSourceSchema.parse(rawSource), review = curatedReviewSchema.parse(rawReview);
  const sourceSha256 = hashVocabularyEntry(rawSource), reviewSha256 = hashVocabularyEntry(rawReview);
  if (review.sourceSha256 !== sourceSha256) throw new Error('Review does not bind the exact source content.');
  if (normalizeLemma(source.createdBy) === normalizeLemma(review.reviewedBy)) throw new Error('An independent reviewer is required.');
  const words = new Map(source.words.map(word => [normalizeLemma(word.word), word]));
  if (words.size !== source.words.length) throw new Error('Source contains duplicate normalized lemmas.');
  if (review.verdicts.length !== words.size || new Set(review.verdicts.map(v => normalizeLemma(v.word))).size !== words.size || review.verdicts.some(v => !words.has(normalizeLemma(v.word)))) throw new Error('Review must address every source word exactly once, with no extras.');
  if (review.verdicts.some(v => v.approved !== (v.issues.length === 0))) throw new Error('Approval and review issues disagree.');
  const domains = new Set(domainIds);
  if (!domains.size) throw new Error('Canonical domain IDs are required.');
  for (const word of source.words) {
    if (word.domains.some(domain => !domains.has(domain)) || new Set(word.domains).size !== word.domains.length) throw new Error(`Unsupported or duplicate domain: ${word.word}`);
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word.meaning)) throw new Error(`A Japanese meaning is required: ${word.word}`);
    if (word.verbForms && (word.partOfSpeech !== '動詞' || !word.verbForms.base.map(normalizeLemma).includes(word.word))) throw new Error(`Verb form metadata does not match its lemma: ${word.word}`);
  }
  const approved = new Set(review.verdicts.filter(v => v.approved).map(v => normalizeLemma(v.word)));
  return { source, review, sourceSha256, reviewSha256, accepted: source.words.filter(word => approved.has(word.word)) };
}

export function planCuratedInventory({ state, source: rawSource, review: rawReview, knownEntries = [], domainIds }) {
  const verified = verifySourceAndReview(rawSource, rawReview, domainIds);
  const { source, sourceSha256, reviewSha256, accepted } = verified;
  if (state.schemaVersion !== 1 || !Array.isArray(state.words) || new Set(state.words.map(w => w.id)).size !== state.words.length || new Set(state.words.map(w => normalizeLemma(w.word))).size !== state.words.length) throw new Error('Manifest contains invalid or duplicate identities.');
  if (state.gradeTargets?.[source.grade]?.target !== GRADES[source.grade].target) throw new Error('Configured grade target differs from the pipeline target.');
  const provenance = { kind: 'curated-offline', sourceId: source.id, sourceSha256, reviewSha256, createdBy: source.createdBy, reviewedBy: verified.review.reviewedBy };
  const seeds = accepted.map(word => ({ ...word, id: `vocab-${normalizeLemma(word.word)}`, grade: source.grade, frozen: false, status: 'inventoried', inventoryProvenance: provenance }));
  const previous = state.curatedInventoryReceipts?.[source.id];
  if (previous) {
    if (previous.sourceSha256 !== sourceSha256 || previous.reviewSha256 !== reviewSha256 || hashVocabularyEntry(previous.addedIds) !== hashVocabularyEntry(seeds.map(w => w.id))) throw new Error('Curated source identity already has different source or review evidence.');
    for (const seed of seeds) {
      const saved = state.words.find(w => w.id === seed.id);
      // Progress fields may advance after import. Original reviewed seed fields cannot.
      if (!saved || Object.keys(seed).filter(key => key !== 'status').some(key => hashVocabularyEntry(seed[key]) !== hashVocabularyEntry(saved[key]))) throw new Error('Previously imported seed differs from its reviewed provenance.');
    }
    return { ...verified, seeds, replayed: true, previous };
  }
  const currentCount = baseCount(state.words, source.grade);
  if (currentCount + seeds.length > GRADES[source.grade].target) throw new Error('Curated source would exceed the grade target.');
  const forms = new Map(), ids = new Set(state.words.map(w => w.id));
  for (const entry of [...state.words, ...knownEntries]) for (const form of inventoryForms(entry)) {
    const owners = forms.get(form) ?? new Set(); owners.add(entry.word); forms.set(form, owners);
  }
  for (const seed of seeds) {
    if (ids.has(seed.id)) throw new Error(`Duplicate inventory identity: ${seed.word}`);
    const candidateForms = inventoryForms(seed), conflicts = [...candidateForms].filter(form => forms.has(form));
    if (conflicts.length) throw new Error(`Lemma, alias or inflection overlap requires explicit review: ${seed.word} (${conflicts.slice(0, 5).join(', ')})`);
    ids.add(seed.id); for (const form of candidateForms) forms.set(form, new Set([seed.word]));
  }
  return { ...verified, seeds, replayed: false, currentCount, target: GRADES[source.grade].target };
}

async function loadKnownEntries(output, state) {
  assertCatalogFamilies(state.words);
  const seeds = new Map(state.words.map(seed => [seed.id, seed]));
  const frozen = await readJson(join(output, 'frozen-100.json'));
  if (hashVocabularyEntry(frozen) !== state.frozenSha256) throw new Error('Frozen snapshot integrity failed.');
  const entries = [];
  for (const row of frozen) {
    if (!row.entry || hashVocabularyEntry(row.entry) !== row.contentSha256) throw new Error('Frozen entry hash differs.');
    if (seeds.get(row.entry.id)?.catalogFamily) assertFamilyContent(seeds.get(row.entry.id), row);
    entries.push(row.entry);
  }
  const directory = join(output, 'approved');
  for (const grade of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory())) {
    for (const file of (await readdir(join(directory, grade.name))).filter(name => name.endsWith('.json'))) {
      const batch = await readJson(join(directory, grade.name, file));
      if (batch.schemaVersion !== 1 || !Array.isArray(batch.entries)) throw new Error('Invalid approved batch.');
      for (const row of batch.entries) {
        if (row.review?.status !== 'approved' || hashVocabularyEntry(row.entry) !== row.review.contentSha256) throw new Error('Approved entry is not bound to its review.');
        if (seeds.get(row.entry.id)?.catalogFamily) assertFamilyContent(seeds.get(row.entry.id), row);
        entries.push(row.entry);
      }
    }
  }
  return entries;
}

async function preserveEvidence(file, expected, writing) {
  const prior = await readJson(file, null);
  if (prior) { if (hashVocabularyEntry(prior) !== hashVocabularyEntry(expected)) throw new Error('Saved curated evidence differs; never overwrite it.'); return; }
  if (!writing) return;
  await atomicJson(file, expected);
}

export async function importCuratedInventory({ output, sourcePath, reviewPath, write = false }) {
  if (![output, sourcePath, reviewPath].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Use absolute output, source and review paths.');
  if (typeof write !== 'boolean') throw new Error('Write mode must be an explicit boolean.');
  // The same lock used by build.mjs serializes the entire read/plan/append sequence.
  return withLock(output, async () => {
    const [state, source, review, taxonomy] = await Promise.all([readJson(join(output, 'manifest.json')), readJson(sourcePath), readJson(reviewPath), readJson(join(repo, 'content/vocabulary-knowledge/taxonomy.json'))]);
    const knownEntries = await loadKnownEntries(output, state);
    const plan = planCuratedInventory({ state, source, review, knownEntries, domainIds: taxonomy.domains.map(d => d.id) });
    const evidenceDirectory = join(output, 'curated-inventory', plan.source.id);
    const receiptPath = join(evidenceDirectory, 'receipt.json'), existingReceipt = await readJson(receiptPath, null);
    const receipt = existingReceipt ?? { schemaVersion: 1, kind: 'curated-offline-import', sourceId: plan.source.id, sourceSha256: plan.sourceSha256, reviewSha256: plan.reviewSha256, grade: plan.source.grade, addedIds: plan.seeds.map(w => w.id), seedHashes: plan.seeds.map(w => hashVocabularyEntry(w)), manifestBeforeSha256: hashVocabularyEntry(state), importedAt: new Date().toISOString(), paidCalls: 0 };
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'curated-offline-import' || receipt.paidCalls !== 0 || receipt.sourceId !== plan.source.id || receipt.sourceSha256 !== plan.sourceSha256 || receipt.reviewSha256 !== plan.reviewSha256 || receipt.grade !== plan.source.grade || hashVocabularyEntry(receipt.addedIds) !== hashVocabularyEntry(plan.seeds.map(w => w.id)) || hashVocabularyEntry(receipt.seedHashes) !== hashVocabularyEntry(plan.seeds.map(w => hashVocabularyEntry(w)))) throw new Error('Curated import receipt does not match current evidence.');
    if (plan.replayed && (!existingReceipt || hashVocabularyEntry(plan.previous) !== hashVocabularyEntry(receipt))) throw new Error('Previously imported evidence or receipt is missing.');
    if (!plan.replayed && existingReceipt && receipt.manifestBeforeSha256 !== hashVocabularyEntry(state)) throw new Error('Interrupted import baseline changed; operator reconciliation required.');
    if (plan.replayed) {
      for (const [name, expected] of [['source.json', source], ['review.json', review]]) {
        const saved = await readJson(join(evidenceDirectory, name));
        if (hashVocabularyEntry(saved) !== hashVocabularyEntry(expected)) throw new Error('Previously imported source or review evidence differs.');
      }
    } else {
      await preserveEvidence(join(evidenceDirectory, 'source.json'), source, write);
      await preserveEvidence(join(evidenceDirectory, 'review.json'), review, write);
      await preserveEvidence(receiptPath, receipt, write);
      if (write) {
        const next = { ...state, words: [...state.words, ...plan.seeds], curatedInventoryReceipts: { ...(state.curatedInventoryReceipts ?? {}), [plan.source.id]: receipt }, updatedAt: new Date().toISOString() };
        // All immutable source/review/provenance evidence reaches disk before append.
        await atomicJson(join(output, 'manifest.json'), next);
      }
    }
    return { mode: write ? 'write' : 'dry-run', sourceId: plan.source.id, grade: plan.source.grade, sourceSha256: plan.sourceSha256, reviewSha256: plan.reviewSha256, sourceCount: plan.source.words.length, approvedCount: plan.seeds.length, rejectedCount: plan.source.words.length - plan.seeds.length, added: write && !plan.replayed ? plan.seeds.length : 0, replayed: plan.replayed, gradeCountAfter: baseCount(state.words, plan.source.grade) + (plan.replayed ? 0 : plan.seeds.length), target: GRADES[plan.source.grade].target, paidCalls: 0 };
  });
}

function cliArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--write') { if (options.write) throw new Error('Duplicate --write flag.'); options.write = true; }
    else if (['--out', '--source', '--review'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--') && !options[key]) options[key] = argv[++i];
    else throw new Error('Usage: node scripts/vocabulary-batch/curated-inventory.mjs --out ABS --source ABS --review ABS [--write]');
  }
  return { output: options['--out'], sourcePath: options['--source'], reviewPath: options['--review'], write: options.write ?? false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importCuratedInventory(cliArguments(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`Curated inventory stopped: ${error.message}`); process.exitCode = 1; });
}
