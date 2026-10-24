import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { AdminConsole } from '@/components/admin-console';
import { requireSuperUser } from '@/server/auth';
import { ApiError } from '@/server/config';
import { getRegisteredAccounts } from '@/server/env';
import { getAppEnvironment } from '@/server/environment';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function OperationsPage() {
  let profile;
  try { ({ profile } = await requireSuperUser()); }
  catch (error) {
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) throw error;
    const login = error.status === 401;
    return <main className={styles.gate}><section className={styles.gateCard}><span className={styles.brandMark}><ShieldCheck size={26} aria-hidden="true"/></span><p className={styles.eyebrow}>ひび学習 · 運営Web</p><h1>Admin Console</h1><p>{login ? '運営用アカウントでログインしてください。' : 'この画面は運営者だけが利用できます。自分の学習はアプリから続けられます。'}</p><Link className={styles.primaryLink} href={login ? '/api/auth/signin?callbackUrl=%2Fadmin' : '/'}>{login ? 'Googleでログイン' : '学習アプリへ戻る'}</Link>{login && <Link className={styles.gateBack} href="/"><ArrowLeft size={16} aria-hidden="true"/>学習アプリへ戻る</Link>}</section></main>;
  }
  // Only the current, already-authorized operator's account is passed to the page UI.
  const operatorEmail = getRegisteredAccounts().find(member => member.id === profile.id)?.email;
  return <AdminConsole profile={profile} operatorEmail={operatorEmail} environment={getAppEnvironment()}/>;
}
