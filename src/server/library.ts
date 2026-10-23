import 'server-only';
import { createHash } from 'node:crypto';
import type { LearningPlan,Profile,Question,StudyData,Topic } from '@/lib/types';
import { ApiError } from './config';
import type { StudyEvent } from './google-store';
import { canAccessQuestion } from './access';
import { getFamilyId } from './env';
import { topicOwnerId } from '@/lib/library-policy';

const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
function stableId(input:unknown):string {
  const hex=hash(input);return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export function libraryRevision(topic:Topic, questions:Question[]):string {
  return hash([topic.id,topic.title,topic.subject,topic.description,questions.filter(question=>question.topicId===topic.id && question.status!=='archived').sort((a,b)=>a.id.localeCompare(b.id)).map(question=>[question.id,question.version])]);
}

export function prepareLibraryPublicationRequest(data:StudyData,profile:Profile,topicId:string,now=new Date()):{topic:Topic;request:NonNullable<Topic['publicationRequest']>;event?:StudyEvent} {
  const topic=data.topics.find(item=>item.id===topicId && !item.libraryPublished && !item.testOnly);
  if(profile.familyId!==getFamilyId() || !topic || topicOwnerId(data,topic)!==profile.id) throw new ApiError(403,'自分の非公開の問題集から公開を依頼してください。','LIBRARY_REQUEST_FORBIDDEN');
  if(data.jobs.some(job=>job.topicId===topicId && ['queued','running'].includes(job.status))) throw new ApiError(409,'作問が終わってから公開を依頼してください。','GENERATION_ACTIVE');
  if(!data.questions.some(question=>question.topicId===topic.id && question.status!=='archived')) throw new ApiError(409,'問題が保存されてから公開を依頼してください。','LIBRARY_EMPTY');
  const revision=libraryRevision(topic,data.questions);
  if(topic.publicationRequest?.revision===revision) return {topic,request:topic.publicationRequest};
  const request={requestedBy:profile.id,requestedAt:now.toISOString(),revision,sequence:(topic.publicationRequest?.sequence ?? 0)+1};
  return {topic:{...topic,publicationRequest:request},request,event:{id:`library-request:${hash([topic.id,profile.id,request.sequence])}`,type:'library.publication-requested',actorId:profile.id,createdAt:request.requestedAt,payload:{sourceTopicId:topic.id,...request}}};
}

/** Publication is an explicit sanitized copy. The original test set and its private sources are untouched. */
export function prepareLibraryPublication(data:StudyData,profile:Profile,topicId:string,now=new Date()):{topic:Topic;events:StudyEvent[];publishedCount:number} {
  if(profile.role!=='parent' || profile.familyId!==getFamilyId()) throw new ApiError(403,'公開は管理者だけが行えます。','LIBRARY_PUBLISH_FORBIDDEN');
  const source=data.topics.find(topic=>topic.id===topicId && !topic.libraryPublished);
  if(!source || !canAccessQuestion(source,profile)) throw new ApiError(404,'公開する問題集が見つかりません。','TOPIC_NOT_FOUND');
  const ownerId=topicOwnerId(data,source);
  const owner=data.profiles.find(member=>member.id===ownerId && member.familyId===profile.familyId);
  if(!owner || (owner.role==='student' && (source.testOnly || source.publicationRequest?.requestedBy!==ownerId || source.publicationRequest?.revision!==libraryRevision(source,data.questions)))) throw new ApiError(403,'学習者の問題集は、本人の公開依頼後に公開できます。','LIBRARY_REQUEST_REQUIRED');
  if(data.jobs.some(job=>job.topicId===topicId && (job.status==='queued' || job.status==='running'))) throw new ApiError(409,'作問が終わってから公開してください。','GENERATION_ACTIVE');
  const original=data.questions.filter(question=>question.topicId===topicId && question.status!=='archived').sort((a,b)=>a.id.localeCompare(b.id));
  if(!original.length || original.length>300) throw new ApiError(409,'保存済みの問題が1〜300問ある問題集を選んでください。','LIBRARY_EMPTY');
  const revision=libraryRevision(source,original);
  const id=stableId(['library',revision]);const createdAt=now.toISOString();
  const topic:Topic={id,title:source.title,subject:source.subject,questionTemplate:source.questionTemplate,description:source.description,createdAt,targetCount:original.length,libraryPublished:true,librarySourceTopicId:topicId,libraryRevision:revision};
  const questions:Question[]=original.map(question=>({id:stableId(['library-question',revision,question.id]),topicId:id,
    prompt:question.prompt,choices:[...question.choices],correctIndex:question.correctIndex,explanation:question.explanation,learningPoint:question.learningPoint,
    sourceIds:[],sourceNote:question.aiGenerated ? 'AIが作成した学習問題です。気になる点は管理者へお知らせください。' : 'ライブラリの学習問題',status:'published',needsReview:question.needsReview,aiGenerated:question.aiGenerated,version:1,createdAt,publishedAt:createdAt}));
  const events:StudyEvent[]=[];let batch:Question[]=[];
  const flush=()=>{if(batch.length) events.push({id:`library-questions:${id}:${events.length}`,type:'library.questions',actorId:profile.id,createdAt,payload:{topicId:id,questions:batch}});batch=[];};
  for(const question of questions) {if(batch.length && JSON.stringify([...batch,question]).length>230000) flush();batch.push(question);}
  flush();
  events.push({id:`library-publish:${revision}`,type:'library.published',actorId:profile.id,createdAt,payload:{sourceTopicId:topicId,topic,questionIds:questions.map(question=>question.id)}});
  return {topic,events,publishedCount:questions.length};
}

export function prepareLibraryAdoption(data:StudyData,profile:Profile,topicId:string,now=new Date()):{plan:LearningPlan;event?:StudyEvent} {
  if(profile.familyId!==getFamilyId()) throw new ApiError(403,'ご家族のアカウントで追加してください。','LIBRARY_ADOPT_FORBIDDEN');
  const topic=data.topics.find(topic=>topic.id===topicId && topic.libraryPublished && !topic.testOnly && canAccessQuestion(topic,profile));
  if(!topic) throw new ApiError(404,'ライブラリの問題集が見つかりません。','LIBRARY_NOT_FOUND');
  const previous=data.plans.find(plan=>plan.ownerId===profile.id && !plan.testOnly && plan.libraryTopicId===topicId);
  if(previous) return {plan:previous};
  if(data.plans.filter(plan=>plan.ownerId===profile.id).length>=100) throw new ApiError(429,'学習プランは1人100件までです。','PLAN_LIMIT');
  const createdAt=now.toISOString();
  const plan:LearningPlan={id:stableId(['library-adoption',profile.id,topicId]),ownerId:profile.id,title:topic.title,subject:topic.subject,questionTemplate:topic.questionTemplate,
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
