import type { VocabularyEntry } from './vocabulary-types';

export type VocabularyTestMode = 'meaning' | 'word' | 'context' | 'usage' | 'recall';
export const VOCABULARY_TEST_MODES: ReadonlyArray<{ id: VocabularyTestMode; label: string; description: string }> = [
  { id: 'meaning', label: '意味を選ぶ', description: '英単語を見て、日本語の意味を4択で選びます。' },
  { id: 'word', label: '英単語を選ぶ', description: '日本語の意味を見て、英単語を4択で選びます。' },
  { id: 'context', label: '文に合う語を選ぶ', description: '場面と英文を読んで、空欄に合う語を4択で選びます。' },
  { id: 'usage', label: '使い方を確かめる', description: '例文の使い方や意味を4択で確かめます。' },
];

export type VocabularyTestItem = {
  id: string; wordId: string; kind: 'choice' | 'recall'; prompt: string;
  choices?: string[]; correctIndex?: number; answers?: string[]; explanation: string;
  choiceMeanings?: string[];
  alternatives?: { answer: string; explanation: string }[];
  mode?: VocabularyTestMode;
};

export function vocabularyGroups(entries: VocabularyEntry[], level: VocabularyEntry['level'], size = 10): VocabularyEntry[][] {
  const selected = entries.filter(entry => entry.level === level);
  const width = Math.max(1, Math.min(20, Math.floor(size) || 10));
  return Array.from({ length: Math.ceil(selected.length / width) }, (_, index) => selected.slice(index * width, (index + 1) * width));
}

