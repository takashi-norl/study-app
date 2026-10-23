'use client';

import { useRef, useState } from 'react';
import type { StudyController } from '@/components/controller';
import {
  advancePreviewQuestion, answerPreviewQuestion, createPreviewPractice, finishPreviewPractice,
  previewCurrentQuestion, previewQuestionKey, startPreviewPractice,
  type LearnerPreviewPayload, type PreviewPracticeState,
} from './learner-preview';

export function useLearnerPreview(payload: LearnerPreviewPayload, demo: boolean, refresh: () => void): StudyController {
  const [state, setState] = useState(() => createPreviewPractice(payload));
  const current = useRef(state);
  const [practiceStart, setPracticeStart] = useState<StudyController['practiceStart']>(null);
  const pendingPractice = useRef<StudyController['practiceStart']>(null);
  const [answerConfirmation, setAnswerConfirmation] = useState(false);
  function updatePracticeStart(next: StudyController['practiceStart']) { pendingPractice.current = next; setPracticeStart(next); }
  const expectedKey = previewQuestionKey(state);
  function change(update: (previous: PreviewPracticeState) => PreviewPracticeState) {
    // Update the ref synchronously: repeated clicks before React renders cannot answer or skip twice.
    const next = update(current.current);
    current.current = next;
    setState(next);
  }
  function unavailable() {
    change(previous => ({ ...previous, error: '表示の確認中です。問題の作成・変更・公開や学習への追加は、プレビューを終了して行ってください。' }));
  }
  async function unavailableAsync(): Promise<void> { unavailable(); }
  async function unavailableBoolean(): Promise<boolean> { unavailable(); return false; }
  return {
    data: state.data, profile: state.profile, preview: true, demo, ready: true, authStatus: 'authenticated', authError: null, busy: false,
    error: state.error, notice: null, uploadStatus: null,
    sync: { checking: false, lastSyncedAt: null, error: null }, practiceStart, answerConfirmation, session: state.session,
    currentQuestion: previewCurrentQuestion(state), feedback: state.feedback,
    actions: {
      retryAuth: unavailableAsync, refreshStatus: async () => refresh(), switchRole: unavailable,
      startPractice: (mode, topicId) => {
        if (current.current.session && !current.current.session.completedAt) return;
        change(previous => ({ ...previous, error: null }));
        updatePracticeStart({ mode, topicId });
      },
      beginPractice: requireConfirmation => {
        const request = pendingPractice.current;
        if (!request) return;
        updatePracticeStart(null); setAnswerConfirmation(requireConfirmation);
        change(previous => startPreviewPractice(previous, request.mode, request.topicId));
      },
      cancelPracticeStart: () => updatePracticeStart(null),
      answer: index => {
        const previous = current.current;
        change(state => answerPreviewQuestion(state, index, expectedKey));
        return current.current !== previous;
      },
      nextQuestion: () => change(previous => advancePreviewQuestion(previous, expectedKey)),
      finishSession: () => { updatePracticeStart(null); change(finishPreviewPractice); },
      createTopic: unavailableAsync, uploadSources: unavailableAsync, createPlan: unavailableAsync,
      updatePlanTags: unavailableBoolean,
      sendPlanningMessage: unavailableBoolean, resumePlanningTurn: unavailableAsync,
      generateProposal: unavailableAsync, arrangeTopic: unavailableAsync, publishLibrary: unavailableAsync,
      requestLibraryPublication: unavailableBoolean, addLibraryPlan: unavailableAsync, deliverToLearner: unavailableAsync,
      generate: unavailable, resumeGeneration: unavailable, retryGeneration: unavailableAsync,
      updateQuestion: unavailable, publish: unavailable, resetDemo: unavailable,
      signIn: unavailableAsync, signOut: unavailable, requestNotifications: unavailable, exportData: unavailable,
    },
  };
}
