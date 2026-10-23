import 'server-only';
import type { Profile, Question, StudyData } from '@/lib/types';
import { asPracticeQuestion } from '@/lib/library-policy';
import { ApiError } from './config';
import { stateForProfile } from './data';
import { getFamilyId } from './env';
import { mayPracticeQuestion } from './practice-access';

export interface LearnerPreview {
  data: StudyData;
  profile: Profile;
  practiceQuestions: Question[];
}

/** Read-only administrator rehearsal; it never creates a learner session or records progress. */
export function prepareLearnerPreview(data: StudyData, administrator: Profile, learnerId: string): LearnerPreview {
  if (administrator.role !== 'parent' || administrator.familyId !== getFamilyId()) {
    throw new ApiError(403, '学習者画面の確認は管理者だけが利用できます。', 'LEARNER_PREVIEW_FORBIDDEN');
  }
  // getFullState supplies profiles from the current registered family members, not the request.
  const learner = data.profiles.find(profile => profile.id === learnerId && profile.role === 'student'
    && profile.familyId === administrator.familyId);
  if (!learner) throw new ApiError(404, '表示を確認する学習者が見つかりません。', 'LEARNER_NOT_FOUND');
  const learnerData = stateForProfile(data, learner);
  const visibleQuestionIds = new Set(learnerData.questions.map(question => question.id));

  return structuredClone({
    data: learnerData,
    profile: learner,
    // Answers are available only in this administrator-only payload for a local rehearsal.
    practiceQuestions: data.questions.filter(question => visibleQuestionIds.has(question.id)
      && mayPracticeQuestion(data, learner, question)).map(asPracticeQuestion),
  });
}
