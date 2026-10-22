import 'server-only';
import { randomUUID } from 'node:crypto';
import { start } from 'workflow/api';
import type { GenerationJob, Profile, StudyData, Topic } from '@/lib/types';
import { ApiError, MAX_SOURCE_BYTES, requireGenerationEnabled } from './config';
import { canAccessSource } from './access';
import { appendEvent, getDriveFileMetadata, getFullState } from './google-store';
import { paidWorkSlotId } from './planning';
import { currentProposal, generationReplay, type GenerationSelection } from './proposal-selection';
import { generationWorkflow } from '@/workflows/generate';

export interface GenerationRequest {
  topic: Topic; newTopic?: boolean; sourceIds: string[]; targetCount: number;
  requestId?: string; expectedVersion?: number; planId?: string; turnId?: string; proposalId?: string; instructions?: string;
}

export async function resumeGenerationRequest(data: StudyData, profile: Profile, input: GenerationSelection) {
  const previous = generationReplay(data,profile,input);
  if (!previous) return undefined;
  if (previous.job.status === 'queued') {
    requireGenerationEnabled();
    // A queued row can survive a lost dispatch response. The durable hook makes duplicate starts harmless.
    try { await start(generationWorkflow,[previous.job.id]); }
    catch { throw new ApiError(503,'作問の開始を確認できませんでした。同じ依頼で再度お試しください。','WORKFLOW_UNAVAILABLE'); }
  }
  return previous;
}

export function assertGenerationBudget(data: StudyData, now = new Date()) {
  if (data.jobs.some(job => job.status === 'queued' || job.status === 'running')
    || data.planningTurns.some(turn => turn.status === 'queued' || turn.status === 'running')) {
    throw new ApiError(409, 'いま進めているAIの処理が終わるまでお待ちください。', 'GENERATION_ACTIVE');
  }
  const japanDay = (date: string | Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(date));
  const day = japanDay(now);
  const limit = (name: string, fallback: number) => Math.max(1, Math.min(100, Number.parseInt(process.env[name] || String(fallback), 10) || fallback));
  if (data.jobs.filter(job => japanDay(job.createdAt) === day).length >= limit('GENERATION_DAILY_JOB_LIMIT', 3)) throw new ApiError(429, '本日の作問回数の上限に達しました。', 'DAILY_BUDGET_LIMIT');
  if (data.jobs.filter(job => japanDay(job.createdAt).slice(0, 7) === day.slice(0, 7)).length >= limit('GENERATION_MONTHLY_JOB_LIMIT', 10)) throw new ApiError(429, '今月の作問回数の上限に達しました。', 'MONTHLY_BUDGET_LIMIT');
}

/** Only server-validated proposals may request student-owned, immediately usable practice. */
export async function requestGeneration(profile: Profile, input: GenerationRequest) {
  const { data } = await getFullState();
  const previous = await resumeGenerationRequest(data,profile,{...input,title:input.topic.title});
  if (previous) return previous;
  requireGenerationEnabled();
  if(input.planId) currentProposal(data,profile,input.planId,{expectedVersion:input.expectedVersion!,turnId:input.turnId!,proposalId:input.proposalId!});
  if (profile.role === 'student' && (!input.planId || input.topic.audienceUserId !== profile.id)) throw new ApiError(403, '自分の学習相談から作問してください。', 'FORBIDDEN');
  if (input.topic.planId && (!input.planId || input.topic.planId !== input.planId || !data.plans.some(plan=>plan.id===input.topic.planId && plan.ownerId===profile.id))) throw new ApiError(403,'この相談から作問できるのは本人だけです。','FORBIDDEN');
  if (!input.newTopic && !data.topics.some(topic => topic.id === input.topic.id)) throw new ApiError(404, '問題集が見つかりません。');
  if (!Number.isInteger(input.targetCount) || input.targetCount < 1 || input.targetCount > 300) throw new ApiError(400, '問題数は1〜300問で指定してください。');
  const sourceIds = [...new Set(input.sourceIds)];
  if (sourceIds.length > 20 || (!sourceIds.length && !input.planId)) throw new ApiError(400, '作問に使う資料を選択してください。');
  assertGenerationBudget(data);
  for (const id of sourceIds) {
    const source = data.sources.find(source => source.id === id && canAccessSource(source, profile));
    if (!source?.storagePath) throw new ApiError(404, '選択した資料が見つかりません。');
    const metadata = await getDriveFileMetadata(source.storagePath);
    if (metadata.appProperties?.sourceId !== source.id || metadata.mimeType !== source.mimeType || Number(metadata.size) <= 0 || Number(metadata.size) > MAX_SOURCE_BYTES) throw new ApiError(422, '資料のアップロード完了を確認できません。');
  }
  const now = new Date().toISOString();
  const job: GenerationJob = { id: randomUUID(), topicId: input.topic.id, status: 'queued', targetCount: input.targetCount,
    generatedCount: 0, createdAt: now, sourceIds, requestedBy: profile.id, requestId: input.requestId,
    planId: input.planId, turnId: input.turnId, proposalId: input.proposalId, instructions: input.instructions, audienceUserId: input.topic.audienceUserId };
  const slotId = paidWorkSlotId(data);
  // One row claims paid work and creates its set; a losing request leaves no empty set.
  await appendEvent({ id: slotId, type: input.newTopic ? 'generation.requested' : 'job.upserted', actorId: profile.id,
    createdAt: now, payload: input.newTopic ? { topic: input.topic, job } : job });
  const canonical = (await getFullState()).events.find(event => event.id === slotId);
  const winningId = canonical?.type === 'generation.requested' ? canonical.payload.job.id : canonical?.payload.id;
  if (winningId !== job.id) throw new ApiError(409, '別のAI処理を先に受け付けました。画面を更新してください。', 'GENERATION_ACTIVE');
  try { await start(generationWorkflow, [job.id]); }
  catch {
    // Do not mark an uncertain dispatch failed: it may already be doing paid work.
    // Keep the canonical queued/running job so an explicit retry uses the same hook.
    throw new ApiError(503, '作問の開始を確認できませんでした。同じ依頼を再試行するか「再開」を押してください。', 'WORKFLOW_UNAVAILABLE');
  }
  return { job, topic: input.topic };
}
