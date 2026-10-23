import 'server-only';
import type { LearningPlan, PlanningSample, Profile, StudyData } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { canAccessQuestion, canAccessSource } from './access';
import { topicOwnerId } from '@/lib/library-policy';
import { planningSampleSchema } from './planning-samples';
import { ApiError } from './config';
import { getFamilyId } from './env';

/** Start a separate private conversation from allowed content; never follow a public clone's private origin. */
export function preparePlanArrangement(data:StudyData,profile:Profile,topicId:string,requestId:string,now=new Date()):{plan:LearningPlan;event?:StudyEvent} {
  if(profile.familyId!==getFamilyId()) throw new ApiError(403,'ご家族のアカウントで操作してください。','FAMILY_MISMATCH');
  const existing=data.plans.find(plan=>plan.id===requestId);
  if(existing) {
    if(existing.ownerId!==profile.id || existing.arrangedFromTopicId!==topicId) throw new ApiError(409,'別の相談に使われた依頼です。画面を更新してください。','REQUEST_CONFLICT');
    return {plan:existing};
  }
  const topic=data.topics.find(topic=>topic.id===topicId);
  if(!topic || !canAccessQuestion(topic,profile) || (topic.testOnly && profile.role!=='parent')
    || (!topic.libraryPublished && profile.role!=='parent' && topicOwnerId(data,topic)!==profile.id)) throw new ApiError(404,'アレンジする問題集が見つかりません。','TOPIC_NOT_FOUND');
  if(data.jobs.some(job=>job.topicId===topicId && ['queued','running'].includes(job.status))) throw new ApiError(409,'問題の作成が終わってからアレンジしてください。','GENERATION_ACTIVE');
  if(data.plans.filter(plan=>plan.ownerId===profile.id).length>=100) throw new ApiError(429,'学習プランは1人100件までです。','PLAN_LIMIT');
  const originals=data.questions.filter(question=>question.topicId===topic.id && question.status!=='archived' && canAccessQuestion(question,profile));
  if(!originals.length) throw new ApiError(409,'問題が保存されてからアレンジしてください。','ARRANGEMENT_EMPTY');
  const originalPlan=topic.libraryPublished ? undefined : data.plans.find(plan=>plan.id===topic.planId);
  const sourceIds=topic.libraryPublished ? [] : [...new Set([...(originalPlan?.sourceIds ?? []),...originals.flatMap(q=>q.sourceIds)])]
    .filter(id=>data.sources.some(source=>source.id===id && source.storagePath && canAccessSource(source,profile))).slice(0,20);
  // Bounded excerpts retain an explicit excerpt label; they are not complete source documents.
  const arrangementExamples:PlanningSample[]=originals.map(question=>({prompt:question.prompt.slice(0,1200),choices:question.choices.map(choice=>choice.slice(0,300)),correctIndex:question.correctIndex,
    explanation:question.explanation.slice(0,1200),learningPoint:question.learningPoint.slice(0,200),sourceIds:question.sourceIds.filter(id=>sourceIds.includes(id)),
    sourceNote:'既存の問題集からの参考抜粋。全文を網羅するものではありません。',needsReview:!!question.needsReview}))
    .filter(example=>planningSampleSchema.safeParse(example).success).slice(0,3);
  if(!arrangementExamples.length) throw new ApiError(409,'アレンジの参考にできる4択問題を確認できませんでした。新しい相談から始めてください。','ARRANGEMENT_EMPTY');
  const latestJob=data.jobs.filter(job=>job.topicId===topic.id && (job.approvedInstructions || job.instructions)).at(-1);
  const latestInstructions=latestJob?.approvedInstructions ?? latestJob?.instructions;
  const createdAt=now.toISOString();
  const plan:LearningPlan={id:requestId,ownerId:profile.id,title:`${topic.title.slice(0,130)}のアレンジ`,subject:topic.subject,
    goal:`「${topic.title}」を別の問題集としてアレンジする。まず実物3問で内容と形式を確認する。`,arrangementInstructions:latestInstructions,
    difficulty:originalPlan?.difficulty ?? '元の問題を参考に相談して調整',dailyQuestionTarget:10,sourceIds,sampleFirst:true,arrangedFromTopicId:topic.id,
    arrangementExamples,testOnly:topic.testOnly || undefined,version:1,createdAt,updatedAt:createdAt};
  return {plan,event:{id:`plan:${requestId}`,type:'plan.created',actorId:profile.id,createdAt,payload:plan}};
}
