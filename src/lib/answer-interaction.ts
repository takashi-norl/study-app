/** One question's local input state. A failed save retains the submitted choice for a safe retry. */
export interface AnswerInteraction {
  requireConfirmation: boolean;
  selected: number | null;
  phase: 'choosing' | 'submitting' | 'answered' | 'failed';
}
export function createAnswerInteraction(requireConfirmation = false): AnswerInteraction {
  return { requireConfirmation, selected: null, phase: 'choosing' };
}
export function chooseAnswer(state: AnswerInteraction, index: number, choiceCount: number): AnswerInteraction {
  if (state.phase !== 'choosing' || !Number.isInteger(index) || index < 0 || index >= choiceCount) return state;
  return { ...state, selected: index, phase: state.requireConfirmation ? 'choosing' : 'submitting' };
}
export function submitAnswer(state: AnswerInteraction): AnswerInteraction {
  if (state.selected === null || state.phase !== 'choosing' && state.phase !== 'failed') return state;
  return { ...state, phase: 'submitting' };
}
export function settleAnswer(state: AnswerInteraction, saved: boolean): AnswerInteraction {
  return state.phase === 'submitting' ? { ...state, phase: saved ? 'answered' : 'failed' } : state;
}
