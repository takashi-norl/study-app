import type { GenerationJob, LearningPlan, PlanningProposal, Profile, StudyData } from '@/lib/types';
import { ApiError } from './config';
import { canAccessSource,canAccessQuestion,canAccessPlan } from './access';
import { questionTemplateRules, validateVocabularyQuestions } from '@/lib/kobun-vocabulary';
import { validateSamples } from './planning-samples';

export interface GenerationSelection {
  requestId?: string; planId?: string; turnId?: string; proposalId?: string; targetCount?: number; title?: string; dailyQuestionTarget?:number; plannedDays?:number;
}

/** A retry identifies the original operation, not a new set with changed options. */
export function generationReplay(data: StudyData, profile: Profile, input: GenerationSelection) {
  if (!input.requestId) return undefined;
  const job = data.jobs.find(job => job.requestId === input.requestId && job.requestedBy === profile.id);
  if (!job) return undefined;
  if(!canAccessQuestion(job,profile)) throw new ApiError(404,'作問依頼が見つかりません。','TOPIC_NOT_FOUND');
  if (job.planId && !data.plans.some(plan => plan.id === job.planId && plan.questionTemplate === job.questionTemplate && plan.ownerId === profile.id)) throw new ApiError(404, '自分の学習相談が見つかりません。', 'PLAN_NOT_FOUND');
  const topic = data.topics.find(topic => topic.id === job.topicId);
  if (!topic) throw new ApiError(404, '作成先の問題集が見つかりません。', 'TOPIC_NOT_FOUND');
  if (job.planId !== input.planId || job.turnId !== input.turnId || job.proposalId !== input.proposalId
    || (input.targetCount !== undefined && job.targetCount !== input.targetCount)
    || (input.title !== undefined && topic.title !== input.title)
    || (input.dailyQuestionTarget!==undefined && job.dailyQuestionTarget!==input.dailyQuestionTarget)
    || (input.plannedDays!==undefined && job.plannedDays!==input.plannedDays)) {
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
  if(job.questionTemplate && topic.subject!=='古文')throw new ApiError(403,'古文の単語問題として確認できません。','GENERATION_ACCESS_DENIED');
  if(topic.libraryPublished) throw new ApiError(403,'公開版に問題を追加することはできません。','GENERATION_ACCESS_DENIED');
  if (job.questionTemplate !== topic.questionTemplate || job.audienceUserId !== topic.audienceUserId || job.planId !== topic.planId || !!job.testOnly!==!!topic.testOnly || !canAccessQuestion(job,requester) || !canAccessQuestion(topic,requester)) throw new ApiError(403, '作問先の設定が一致しません。', 'GENERATION_ACCESS_DENIED');
  if (job.planId && !data.plans.some(plan => plan.id === job.planId && plan.ownerId === requester.id && canAccessPlan(plan,requester) && !!plan.testOnly===!!job.testOnly)) throw new ApiError(403, 'この相談から作問できるのは本人だけです。', 'GENERATION_ACCESS_DENIED');
  if (requester.role === 'student' && (!job.planId || job.audienceUserId !== requester.id)) throw new ApiError(403, '自分の学習相談から作問してください。', 'GENERATION_ACCESS_DENIED');
  if(job.approvedSamples) {
    const turn=data.planningTurns.find(turn=>turn.id===job.turnId && turn.planId===job.planId && turn.requestedBy===requester.id && turn.version===job.approvedSampleVersion && turn.status==='complete');
    const proposal=turn?.proposals?.find(proposal=>proposal.id===job.proposalId);
    if(!proposal || (job.approvedInstructions!==undefined && job.approvedInstructions!==proposal.instructions) || JSON.stringify(validateSamples(proposal.samples,proposal.sourceIds))!==JSON.stringify(job.approvedSamples)) throw new ApiError(403,'承認したサンプルを確認できません。','GENERATION_ACCESS_DENIED');
  }
  for (const id of job.sourceIds ?? []) {
    const source = data.sources.find(source => source.id === id);
    if (!source?.storagePath || !canAccessSource(source,requester)) throw new ApiError(403, '選択した資料へのアクセス権が変更されました。', 'GENERATION_ACCESS_DENIED');
  }
  return requester;
}

export function currentProposal(data: StudyData, profile: Profile, planId: string,
  input: { expectedVersion: number; turnId: string; proposalId: string }) {
  const plan = data.plans.find(plan => plan.id === planId && plan.ownerId === profile.id && canAccessPlan(plan,profile));
  if (!plan) throw new ApiError(404, '自分の学習相談が見つかりません。', 'PLAN_NOT_FOUND');
  if (plan.version !== input.expectedVersion) throw new ApiError(409, '相談が更新されています。最新の提案を確認してください。', 'VERSION_CONFLICT');
  const turn = data.planningTurns.find(turn => turn.id === input.turnId && turn.planId === plan.id
    && turn.requestedBy === profile.id && turn.version === plan.version && turn.status === 'complete');
  const proposal = turn?.proposals?.find(proposal => proposal.id === input.proposalId);
  if (!proposal) throw new ApiError(409, '最新の相談で作られた提案を選んでください。', 'STALE_PROPOSAL');
  if (proposal.sourceIds.some(id => !plan.sourceIds.includes(id))) throw new ApiError(422, '提案の資料を確認できません。', 'INVALID_AI_SOURCE');
  return { plan, turn: turn!, proposal };
}

/** A new paid bulk job must approve the immutable current server-side samples, never client examples. */
export function currentApprovedProposal(data:StudyData,profile:Profile,planId:string|undefined,input:{expectedVersion?:number;turnId?:string;proposalId?:string;approveSamples?:boolean}) {
  if(!planId || !input.expectedVersion || !input.turnId || !input.proposalId || input.approveSamples!==true) throw new ApiError(409,'まず3問のサンプルを確認し、この作り方でよいか決めてから本作成へ進んでください。','SAMPLE_APPROVAL_REQUIRED');
  const selected=currentProposal(data,profile,planId,{expectedVersion:input.expectedVersion,turnId:input.turnId,proposalId:input.proposalId});
  const samples=validateSamples(selected.proposal.samples,selected.proposal.sourceIds);
  if(questionTemplateRules(selected.plan.subject,selected.plan.questionTemplate)){
    if(selected.proposal.subject!==selected.plan.subject)throw new ApiError(422,'古文の単語問題として試作し直してください。','INVALID_VOCABULARY_QUESTION');
    try{validateVocabularyQuestions(samples);}catch(error){throw new ApiError(422,error instanceof Error?error.message:'単語問題を確認できません。','INVALID_VOCABULARY_QUESTION');}
  }
  return {...selected,samples};
}

export function validateBulkCadence(targetCount:number,dailyQuestionTarget?:number,plannedDays?:number):void {
  if(!Number.isInteger(targetCount) || targetCount<1 || targetCount>300) throw new ApiError(400,'作る問題の総数は1〜300問で選んでください。','INVALID_BULK_COUNT');
  if(dailyQuestionTarget!==undefined && (!Number.isInteger(dailyQuestionTarget) || dailyQuestionTarget<1 || dailyQuestionTarget>100)) throw new ApiError(400,'1日の目安は1〜100問で選んでください。','INVALID_STUDY_PACE');
  if(plannedDays!==undefined && (!Number.isInteger(plannedDays) || plannedDays<1 || plannedDays>300 || dailyQuestionTarget===undefined || plannedDays*dailyQuestionTarget!==targetCount)) throw new ApiError(400,'日数と1日の問題数をかけた総数を確認してください。','INVALID_STUDY_PACE');
}
