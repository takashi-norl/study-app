import Link from 'next/link';
import { glossaryEntries } from '@/server/vocabulary-glossary-catalog';
import VocabularyMarathon from '@/components/vocabulary-marathon';
import { requireProfile } from '@/server/auth';
import { vocabularyPreview } from '@/server/vocabulary-samples';
import { ApiError } from '@/server/config';
import VocabularyAudioBuild from '@/components/vocabulary-audio-build';

export const dynamic = 'force-dynamic';
export default async function Page() {
  let preview;
  let canBuild = false;
  try {
    const { profile } = await requireProfile('parent');
    canBuild = profile.accessLevel === 'superuser';
    preview = await vocabularyPreview(profile);
  }
  catch (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main style={{ maxWidth: 600, margin: '8vh auto', padding: 24 }}><h1>ボキャブラリーマラソンの見本</h1><p>{login ? '管理者のGoogleアカウントでログインすると、単語・例文・音声を確認できます。' : error instanceof ApiError ? error.message : '見本を読み込めませんでした。少し待ってから、もう一度開いてください。'}</p><Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Fadmin%2Fvocabulary-samples' : '/'}>{login ? 'Googleログインへ' : 'ホームへ戻る'}</Link></main>;
  }
  const initial = { total: preview.audio.length, ready: preview.audio.filter(item => item.state === 'ready').length,
    failed: preview.audio.filter(item => item.state === 'failed').length, pending: preview.audio.filter(item => item.state === 'pending').length,
    missing: preview.audio.filter(item => item.state === 'missing').length, running: false };
  return <VocabularyMarathon {...preview} glossary={glossaryEntries} preparation={<VocabularyAudioBuild canBuild={canBuild} initial={initial} />} />;
}