function shuffle<T>(items: T[], seed: number): T[] {
  const output = [...items]; let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

// Reviewed against the catalog's Japanese scene AND English cloze. Same-POS words alone
// are unsafe: e.g. retain/preserve and feasible/viable can both fit the same sentence.
// These are entry IDs, not invented answers. Every rendered choice must exist in the pool.
const contextDistractors: Record<string, readonly string[]> = {
  avoid: ['admit', 'provide', 'convince'], afford: ['admit', 'develop', 'contribute'],
  contribute: ['contain', 'convince', 'obtain'], achieve: ['contain', 'provide', 'admit'],
  admit: ['provide', 'attract', 'contain'], affect: ['participate', 'convince', 'obtain'],
  appreciate: ['prevent', 'contain', 'attract'], arrange: ['contain', 'admit', 'reduce'],
  assume: ['provide', 'participate', 'contain'], attract: ['contain', 'obtain', 'admit'],
  compare: ['convince', 'participate', 'contain'], confirm: ['participate', 'provide', 'contain'],
  consider: ['provide', 'convince', 'contain'], contain: ['convince', 'participate', 'afford'],
  convince: ['contain', 'reduce', 'participate'], develop: ['contain', 'admit', 'avoid'],
  discover: ['convince', 'participate', 'attract'], encourage: ['contain', 'reduce', 'participate'],
  estimate: ['contain', 'provide', 'participate'], expand: ['avoid', 'admit', 'contain'],
  explore: ['contain', 'convince', 'participate'], improve: ['avoid', 'contain', 'admit'],
  include: ['convince', 'participate', 'afford'], involve: ['convince', 'provide', 'obtain'],
  maintain: ['avoid', 'admit', 'convince'], obtain: ['convince', 'participate', 'contain'],
  participate: ['contain', 'convince', 'provide'], prevent: ['provide', 'attract', 'contain'],
  provide: ['convince', 'participate', 'avoid'], reduce: ['attract', 'convince', 'participate'],
  opportunity: ['responsibility', 'environment', 'consequence'],
  responsibility: ['environment', 'evidence', 'consequence'], advantage: ['issue', 'effort', 'consequence'],
  evidence: ['environment', 'consequence', 'opportunity'], effort: ['environment', 'issue', 'advantage'],
  resource: ['consequence', 'effort', 'responsibility'], consequence: ['effort', 'resource', 'environment'],
  environment: ['consequence', 'responsibility', 'effort'], experience: ['environment', 'consequence', 'opportunity'],
  issue: ['evidence', 'effort', 'environment'], available: ['aware', 'confident', 'accurate'],
  aware: ['available', 'accurate', 'convenient'], likely: ['accurate', 'familiar', 'effective'],
  familiar: ['accurate', 'available', 'essential'], effective: ['aware', 'familiar', 'confident'],
  essential: ['confident', 'familiar', 'aware'], accurate: ['aware', 'confident', 'familiar'],
  suitable: ['aware', 'confident', 'accurate'], confident: ['accurate', 'convenient', 'familiar'],
  convenient: ['aware', 'confident', 'familiar'],
  reluctant: ['empirical', 'simultaneous', 'subsequent'], undermine: ['allocate', 'implement', 'compensate'],
  plausible: ['detrimental', 'simultaneous', 'reluctant'], mitigate: ['exacerbate', 'allocate', 'retain'],
  substantial: ['subsequent', 'impartial', 'vulnerable'], inevitable: ['impartial', 'coherent', 'empirical'],
  allocate: ['contradict', 'deteriorate', 'eliminate'], sustainable: ['reluctant', 'simultaneous', 'empirical'],
  implement: ['deteriorate', 'compensate', 'allocate'], advocate: ['allocate', 'compensate', 'deteriorate'],
  deteriorate: ['allocate', 'implement', 'justify'], coherent: ['subsequent', 'reluctant', 'vulnerable'],
  resilient: ['ambiguous', 'detrimental', 'subsequent'], ambiguous: ['coherent', 'explicit', 'impartial'],
  feasible: ['ambiguous', 'detrimental', 'substantial'], compelling: ['reluctant', 'simultaneous', 'subsequent'],
  inherent: ['reluctant', 'simultaneous', 'impartial'], prominent: ['reluctant', 'empirical', 'accountable'],
  detrimental: ['sufficient', 'impartial', 'simultaneous'], incentive: ['constraint', 'consensus', 'scrutiny'],
  consensus: ['incentive', 'constraint', 'scrutiny'], scrutiny: ['incentive', 'consensus', 'constraint'],
  constraint: ['consensus', 'scrutiny', 'incentive'], integrate: ['contradict', 'deteriorate', 'compensate'],
  facilitate: ['exacerbate', 'contradict', 'allocate'], exacerbate: ['mitigate', 'allocate', 'implement'],
  comprehensive: ['reluctant', 'simultaneous', 'vulnerable'], subsequent: ['substantial', 'vulnerable', 'empirical'],
  diverse: ['reluctant', 'subsequent', 'vulnerable'], retain: ['contradict', 'exacerbate', 'allocate'],
  diminish: ['allocate', 'implement', 'contradict'], reinforce: ['undermine', 'allocate', 'exacerbate'],
  sufficient: ['reluctant', 'ambiguous', 'empirical'], fluctuate: ['allocate', 'contradict', 'implement'],
  anticipate: ['eliminate', 'allocate', 'deteriorate'], contradict: ['allocate', 'deteriorate', 'compensate'],
  impartial: ['reluctant', 'simultaneous', 'persistent'], eliminate: ['reinforce', 'anticipate', 'exacerbate'],
  preserve: ['contradict', 'allocate', 'exacerbate'], adapt: ['eliminate', 'justify', 'implement'],
  justify: ['undermine', 'retain', 'deteriorate'], accountable: ['ambiguous', 'empirical', 'subsequent'],
  vulnerable: ['impartial', 'coherent', 'subsequent'], simultaneous: ['reluctant', 'impartial', 'vulnerable'],
  persistent: ['impartial', 'simultaneous', 'empirical'], preliminary: ['reluctant', 'vulnerable', 'detrimental'],
  empirical: ['reluctant', 'simultaneous', 'detrimental'], viable: ['ambiguous', 'detrimental', 'substantial'],
  compensate: ['deteriorate', 'implement', 'allocate'], explicit: ['ambiguous', 'simultaneous', 'reluctant'],
};

function seedFor(value: string): number {
  let seed = 2166136261;
  for (const character of value) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  return seed;
}

const normalizedChoice = (value: string) => normalizeVocabularyAnswer(value).replace(/\s/g, '');

function distractorsFor(entry: VocabularyEntry, pool: VocabularyEntry[], mode: 'meaning' | 'word' | 'context', seed: number): VocabularyEntry[] {
  const authored = contextDistractors[entry.id];
  const byId = new Map(pool.map(item => [item.id, item]));
  const preferred = (authored ?? []).map(id => byId.get(id)).filter((candidate): candidate is VocabularyEntry => !!candidate);
  const candidates = mode === 'context' ? preferred : [...preferred, ...shuffle(pool, seed)];
  const accepted = new Set([entry.word, ...entry.recall.answers, ...(entry.recall.alternatives ?? []).map(alternative => alternative.answer)].map(normalizedChoice));
  const meaningParts = new Set(entry.meaning?.split(/[・、／/]/u).map(normalizedChoice));
  const used = new Set([normalizedChoice(mode === 'meaning' ? entry.meaning : entry.word)]);
  const selected: VocabularyEntry[] = [];
  // Prefer the same level and part of speech without ever broadening reviewed context distractors.
  const rank = (candidate: VocabularyEntry) => (candidate.level === entry.level ? 0 : 2) + (candidate.partOfSpeech === entry.partOfSpeech ? 0 : 1);
  const ordered = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index);
  for (const { candidate } of ordered) {
    if (candidate.id === entry.id || !candidate.word || accepted.has(normalizedChoice(candidate.word))) continue;
    if (candidate.recall.answers.some(answer => accepted.has(normalizedChoice(answer)))) continue;
    if (candidate.meaning?.split(/[・、／/]/u).some(part => meaningParts.has(normalizedChoice(part)))) continue;
    const choice = mode === 'meaning' ? candidate.meaning : candidate.word;
    if (!choice?.trim() || used.has(normalizedChoice(choice))) continue;
    selected.push(candidate); used.add(normalizedChoice(choice));
    if (selected.length === 3) return selected;
  }
  throw new Error(`「${entry.word}」の4択に必要な語が足りません。単語セット全体を読み込んでください。`);
}

