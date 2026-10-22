'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import styles from './install.module.css';

export function CopyAppLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return <div className={styles.copyBox}><span className={styles.url}>{url}</span><button type="button" className={styles.copy} onClick={async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setError(false); }
    catch { setError(true); }
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'コピーしました' : 'リンクをコピー'}</button>{error && <span className={styles.copyError} role="status">上のURLを長押ししてコピーしてください。</span>}<span className="sr-only" role="status">{copied ? 'ひび学習のリンクをコピーしました。Safariに貼り付けてください。' : ''}</span></div>;
}
