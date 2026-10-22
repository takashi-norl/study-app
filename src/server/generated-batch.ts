import { randomUUID } from 'node:crypto';
import type { GenerationJob, Question } from '@/lib/types';

type Candidate = Pick<Question, 'prompt' | 'choices' | 'correctIndex' | 'explanation' | 'learningPoint' | 'sourceIds' | 'sourceNote'>;

/** Keep provenance and private practice policy independent of claims in AI output. */
export function materializeQuestions(candidates: Candidate[], input: {
  job: GenerationJob; sourceIds: string[]; prior: Question[]; count: number; createdAt: string;
}): Question[] {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const seen = new Set(input.prior.map(question => normalize(question.prompt)));
  const sources = new Set(input.sourceIds);
  const selfStudy = !!input.job.audienceUserId && input.job.audienceUserId === input.job.requestedBy;
  const questions: Question[] = [];
  for (const candidate of candidates) {
    if (questions.length >= input.count || seen.has(normalize(candidate.prompt))
      || candidate.sourceIds.some(id => !sources.has(id)) || (sources.size > 0 && !candidate.sourceIds.length)) continue;
    seen.add(normalize(candidate.prompt));
    questions.push({ ...candidate, id: randomUUID(), topicId: input.job.topicId, version: 1,
      sourceNote: sources.size ? candidate.sourceNote : 'AI作成の自習問題（資料なし）',
      status: selfStudy ? 'published' : 'draft', needsReview: !selfStudy, createdAt: input.createdAt,
      publishedAt: selfStudy ? input.createdAt : undefined, audienceUserId: input.job.audienceUserId, planId: input.job.planId });
  }
  return questions;
}