function choiceItem(entry: VocabularyEntry, mode: 'meaning' | 'word' | 'context', attempt: number, pool: VocabularyEntry[]): VocabularyTestItem {
  const seed = seedFor(`${entry.id}:${mode}`) + attempt * 31;
  const answer = mode === 'meaning' ? entry.meaning : mode === 'context' ? entry.recall.answers[0] : entry.word;
  const wrong = distractorsFor(entry, pool, mode, seed).map(candidate => mode === 'meaning' ? candidate.meaning : candidate.word);
  const choices = shuffle([answer, ...wrong], seed);
  const prompt = mode === 'meaning' ? entry.word : mode === 'word' ? entry.meaning : entry.recall.prompt.replace(/^今回学んだ語を1語で入れてください。\s*/u, '');
  return { id: `${entry.id}:${mode}`, wordId: entry.id, mode, kind: 'choice', prompt, choices,
    correctIndex: choices.indexOf(answer), explanation: mode === 'context' ? entry.recall.explanation : `${entry.word}：${entry.meaning}\n${entry.usageTip}` };
}

function usageItem(entry: VocabularyEntry, attempt: number): VocabularyTestItem {
  const question = entry.questions[attempt % entry.questions.length];
  const order = shuffle(question.choices.map((_, index) => index), seedFor(`${entry.id}:usage`) + attempt * 31);
  // Existing authored explanations name choices by number. Update every such reference atomically.
  const explanation = question.explanation.replace(/正解は([1-4])|(?<!\d)([1-4])(?=の|は)/gu, (_match, correct: string | undefined, reference: string | undefined) => {
    const number = order.indexOf(Number(correct ?? reference) - 1) + 1;
    return correct ? `正解は${number}` : String(number);
  });
  return { id: `${entry.id}:usage:${question.id}`, wordId: entry.id, mode: 'usage', kind: 'choice', prompt: question.prompt,
    choices: order.map(index => question.choices[index]), correctIndex: order.indexOf(question.correctIndex), explanation };
}

/** New batches carry complete reviewed choices; they never need an unrelated catalog word pool. */
function authoredItem(entry: VocabularyEntry, mode: Exclude<VocabularyTestMode, 'recall'>, attempt: number): VocabularyTestItem | undefined {
  if (!entry.tests) return undefined;
  const candidates = entry.tests.filter(test => test.mode === mode);
  const question = candidates[attempt % candidates.length];
  if (!question) throw new Error(`「${entry.word}」のテストがまだ準備されていません。`);
  const order = shuffle(question.choices.map((_, index) => index), seedFor(`${entry.id}:${mode}`) + attempt * 31);
  return {
    id: `${entry.id}:${mode}`, wordId: entry.id, mode, kind: 'choice', prompt: question.prompt,
    choices: order.map(index => question.choices[index].text),
    choiceMeanings: order.map(index => question.choices[index].meaning),
    correctIndex: order.indexOf(question.correctIndex), explanation: question.explanation,
    alternatives: question.alternatives.map(alternative => ({ ...alternative })),
  };
}

