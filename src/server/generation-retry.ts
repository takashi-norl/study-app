import 'server-only';
import { randomUUID } from 'node:crypto';
import { start } from 'workflow/api';
import type { GenerationJob, Profile, StudyData } from '@/lib/types';
import { generationWorkflow } from '@/workflows/generate';
import { ApiError, requireGenerationEnabled } from './config';
import { appendEvent, getFullState, type StudyEvent } from './google-store';
import { assertGenerationAccess } from './proposal-selection';
import { assertGenerationBudget } from './generation-request';
import { paidWorkSlotId } from './planning';
import { assertExternalEffectAllowed } from './environment';

export function prepareGenerationRetry(data: StudyData, profile: Profile, jobId: string, requestId: string, now: Date, newId: string) {
  const original = data.jobs.find(job => job.id === jobId);
  if (!original || original.requestedBy !== profile.id) throw new ApiError(404, '自分の作問依頼が見つかりません。', 'JOB_NOT_FOUND');
  assertGenerationAccess(data, original);
  // One child per failed attempt, including when a device loses its local request ID.
  const previous = data.jobs.find(job => job.retryOfJobId === original.id);
  if (previous) { assertGenerationAccess(data, previous); return { job: previous, existing: true }; }
  if (original.status !== 'failed') throw new ApiError(409, 'この作問は再依頼する必要がありません。最新の状況を確認してください。', 'JOB_NOT_FAILED');
  const generatedCount = new Set(data.questions.filter(question => question.topicId === original.topicId).map(question => question.id)).size;
  if (generatedCount >= original.targetCount) throw new ApiError(409, '目標の問題数を保存済みです。できた問題を確認してください。', 'JOB_ALREADY_SAVED');
  if (data.jobs.some(job => job.requestedBy === profile.id && job.requestId === requestId)) throw new ApiError(409, '別の作問に使われた依頼です。画面を更新してください。', 'REQUEST_CONFLICT');
  assertGenerationBudget(data, now);
  // Reuse server-saved instructions, audience and material scope. The client cannot alter them.
  const { error: _error, ...saved } = original;
  const job: GenerationJob = { ...saved, id: newId, status: 'queued', generatedCount,
    createdAt: now.toISOString(), requestId, retryOfJobId: original.id };
  return { job, existing: false };
}

export interface GenerationRetryDependencies {
  load: () => Promise<{ data: StudyData; events: StudyEvent[] }>;
  append: (event: StudyEvent) => Promise<void>;
  dispatch: (jobId: string) => Promise<unknown>;
  enabled: () => void;
  now: () => Date;
  newId: () => string;
}
const defaults: GenerationRetryDependencies = { load: getFullState, append: appendEvent,
  dispatch: jobId => start(generationWorkflow, [jobId]), enabled: () => { assertExternalEffectAllowed('workflow'); requireGenerationEnabled(); }, now: () => new Date(), newId: randomUUID };

export async function retryGeneration(profile: Profile, jobId: string, requestId: string, deps: GenerationRetryDependencies = defaults) {
  deps.enabled();
  const { data } = await deps.load();
  const prepared = prepareGenerationRetry(data, profile, jobId, requestId, deps.now(), deps.newId());
  let job = prepared.job;
  if (!prepared.existing) {
    const slotId = paidWorkSlotId(data);
    await deps.append({ id: slotId, type: 'job.upserted', actorId: profile.id, createdAt: job.createdAt, payload: job });
    const canonical = (await deps.load()).events.find(event => event.id === slotId);
    const winner = canonical?.type === 'job.upserted' ? canonical.payload as GenerationJob : undefined;
    if (!winner || winner.retryOfJobId !== jobId || winner.requestedBy !== profile.id) throw new ApiError(409, '別のAI処理を先に受け付けました。最新の状況を確認してください。', 'GENERATION_ACTIVE');
    job = winner;
  }
  if (job.status === 'queued') {
    try { await deps.dispatch(job.id); }
    catch { throw new ApiError(503, '続きの依頼は保存済みです。開始を確認できませんでした。同じボタンから状況を確認できます。', 'WORKFLOW_UNAVAILABLE'); }
  }
  return { job, notice: job.status === 'failed' ? 'この依頼の結果を確認してください。'
    : job.status === 'review' ? '問題は保存済みです。できた問題を確認してください。'
    : '同じ条件で続きを作っています。保存済みの教材と問題を引き継ぎました。' };
}
