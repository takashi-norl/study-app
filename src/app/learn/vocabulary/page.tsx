import Link from 'next/link';
import { glossaryEntries } from '@/server/vocabulary-glossary-catalog';
import VocabularyLibraryPreview from '@/components/vocabulary-library-preview';
import { requireProfile } from '@/server/auth';
import { vocabularyPreview } from '@/server/vocabulary-samples';
import { ApiError } from '@/server/config';

export const dynamic = 'force-dynamic';
export default async function Page() {
  let preview;
  try {
    const { profile } = await requireProfile();
    preview = await vocabularyPreview(profile);
  }
  catch (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main style={{ maxWidth: 600, margin: '8vh auto', padding: 24 }}><h1>英単語を学ぶ</h1><p>{login ? 'Googleアカウントでログインすると、単語・例文・音声を確認できます。' : error instanceof ApiError ? error.message : '教材を読み込めませんでした。少し待ってから、もう一度開いてください。'}</p><Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Flearn%2Fvocabulary' : '/'}>{login ? 'Googleログインへ' : 'ホームへ戻る'}</Link></main>;
  }
  return <VocabularyLibraryPreview initial={preview} batches={preview.batches} glossary={glossaryEntries} />;
}
