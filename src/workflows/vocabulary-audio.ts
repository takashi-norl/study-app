import { createHook } from 'workflow';
import { vocabularyBuildInput, buildVocabularyWord } from './vocabulary-audio-steps';

export async function vocabularyAudioWorkflow(actorId: string) {
  'use workflow';
  using ownership = createHook({ token: 'hibi-vocabulary-audio-100-v1' });
  if (await ownership.getConflict()) return;
  const ids = await vocabularyBuildInput(actorId);
  const outcomes: { wordId: string; state: string }[] = [];
  for (const wordId of ids) {
    const state = await buildVocabularyWord(actorId, wordId);
    outcomes.push({ wordId, state });
    if (state === 'blocked') break;
  }
  return outcomes;
}
