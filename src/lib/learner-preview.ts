import { selectQuestions } from './learning';
import type { PracticeMode, PracticeSession, Profile, Question, StudyData } from './types';

export interface LearnerPreviewPayload {
  data: StudyData;
  profile: Profile;
  practiceQuestions: Question[];
}

export interface PreviewPracticeState {
  data: StudyData;
  profile: Profile;
  practiceQuestions: Question[];
  session: PracticeSession | null;
  sessionQuestions: Question[];
  index: number;
  feedback: { correct: boolean; correctIndex: number; explanation: string } | null;
  error: string | null;
}

/** All changes below are immutable and live only in the preview component. */
export function createPreviewPractice(payload: LearnerPreviewPayload): PreviewPracticeState {
  const visible = new Map(payload.data.questions.map(question => [question.id, question]));
  return {
    data: payload.data, profile: payload.profile,
    practiceQuestions: payload.practiceQuestions.filter(question => {
      const scoped = visible.get(question.id);
      return scoped?.topicId === question.topicId && scoped.version === question.version
        && !question.testOnly && question.status !== 'archived';
    }),
    session: null, sessionQuestions: [], index: 0, feedback: null, error: null,
  };
}

function current(state: PreviewPracticeState): Question | null {
  return state.session && !state.session.completedAt ? state.sessionQuestions[state.index] ?? null : null;
}

export function previewQuestionKey(state: PreviewPracticeState): string | null {
  const question = current(state);
  return question && state.session ? `${state.session.id}:${question.id}` : null;
}

export function previewCurrentQuestion(state: PreviewPracticeState): Question | null {
  const question = current(state);
  if (!question) return null;
  return { ...question, sourceIds: [], sourceNote: '',
    correctIndex: state.feedback ? question.correctIndex : -1,
    explanation: state.feedback ? question.explanation : '',
    learningPoint: state.feedback ? question.learningPoint : '',
  };
}

export function startPreviewPractice(
  state: PreviewPracticeState, mode: PracticeMode, topicId?: string,
  now = new Date(), createId = () => crypto.randomUUID(),
): PreviewPracticeState {
  if (state.session && !state.session.completedAt) return state;
  const selected = selectQuestions(state.practiceQuestions, state.data.attempts, state.data.exposures,
    state.profile.id, mode, now, 10, topicId);
  if (!selected.length) return { ...state, session: null, sessionQuestions: [], index: 0, feedback: null,
    error: mode === 'weak' ? 'このユーザーには、復習できる間違えた問題がまだありません。' : '今出題できる問題がありません。今日正解した問題は、日を空けて復習に出ます。' };
  const timestamp = now.toISOString();
  const session: PracticeSession = { id: `preview-${createId()}`, userId: state.profile.id, mode,
    questionIds: selected.map(question => question.id), createdAt: timestamp };
  const first = selected[0];
  return { ...state, session, sessionQuestions: selected, index: 0, feedback: null, error: null,
    data: { ...state.data, sessions: [...state.data.sessions, session], exposures: [...state.data.exposures,
      { id: `preview-${createId()}`, userId: state.profile.id, sessionId: session.id,
        questionId: first.id, questionVersion: first.version, shownAt: timestamp }] },
  };
}

export function answerPreviewQuestion(
  state: PreviewPracticeState, selectedIndex: number, expectedKey: string | null,
  now = new Date(), createId = () => crypto.randomUUID(),
): PreviewPracticeState {
  const question = current(state);
  if (!question || !state.session || state.feedback || !expectedKey || expectedKey !== previewQuestionKey(state)
    || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= question.choices.length) return state;
  const correct = selectedIndex === question.correctIndex;
  return { ...state, error: null,
    feedback: { correct, correctIndex: question.correctIndex, explanation: question.explanation },
    data: { ...state.data, attempts: [...state.data.attempts,
      { id: `preview-${createId()}`, userId: state.profile.id, sessionId: state.session.id,
        questionId: question.id, questionVersion: question.version, selectedIndex, correct, answeredAt: now.toISOString() }] },
  };
}

export function advancePreviewQuestion(
  state: PreviewPracticeState, expectedKey: string | null,
  now = new Date(), createId = () => crypto.randomUUID(),
): PreviewPracticeState {
  if (!state.session || !state.feedback || !expectedKey || expectedKey !== previewQuestionKey(state)) return state;
  const index = state.index + 1;
  const next = state.sessionQuestions[index];
  if (!next) {
    const session = { ...state.session, completedAt: now.toISOString() };
    return { ...state, session, index, feedback: null,
      data: { ...state.data, sessions: state.data.sessions.map(item => item.id === session.id ? session : item) } };
  }
  return { ...state, index, feedback: null,
    data: { ...state.data, exposures: [...state.data.exposures,
      { id: `preview-${createId()}`, userId: state.profile.id, sessionId: state.session.id,
        questionId: next.id, questionVersion: next.version, shownAt: now.toISOString() }] },
  };
}

export function finishPreviewPractice(state: PreviewPracticeState): PreviewPracticeState {
  return { ...state, session: null, sessionQuestions: [], index: 0, feedback: null, error: null };
}
