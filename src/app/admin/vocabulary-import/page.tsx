import Link from 'next/link';
import VocabularyImport from '@/components/vocabulary-import';
import { requireSuperUser } from '@/server/auth';
import { ApiError } from '@/server/config';

export const dynamic = 'force-dynamic';
export default async function Page() {
  try {
    const { profile } = await requireSuperUser();
    return <VocabularyImport receiptScope={`${profile.familyId}:${profile.id}`} />;
  } catch (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main style={{ maxWidth: 600, margin: '8vh auto', padding: 24 }}>
      <h1>作成済み音声の取込</h1>
      <p>{login ? 'Super UserのGoogleアカウントでログインしてください。' : error instanceof ApiError ? error.message : '取込画面を開けませんでした。'}</p>
      <Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Fadmin%2Fvocabulary-import' : '/'}>{login ? 'Googleログインへ' : 'ホームへ戻る'}</Link>
    </main>;
  }
}
