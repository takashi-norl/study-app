import Link from 'next/link';
import { requireProfile } from '@/server/auth';
import { ApiError } from '@/server/config';
import QuestionSetImport from '@/components/question-set-import';

export const dynamic='force-dynamic';
export default async function Page() {
  try { await requireProfile('parent'); }
  catch(error) {
    const login=error instanceof ApiError&&error.status===401;
    return <main style={{maxWidth:600,margin:'8vh auto',padding:24}}><h1>確認した問題セットを取り込む</h1><p>{login?'管理者のGoogleアカウントでログインしてください。':'管理者だけが使える画面です。'}</p><Link className="button primary" href={login?'/api/auth/signin?callbackUrl=%2Fadmin%2Fquestion-set-import':'/'}>{login?'Googleログインへ':'ホームへ戻る'}</Link></main>;
  }
  return <QuestionSetImport/>;
}
