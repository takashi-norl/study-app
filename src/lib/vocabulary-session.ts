import type { VocabularyEntry } from './vocabulary-types';

export type VocabularyTestItem = {
  id: string; wordId: string; kind: 'choice' | 'recall'; prompt: string;
  choices?: string[]; correctIndex?: number; answers?: string[]; explanation: string;
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

/** Recall comes first: seeing the word in a choice question must not give away its recall answer. */
export function buildVocabularyTest(entries: VocabularyEntry[], round = 0): VocabularyTestItem[] {
  const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()];
  const attempt = Math.max(0, Math.floor(round) || 0);
  const recalls: VocabularyTestItem[] = shuffle(unique, 37 + attempt * 31).map(entry => ({
    id: `${entry.id}:recall`, wordId: entry.id, kind: 'recall', prompt: entry.recall.prompt,
    answers: [...entry.recall.answers], explanation: entry.recall.explanation,
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

export function checkVocabularyAnswer(item: VocabularyTestItem, answer: number | string): boolean {
  if (item.kind === 'choice') return typeof answer === 'number' && Number.isInteger(answer) && answer === item.correctIndex;
  if (typeof answer !== 'string' || !normalizeVocabularyAnswer(answer)) return false;
  return !!item.answers?.some(expected => normalizeVocabularyAnswer(expected) === normalizeVocabularyAnswer(answer));
}

export function summarizeVocabularyTest(items: VocabularyTestItem[], answers: Record<string, number | string>) {
  const result = { choice: { correct: 0, total: 0 }, recall: { correct: 0, total: 0 }, wrongWordIds: [] as string[], completed: items.length > 0 };
  for (const item of items) {
    result[item.kind].total++;
    // An explicit empty answer means the learner chose「分からない」; an absent property is unanswered.
    const answered = Object.hasOwn(answers, item.id);
    if (!answered) result.completed = false;
    if (answered && checkVocabularyAnswer(item, answers[item.id])) result[item.kind].correct++;
    else if (!result.wrongWordIds.includes(item.wordId)) result.wrongWordIds.push(item.wordId);
  }
  return result;
}
