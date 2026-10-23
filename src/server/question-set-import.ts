import 'server-only';
import { createHash } from 'node:crypto';
import type { Profile, Question, StudyData, Topic } from '@/lib/types';
import { questionSetImportSchema } from '@/lib/question-set-import';
import { canAccessSource } from './access';
import { ApiError } from './config';
import { getFamilyId } from './env';
import type { StudyEvent } from './google-store';

function stableId(value:string) {
  const h=createHash('sha256').update(value).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

export function prepareQuestionSetImport(data:StudyData,events:StudyEvent[],profile:Profile,raw:unknown,now=new Date()) {
  if(profile.role!=='parent'||profile.familyId!==getFamilyId()) throw new ApiError(403,'管理者だけが取り込めます。','FORBIDDEN');
  const {bundle}=questionSetImportSchema.parse(raw);
  const plan=bundle.planId ? data.plans.find(p=>p.id===bundle.planId) : undefined;
  if(bundle.planId && (!plan || plan.ownerId!==profile.id || plan.testOnly || plan.subject!==bundle.subject)) throw new ApiError(403,'自分の学習プランを選んでください。','INVALID_PLAN');
  for(const id of new Set(bundle.questions.flatMap(q=>q.sourceIds))) {
    const source=data.sources.find(s=>s.id===id);
    if(!source||source.testOnly||!canAccessSource(source,profile)||plan&&!plan.sourceIds.includes(id)) throw new ApiError(403,'教材の参照先を確認してください。','INVALID_SOURCE');
  }
  const fingerprint=createHash('sha256').update(`${profile.id}:${JSON.stringify(bundle)}`).digest('hex');
  const key=`question-import:${fingerprint}`;
  const questionEventId=`${key}:questions`, topicEventId=`${key}:topic`;
  const previous=events.find(e=>e.id===questionEventId);
  const createdAt=previous?.createdAt ?? now.toISOString();
  const topicId=stableId(key);
  const topic:Topic={id:topicId,ownerId:profile.id,title:bundle.title,subject:bundle.subject,description:bundle.description,
    targetCount:bundle.questions.length,createdAt,...(plan?{planId:plan.id}:{}),
    ...(bundle.questionTemplate?{questionTemplate:bundle.questionTemplate}:{})};
  const questions:Question[]=bundle.questions.map((q,index)=>({...q,id:stableId(`${key}:${index}`),topicId,ownerId:profile.id,
    ...(plan?{planId:plan.id}:{}),status:'approved',needsReview:false,version:1,createdAt}));
  const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,actorId:profile.id,familyId:profile.familyId,createdAt,payload});
  // Commit the private topic after its question snapshot; retry IDs never overwrite later edits.
  const writes=[event(questionEventId,'questions.published',{questions}),event(topicEventId,'topic.created',topic)]
    .filter(e=>!events.some(saved=>saved.id===e.id));
  return {topic,questions,events:writes,alreadyImported:writes.length===0};
}
