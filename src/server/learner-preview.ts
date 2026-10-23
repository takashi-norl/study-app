import 'server-only';
import type { Profile, Question, StudyData } from '@/lib/types';
import { sharingUnavailable } from './private-self-study';

export interface LearnerPreview {
  data: StudyData;
  profile: Profile;
  practiceQuestions: Question[];
}

export function prepareLearnerPreview(_data: StudyData, _administrator: Profile, _learnerId: string): LearnerPreview {
  return sharingUnavailable();
}
