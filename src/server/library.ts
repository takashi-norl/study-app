import 'server-only';
import { createHash } from 'node:crypto';
import type { LearningPlan,Profile,Question,StudyData,Topic } from '@/lib/types';
import { ApiError } from './config';
import type { StudyEvent } from './google-store';
import { sharingUnavailable } from './private-self-study';

const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function libraryRevision(topic:Topic, questions:Question[]):string {
  return hash([topic.id,topic.title,topic.subject,topic.description,questions.filter(question=>question.topicId===topic.id && question.status!=='archived').sort((a,b)=>a.id.localeCompare(b.id)).map(question=>[question.id,question.version])]);
}


export function prepareLibraryPublicationRequest(_data:StudyData,_profile:Profile,_topicId:string,_now=new Date()):{topic:Topic;request:NonNullable<Topic['publicationRequest']>;event?:StudyEvent} {
  return sharingUnavailable();
}
export function prepareLibraryPublication(_data:StudyData,_profile:Profile,_topicId:string,_now=new Date()):{topic:Topic;events:StudyEvent[];publishedCount:number} {
  return sharingUnavailable();
}
export function prepareLibraryAdoption(_data:StudyData,_profile:Profile,_topicId:string,_now=new Date()):{plan:LearningPlan;event?:StudyEvent} {
  return sharingUnavailable();
}
export function assertOrdinaryPublication(_question:Question,_topic?:Topic):void {
  sharingUnavailable();
}
export function assertQuestionEditable(topic?:Topic):void {
  if(topic?.libraryPublished) throw new ApiError(409,'公開教材は変更できません。','LIBRARY_READ_ONLY');
}
