import 'server-only';
import { createHash } from 'node:crypto';
import type { LearningPlan,Profile,Question,StudyData,Topic } from '@/lib/types';
import { ApiError } from './config';
import type { StudyEvent } from './google-store';
import { canAccessQuestion } from './access';
import { getFamilyId } from './env';

const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
function stableId(input:unknown):string {
  const hex=hash(input);return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

/** Publication is an explicit sanitized copy. The original test set and its private sources are untouched. */
export function prepareLibraryPublication(data:StudyData,profile:Profile,topicId:string,now=new Date()):{topic:Topic;events:StudyEvent[];publishedCount:number} {
  if(profile.role!=='parent' || profile.familyId!==getFamilyId()) throw new ApiError(403,'公開は管理者だけが行えます。','LIBRARY_PUBLISH_FORBIDDEN');
  const source=data.topics.find(topic=>topic.id===topicId && !topic.libraryPublished);
  if(!source || !canAccessQuestion(source,profile)) throw new ApiError(404,'公開する問題集が見つかりません。','TOPIC_NOT_FOUND');
  if(source.planId && !data.plans.some(plan=>plan.id===source.planId && data.profiles.some(member=>member.id===plan.ownerId && member.role==='parent'))) throw new ApiError(403,'管理者が作った問題集を選んでください。','LIBRARY_ADMIN_SET_ONLY');
  if(data.jobs.some(job=>job.topicId===topicId && (job.status==='queued' || job.status==='running'))) throw new ApiError(409,'作問が終わってから公開してください。','GENERATION_ACTIVE');
  const original=data.questions.filter(question=>question.topicId===topicId && question.status!=='archived').sort((a,b)=>a.id.localeCompare(b.id));
  if(!original.length || original.length>300 || original.some(question=>!['approved','published'].includes(question.status) || question.needsReview)) {
    throw new ApiError(409,'問題の内容を確認してからライブラリに公開してください。','REVIEW_REQUIRED');
  }
  const revision=hash([topicId,source.title,source.subject,source.description,original.map(question=>[question.id,question.version])]);
  const id=stableId(['library',revision]);const createdAt=now.toISOString();
  const topic:Topic={id,title:source.title,subject:source.subject,description:source.description,createdAt,targetCount:original.length,libraryPublished:true,librarySourceTopicId:topicId};
  const questions:Question[]=original.map(question=>({id:stableId(['library-question',revision,question.id]),topicId:id,
    prompt:question.prompt,choices:[...question.choices],correctIndex:question.correctIndex,explanation:question.explanation,learningPoint:question.learningPoint,
    sourceIds:[],sourceNote:'ライブラリの学習問題',status:'published',needsReview:false,version:1,createdAt,publishedAt:createdAt}));
  const events:StudyEvent[]=[];let batch:Question[]=[];
  const flush=()=>{if(batch.length) events.push({id:`library-questions:${id}:${events.length}`,type:'library.questions',actorId:profile.id,createdAt,payload:{topicId:id,questions:batch}});batch=[];};
  for(const question of questions) {if(batch.length && JSON.stringify([...batch,question]).length>230000) flush();batch.push(question);}
  flush();
  events.push({id:`library-publish:${revision}`,type:'library.published',actorId:profile.id,createdAt,payload:{sourceTopicId:topicId,topic,questionIds:questions.map(question=>question.id)}});
  return {topic,events,publishedCount:questions.length};
}

export function prepareLibraryAdoption(data:StudyData,profile:Profile,topicId:string,now=new Date()):{plan:LearningPlan;event?:StudyEvent} {
  if(profile.role!=='student' || profile.familyId!==getFamilyId()) throw new ApiError(403,'自分の学習への追加は学習者のアカウントで行ってください。','LIBRARY_ADOPT_STUDENT_ONLY');
  const topic=data.topics.find(topic=>topic.id===topicId && topic.libraryPublished && !topic.testOnly && canAccessQuestion(topic,profile));
  if(!topic) throw new ApiError(404,'ライブラリの問題集が見つかりません。','LIBRARY_NOT_FOUND');
  const previous=data.plans.find(plan=>plan.ownerId===profile.id && !plan.testOnly && plan.libraryTopicId===topicId);
  if(previous) return {plan:previous};
  if(data.plans.filter(plan=>plan.ownerId===profile.id).length>=100) throw new ApiError(429,'学習プランは1人100件までです。','PLAN_LIMIT');
  const createdAt=now.toISOString();
  const plan:LearningPlan={id:stableId(['library-adoption',profile.id,topicId]),ownerId:profile.id,title:topic.title,subject:topic.subject,
    goal:`「${topic.title}」を1回10問ずつ練習し、間違えた内容を日を空けて復習する。`,difficulty:'学習記録に合わせて調整',dailyQuestionTarget:10,
    sourceIds:[],version:1,createdAt,updatedAt:createdAt,libraryTopicId:topicId};
  return {plan,event:{id:`library-adopt:${hash([profile.id,topicId])}`,type:'library.adopted',actorId:profile.id,createdAt,payload:plan}};
}

export function assertOrdinaryPublication(question:Question,topic?:Topic):void {
  assertQuestionEditable(topic);
  if(question.testOnly || topic?.testOnly) throw new ApiError(403,'テスト用の問題は「ライブラリに公開」からコピーして公開してください。','TEST_PUBLISH_FORBIDDEN');
}

export function assertQuestionEditable(topic?:Topic):void {
  if(topic?.libraryPublished) throw new ApiError(409,'公開版は元の問題を修正して、新しい版として公開してください。','LIBRARY_READ_ONLY');
}
