import 'server-only';
import type { Profile,Question,StudyData } from '@/lib/types';
import { getFullState,studyDataForProfile } from './google-store';

export function hideQuestionAnswer(question:Question):Question {
  return {id:question.id,topicId:question.topicId,prompt:question.prompt,choices:[...question.choices],
    correctIndex:-1,explanation:'',learningPoint:'',sourceIds:[],sourceNote:'',status:question.status,
    version:question.version,createdAt:question.createdAt,publishedAt:question.publishedAt,needsReview:question.needsReview,audienceUserId:question.audienceUserId,planId:question.planId};
}

export function stateForProfile(data:StudyData,profile:Profile):StudyData {
  return studyDataForProfile(data,profile);
}
export async function loadState(profile:Profile):Promise<StudyData> {
  return stateForProfile((await getFullState()).data,profile);
}
