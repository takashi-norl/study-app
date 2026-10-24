import { FatalError } from 'workflow';
import { getRegisteredAccounts, profileForAccount, assertSuperUser } from '@/server/env';
import { vocabularyPreview, prepareVocabularyAudio } from '@/server/vocabulary-samples';
import { ApiError } from '@/server/config';

function profile(actorId: string) {
  const member = getRegisteredAccounts().find(item => item.id === actorId);
  if (!member) throw new FatalError('音声準備の権限を確認できません。');
  return assertSuperUser(profileForAccount(member));
}
export async function vocabularyBuildInput(actorId: string) {
  'use step';
  try { return (await vocabularyPreview(profile(actorId))).audio.filter(item => item.state === 'missing').map(item => item.wordId); }
  catch { throw new FatalError('音声セットを読み込めませんでした。保存済み音声は残っています。'); }
}
vocabularyBuildInput.maxRetries = 1;

export async function buildVocabularyWord(actorId: string, wordId: string) {
  'use step';
  try { await prepareVocabularyAudio(profile(actorId), wordId, true); return 'ready'; }
  catch (error) {
    if (error instanceof ApiError && ['AUDIO_PENDING', 'SAMPLE_AUDIO_FAILED'].includes(error.code)) return 'reserved';
    if (error instanceof FatalError || error instanceof ApiError && ['AUDIO_LIMIT', 'VOCABULARY_BUILD_BUDGET', 'FORBIDDEN', 'NOT_CONFIGURED', 'VOCABULARY_AUDIO_NOT_CONFIGURED', 'GOOGLE_AUTH_EXPIRED', 'GOOGLE_ACCESS_DENIED'].includes(error.code)) return 'blocked';
    // No paid retry after an uncertain provider response; proceed with the remaining fixed words.
    return 'failed';
  }
}
buildVocabularyWord.maxRetries = 0;