/** Without a mode, retain the original recall-then-usage test for saved callers. */
export function buildVocabularyTest(entries: VocabularyEntry[], round = 0, mode?: VocabularyTestMode, distractorPool: VocabularyEntry[] = entries): VocabularyTestItem[] {
  const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
  const attempt = Math.max(0, Math.floor(round) || 0);
  if (mode) {
    const pool = [...new Map([...distractorPool, ...unique].map(entry => [entry.id, entry])).values()];
    return shuffle(unique, seedFor(mode) + attempt * 47).map(entry => {
      if (mode === 'recall') return { id: `${entry.id}:recall`, wordId: entry.id, mode, kind: 'recall', prompt: entry.recall.prompt, answers: [...entry.recall.answers], explanation: entry.recall.explanation,
        ...(entry.recall.alternatives?.length ? { alternatives: entry.recall.alternatives.map(alternative => ({ ...alternative })) } : {}) };
      const authored = authoredItem(entry, mode, attempt);
      if (authored) return authored;
      if (mode === 'usage') return usageItem(entry, attempt);
      return choiceItem(entry, mode, attempt, pool);
    });
  }
  const recalls: VocabularyTestItem[] = shuffle(unique, 37 + attempt * 31).map(entry => ({
    id: `${entry.id}:recall`, wordId: entry.id, kind: 'recall', prompt: entry.recall.prompt,
    answers: [...entry.recall.answers], explanation: entry.recall.explanation,
    ...(entry.recall.alternatives?.length ? { alternatives: entry.recall.alternatives.map(alternative => ({ ...alternative })) } : {}),
  }));
  let choices: VocabularyTestItem[] = shuffle(unique, 71 + attempt * 47).map(entry => {
    const question = entry.questions[attempt % entry.questions.length];
    // Preserve authored choice order: explanations refer to its numbers.
    return { id: `${entry.id}:choice:${question.id}`, wordId: entry.id, kind: 'choice', prompt: question.prompt,
      choices: [...question.choices], correctIndex: question.correctIndex, explanation: question.explanation };
  });
  if (choices.length > 1 && recalls.at(-1)?.wordId === choices[0].wordId) choices = [...choices.slice(1), choices[0]];
  return [...recalls, ...choices];
}

export function normalizeVocabularyAnswer(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').replace(/[.!?。！？]+$/, '').trim();
}

/** "Incorrect" means no recorded match; it is not a judgment that the English is ungrammatical. */
export function evaluateVocabularyAnswer(item: VocabularyTestItem, answer: number | string): 'target' | 'alternative' | 'incorrect' {
  if (item.kind === 'choice') return typeof answer === 'number' && Number.isInteger(answer) && answer === item.correctIndex ? 'target' : 'incorrect';
  if (typeof answer !== 'string') return 'incorrect';
  const normalized = normalizeVocabularyAnswer(answer);
  if (!normalized) return 'incorrect';
  if (item.answers?.some(expected => normalizeVocabularyAnswer(expected) === normalized)) return 'target';
  if (item.alternatives?.some(alternative => normalizeVocabularyAnswer(alternative.answer) === normalized)) return 'alternative';
  return 'incorrect';
}

export function checkVocabularyAnswer(item: VocabularyTestItem, answer: number | string): boolean {
  return evaluateVocabularyAnswer(item, answer) !== 'incorrect';
}

export function summarizeVocabularyTest(items: VocabularyTestItem[], answers: Record<string, number | string>) {
  const result = { choice: { correct: 0, total: 0 }, recall: { correct: 0, total: 0 }, targetRecallCorrect: 0, alternativeRecall: 0, wrongWordIds: [] as string[], completed: items.length > 0 };
  for (const item of items) {
    result[item.kind].total++;
    // An explicit empty answer means the learner chose「分からない」; an absent property is unanswered.
    const answered = Object.hasOwn(answers, item.id);
    if (!answered) result.completed = false;
    const evaluation = answered ? evaluateVocabularyAnswer(item, answers[item.id]) : 'incorrect';
    if (evaluation !== 'incorrect') result[item.kind].correct++;
    if (item.kind === 'recall' && evaluation === 'target') result.targetRecallCorrect++;
    if (item.kind === 'recall' && evaluation === 'alternative') result.alternativeRecall++;
    // A valid synonym earns credit, while the study word still belongs in the next recall round.
    if (evaluation !== 'target' && !result.wrongWordIds.includes(item.wordId)) result.wrongWordIds.push(item.wordId);
  }
  return result;
}
