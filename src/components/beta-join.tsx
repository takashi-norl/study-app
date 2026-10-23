'use client';
import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import styles from './beta-access.module.css';

export default function BetaJoin({ token, loginError }: { token?: string; loginError?: boolean }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(loginError ? 'ログインできませんでした。招待されたGoogleアカウントと、リンクの有効期限を確認してください。' : '');
  useEffect(() => {
    // Remove the invitation from subsequent navigation URLs and copied browser addresses.
    if (token) window.history.replaceState(null, '', '/join');
  }, [token]);
  async function join() {
    setPending(true); setError('');
    try {
      if (token) {
        const response = await fetch('/api/beta/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '招待を確認できませんでした。');
      }
      await signIn('google', { callbackUrl: '/' }, { prompt: 'select_account' });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ログイン画面を開けませんでした。'); }
    finally { setPending(false); }
  }
  return <main className={styles.page}>
    <a className={styles.back} href="/">ひび学習へ</a>
    <section className={styles.panel}>
      <h1>{token ? 'ひび学習への招待' : '招待したアカウントでログイン'}</h1>
      <p className={styles.intro}>自分の写真やPDFから問題を作り、自分のペースで学べます。教材・問題・学習記録が、友達に共有されることはありません。</p>
      <p className={styles.note}>招待されたGoogleアカウントを選んでください。初めて使う場合は、受け取った招待リンクから進んでください。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}><button className="button primary" onClick={() => void join()} disabled={pending}>{pending ? '招待を確認しています…' : 'Googleで続ける'}</button></div>
      <p className={styles.note}>テスト利用中です。自動で料金が請求されることはありません。AIで作れる量には上限があります。</p>
    </section>
  </main>;
}
