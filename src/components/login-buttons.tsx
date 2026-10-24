'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { appleLoginAvailable, type LoginProvider } from '@/lib/login-provider';
import styles from './login-buttons.module.css';

export function LoginButtons({ onSignIn, pending, disabled = false }: {
  onSignIn: (provider: LoginProvider) => void; pending: LoginProvider | null; disabled?: boolean;
}) {
  const [apple, setApple] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/providers', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(providers => { if (!controller.signal.aborted) setApple(appleLoginAvailable(providers)); })
      .catch(() => { /* Keep the existing Google entry point when provider discovery is unavailable. */ });
    return () => controller.abort();
  }, []);
  return <div className={styles.wrap}>
    <div className={styles.buttons} aria-label="ログイン方法">
      <button type="button" className="button primary full" disabled={disabled || !!pending} onClick={() => onSignIn('google')}>
        {pending === 'google' ? <LoaderCircle className="spin" size={18} /> : <GoogleMark />}
        {pending === 'google' ? 'Googleを開いています…' : 'Googleでログイン'}<ArrowRight size={17} />
      </button>
      {apple && <button type="button" className={`button full ${styles.apple}`} disabled={disabled || !!pending} onClick={() => onSignIn('apple')}>
        {pending === 'apple' ? <LoaderCircle className="spin" size={18} /> : <AppleMark />}
        {pending === 'apple' ? 'Appleを開いています…' : 'Appleでログイン'}<ArrowRight size={17} />
      </button>}
    </div>
    {apple && <p className={styles.note}>最初に登録した方法でログインしてください。GoogleとAppleのアカウント連携は、まだ利用できません。</p>}
    {apple && <details className={styles.help}><summary>Appleの「メールを非公開」について</summary><p>招待されたメールアドレスと、Appleから共有されるメールアドレスが一致する必要があります。「メールを非公開」を使う場合は、その非公開メールアドレスで招待を受けてください。または、Appleで「メールを共有」を選び、招待先と同じアドレスを使ってください。</p></details>}
  </div>;
}

function GoogleMark() { return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2.2H12v4.3h5.4a4.5 4.5 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.7ZM12 22c2.7 0 4.9-.9 6.6-2.4l-3.3-2.6c-.9.6-2 .9-3.3.9-2.6 0-4.8-1.7-5.6-4.1H3v2.7A10 10 0 0 0 12 22ZM6.4 13.8a6 6 0 0 1 0-3.6V7.5H3a10 10 0 0 0 0 9l3.4-2.7ZM12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.5 9.5 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.7A6 6 0 0 1 12 6.1Z" /></svg>; }
function AppleMark() { return <svg width="18" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.1 12.3c0-2.1 1.7-3.2 1.8-3.3-1-1.5-2.5-1.7-3.1-1.8-1.3-.1-2.6.8-3.3.8-.7 0-1.8-.8-2.9-.8C8.1 7.2 6.7 8 5.9 9.3c-1.6 2.7-.4 6.8 1.2 9 .8 1.1 1.7 2.3 2.9 2.2 1.1 0 1.6-.7 3-.7 1.4 0 1.8.7 3 .7s2-1.1 2.8-2.2c.9-1.3 1.3-2.6 1.3-2.7-.1 0-3-.9-3-3.3ZM14.8 5.7c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2-.5 2.7-1.3Z" /></svg>; }
