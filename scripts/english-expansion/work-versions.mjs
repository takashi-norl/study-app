import * as v1 from './prompts.mjs';
import { generationWorkV2, reviewWorkV2, repairWorkV2, parseGeneratedV2, parseRepairedV2, parseReviewedV2 } from './prompts-v2.mjs';
import { hashContent } from './schema.mjs';

/** Existing unversioned work always uses the unchanged v1 wire builder. */
export function checkedVersionedWork(work) {
  const options = { id: work?.id, createdAt: work?.createdAt, model: work?.params?.model };
  let expected;
  if (work?.promptVersion === undefined) expected = work?.stage === 'generation' ? v1.generationWork(work.seeds ?? [], options) : work?.stage === 'review' ? v1.reviewWork(work.units ?? [], options) : null;
  else if (work.promptVersion === 'v2') expected = work.kind === 'tests-only-repair' ? repairWorkV2(work.units ?? [], work.repairPlan, work.rejection, options)
    : work.stage === 'generation' ? generationWorkV2(work.seeds ?? [], options) : work.stage === 'review' ? reviewWorkV2(work.units ?? [], options) : null;
  if (!expected || hashContent(expected) !== hashContent(work)) throw new Error('Work differs from its exact historical prompt version.');
  return expected;
}
export function parseVersionedGeneration(response, work) {
  checkedVersionedWork(work);
  return work.promptVersion === undefined ? v1.parseGenerated(response, work) : work.kind === 'tests-only-repair' ? parseRepairedV2(response, work) : parseGeneratedV2(response, work);
}
export function parseVersionedReview(response, work, reviewedAt = work.createdAt) {
  checkedVersionedWork(work);
  return work.promptVersion === undefined ? v1.parseReviewed(response, work, reviewedAt) : parseReviewedV2(response, work, reviewedAt);
}
export { generationWorkV2 as newGenerationWork, reviewWorkV2 as newReviewWork, repairWorkV2 };
