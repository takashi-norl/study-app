import Link from 'next/link';
import EikenSamples from '@/components/eiken-samples';
import { requireSuperUser } from '@/server/auth';
import { samplePreview } from '@/server/eiken-samples';
import { ApiError } from '@/server/config';

export const dynamic = 'force-dynamic';
export default async function Page() {
  let preview;
  try { preview = await samplePreview((await requireSuperUser()).profile); }
  catch (error) {
    const login = error instanceof ApiError && error.status === 401;
    return <main style={{ maxWidth: 600, margin: '8vh auto', padding: 24 }}><h1>英語の教材</h1><p>{login ? '運営用アカウントでログインしてください。' : error instanceof ApiError ? error.message : '見本を読み込めませんでした。少し待ってから、もう一度開いてください。'}</p><Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Fadmin%2Feiken-samples' : '/'}>{login ? 'Googleログインへ' : 'ホームへ戻る'}</Link></main>;
  }
  return <EikenSamples {...preview} operations />;
}
