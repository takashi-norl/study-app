'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { appUrlForOrigin } from '@/lib/app-identity';
import styles from './install.module.css';

export function CopyAppLink() {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setUrl(appUrlForOrigin(window.location.origin)); }, []);
  return <div className={styles.copyBox}><span className={styles.url}>{url || 'この環境のアプリのリンクを準備しています。'}</span><button type="button" className={styles.copy} disabled={!url} onClick={async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setError(false); }
    catch { setError(true); }
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'コピーしました' : 'リンクをコピー'}</button>{error && <span className={styles.copyError} role="status">上のURLを長押ししてコピーしてください。</span>}<span className="sr-only" role="status">{copied ? 'ひび学習のリンクをコピーしました。Safariに貼り付けてください。' : ''}</span></div>;
}
