import type { GenerationJob, LearningPlan, PlanningProposal, Profile, StudyData } from '@/lib/types';
import { ApiError } from './config';
import { canAccessSource } from './access';

export interface GenerationSelection {
  requestId?: string; planId?: string; turnId?: string; proposalId?: string; targetCount?: number; title?: string;
}

/** A retry identifies the original operation, not a new set with changed options. */
export function generationReplay(data: StudyData, profile: Profile, input: GenerationSelection) {
  if (!input.requestId) return undefined;
  const job = data.jobs.find(job => job.requestId === input.requestId && job.requestedBy === profile.id);
  if (!job) return undefined;
  if (job.planId && !data.plans.some(plan => plan.id === job.planId && plan.ownerId === profile.id)) throw new ApiError(404, '自分の学習相談が見つかりません。', 'PLAN_NOT_FOUND');
  const topic = data.topics.find(topic => topic.id === job.topicId);
  if (!topic) throw new ApiError(404, '作成先の問題集が見つかりません。', 'TOPIC_NOT_FOUND');
  if (job.planId !== input.planId || job.turnId !== input.turnId || job.proposalId !== input.proposalId
    || (input.targetCount !== undefined && job.targetCount !== input.targetCount)
    || (input.title !== undefined && topic.title !== input.title)) {
    throw new ApiError(409, 'この依頼は別の作問に使われています。画面を更新してください。', 'REQUEST_CONFLICT');
  }
  return { job, topic };
}

/** Fit the event's 4,000-character budget while retaining the latest conversational arrangement first. */
export function generationInstructions(plan: LearningPlan, proposal: PlanningProposal): string {
  return [`今回の作問指示: ${proposal.instructions.slice(0,2600)}`, `今回の難易度: ${proposal.difficulty.slice(0,200)}`,
    `長期目標: ${plan.goal.slice(0,600)}`, `当初の目安: ${plan.difficulty.slice(0,150)}`,
    `目標日: ${plan.targetDate || '未指定'} / 1日の目安: ${plan.dailyQuestionTarget}問`,
    '今回の相談で更新した指示と難易度を優先してください。'].join('\n').slice(0,4000);
}

/** Recheck membership and source visibility before every paid step, including cached-source jobs. */
export function assertGenerationAccess(data: StudyData, job: GenerationJob) {
  const requester = data.profiles.find(profile => profile.id === job.requestedBy);
  const topic = data.topics.find(topic => topic.id === job.topicId);
  if (!requester || !topic) throw new ApiError(403, '作問依頼者の利用権限を確認できません。', 'GENERATION_ACCESS_DENIED');
  if (job.audienceUserId !== topic.audienceUserId || job.planId !== topic.planId) throw new ApiError(403, '作問先の設定が一致しません。', 'GENERATION_ACCESS_DENIED');
  if (job.planId && !data.plans.some(plan => plan.id === job.planId && plan.ownerId === requester.id)) throw new ApiError(403, 'この相談から作問できるのは本人だけです。', 'GENERATION_ACCESS_DENIED');
  if (requester.role === 'student' && (!job.planId || job.audienceUserId !== requester.id)) throw new ApiError(403, '自分の学習相談から作問してください。', 'GENERATION_ACCESS_DENIED');
  for (const id of job.sourceIds ?? []) {
    const source = data.sources.find(source => source.id === id);
    if (!source?.storagePath || !canAccessSource(source,requester)) throw new ApiError(403, '選択した資料へのアクセス権が変更されました。', 'GENERATION_ACCESS_DENIED');
  }
  return requester;
}

export function currentProposal(data: StudyData, profile: Profile, planId: string,
  input: { expectedVersion: number; turnId: string; proposalId: string }) {
  const plan = data.plans.find(plan => plan.id === planId && plan.ownerId === profile.id);
  if (!plan) throw new ApiError(404, '自分の学習相談が見つかりません。', 'PLAN_NOT_FOUND');
  if (plan.version !== input.expectedVersion) throw new ApiError(409, '相談が更新されています。最新の提案を確認してください。', 'VERSION_CONFLICT');
  const turn = data.planningTurns.find(turn => turn.id === input.turnId && turn.planId === plan.id
    && turn.requestedBy === profile.id && turn.version === plan.version && turn.status === 'complete');
  const proposal = turn?.proposals?.find(proposal => proposal.id === input.proposalId);
  if (!proposal) throw new ApiError(409, '最新の相談で作られた提案を選んでください。', 'STALE_PROPOSAL');
  if (proposal.sourceIds.some(id => !plan.sourceIds.includes(id))) throw new ApiError(422, '提案の資料を確認できません。', 'INVALID_AI_SOURCE');
  return { plan, turn: turn!, proposal };
}
