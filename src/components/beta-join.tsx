'use client';
import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import styles from './beta-access.module.css';
import { LoginButtons } from './login-buttons';
import type { LoginProvider } from '@/lib/login-provider';

export default function BetaJoin({ token, loginError }: { token?: string; loginError?: string }) {
  const [pending, setPending] = useState<LoginProvider | null>(null), [error, setError] = useState(loginError === 'AppleAccessDenied'
    ? 'Appleで利用するには、Appleから共有されるメールアドレス宛ての招待が必要です。「メールを非公開」の場合は、非公開メールアドレスで招待を受けてください。すでにGoogleで登録済みの方は、Googleでログインしてください。'
    : loginError ? 'ログインできませんでした。最初に登録した方法・招待先のメールアドレス・リンクの有効期限を確認し、招待リンクからもう一度お試しください。' : '');
  useEffect(() => {
    // Remove the invitation from subsequent navigation URLs and copied browser addresses.
    if (token) window.history.replaceState(null, '', '/join');
  }, [token]);
  async function join(provider: LoginProvider) {
    if (pending) return;
    setPending(provider); setError('');
    try {
      if (token) {
        const response = await fetch('/api/beta/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, provider }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '招待を確認できませんでした。');
      }
      await signIn(provider, { callbackUrl: '/' }, provider === 'google' ? { prompt: 'select_account' } : undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ログイン画面を開けませんでした。'); }
    finally { setPending(null); }
  }
  return <main className={styles.page}>
    <a className={styles.back} href="/">ひび学習へ</a>
    <section className={styles.panel}>
      <h1>{token ? 'ひび学習への招待' : '招待したアカウントでログイン'}</h1>
      <p className={styles.intro}>自分の写真やPDFから問題を作り、自分のペースで学べます。教材・問題・学習記録が、友達に共有されることはありません。</p>
      <p className={styles.note}>招待されたメールアドレスのアカウントを選んでください。初めて使う場合は、受け取った招待リンクから進んでください。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <LoginButtons onSignIn={provider => void join(provider)} pending={pending} />
      <p className={styles.note}>テスト利用中です。自動で料金が請求されることはありません。AIで作れる量には上限があります。</p>
    </section>
  </main>;
}
