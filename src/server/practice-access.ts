import 'server-only';
import type { Profile,Question,StudyData } from '@/lib/types';
import { ApiError } from './config';
import { canAccessQuestion } from './access';
import { getSessionSnapshot,type StudyEvent } from './google-store';

export function mayPracticeQuestion(data:StudyData,profile:Profile,question:Question):boolean {
  const topic=data.topics.find(item=>item.id===question.topicId);
  if(!topic || !canAccessQuestion(topic,profile) || !canAccessQuestion(question,profile)) return false;
  if(profile.role==='parent') return !!topic.testOnly && !!question.testOnly;
  return !topic.libraryPublished || data.plans.some(plan=>plan.ownerId===profile.id && !plan.testOnly && plan.libraryTopicId===topic.id);
}

export function assertPracticeTopic(data:StudyData,profile:Profile,topicId?:string):void {
  const topic=data.topics.find(item=>item.id===topicId);
  if(profile.role==='parent' && (!topic || !topic.testOnly)) throw new ApiError(403,'管理者はテスト用の問題集を指定して試してください。','TEST_PRACTICE_ONLY');
  if(topicId && (!topic || !canAccessQuestion(topic,profile))) throw new ApiError(404,'問題集が見つかりません。','TOPIC_NOT_FOUND');
  if(profile.role==='student' && topic?.libraryPublished && !data.plans.some(plan=>plan.ownerId===profile.id && !plan.testOnly && plan.libraryTopicId===topic.id)) {
    throw new ApiError(403,'先にライブラリから自分の学習に追加してください。','LIBRARY_NOT_ADOPTED');
  }
}

export function mayResumePracticeQuestions(data:StudyData,profile:Profile,questions:Question[]):boolean {
  return questions.every(question=>mayPracticeQuestion(data,profile,question)
    && (profile.role!=='parent' || data.questions.some(current=>current.id===question.id && current.version===question.version && current.status==='published')));
}

export async function authorizedPracticeSession(data:StudyData,events:StudyEvent[],profile:Profile,sessionId:string) {
  const session=data.sessions.find(item=>item.id===sessionId && item.userId===profile.id);
  const questions=session ? await getSessionSnapshot(session.id,events) : [];
  if(!session || !questions.length || questions.length!==session.questionIds.length || questions.some(question=>!mayPracticeQuestion(data,profile,question))) {
    throw new ApiError(403,'この学習セットにはアクセスできません。','SESSION_ACCESS_DENIED');
  }
  return {session,questions};
}
