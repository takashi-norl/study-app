import Link from 'next/link';
import EikenSamples from '@/components/eiken-samples';
import { requireProfile } from '@/server/auth';
import { samplePreview } from '@/server/eiken-samples';
import { ApiError } from '@/server/config';

export const dynamic = 'force-dynamic';
export default async function Page() {
  let preview;
  try { preview = await samplePreview((await requireProfile('parent')).profile); }
  catch (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main style={{ maxWidth: 600, margin: '8vh auto', padding: 24 }}><h1>管理者用の教材サンプル</h1><p>{login ? '管理者のGoogleアカウントでログインすると、問題と音声を確認できます。' : error instanceof ApiError ? error.message : '見本を読み込めませんでした。少し待ってから、もう一度開いてください。'}</p><Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Fadmin%2Feiken-samples' : '/'}>{login ? 'Googleログインへ' : 'ホームへ戻る'}</Link></main>;
  }
  return <EikenSamples {...preview} />;
}
