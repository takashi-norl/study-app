import { balanceVocabularyChoices, validateVocabularyQuestions } from '@/lib/kobun-vocabulary';
import { randomUUID } from 'node:crypto';
import type { GenerationJob, Question } from '@/lib/types';

type Candidate = Pick<Question, 'prompt' | 'choices' | 'correctIndex' | 'explanation' | 'learningPoint' | 'sourceIds' | 'sourceNote'> & Pick<Question, 'needsReview'>;

/** Keep provenance and private practice policy independent of claims in AI output. */
export function materializeQuestions(candidates: Candidate[], input: {
  job: GenerationJob; sourceIds: string[]; prior: Question[]; count: number; createdAt: string; excludedPrompts?: string[];
}): Question[] {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const seen = new Set([...input.prior.map(question => normalize(question.prompt)),...(input.excludedPrompts ?? []).map(normalize)]);
  const sources = new Set(input.sourceIds);
  const questions: Question[] = [];
  const checked=input.job.questionTemplate==='kobun-vocabulary' ? validateVocabularyQuestions(candidates) : candidates;
  for (const candidate of checked) {
    if (questions.length >= input.count || seen.has(normalize(candidate.prompt))
      || candidate.sourceIds.some(id => !sources.has(id)) || (sources.size > 0 && !candidate.sourceIds.length)) continue;
    seen.add(normalize(candidate.prompt));
    questions.push({ ...candidate, id: randomUUID(), topicId: input.job.topicId, version: 1,
      sourceNote: sources.size || input.job.questionTemplate==='kobun-vocabulary' ? candidate.sourceNote : 'AI作成の自習問題（資料なし）',
      status: 'published', needsReview: false, aiGenerated: true, ownerId: input.job.requestedBy, createdAt: input.createdAt,
      publishedAt: input.createdAt, audienceUserId: input.job.audienceUserId, planId: input.job.planId,testOnly:input.job.testOnly });
  }
  return input.job.questionTemplate==='kobun-vocabulary' ? balanceVocabularyChoices(questions,input.prior) : questions;
}
