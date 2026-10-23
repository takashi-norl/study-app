'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, MessageSquare, Send } from 'lucide-react';
import styles from './beta-support.module.css';

export function BetaFeedbackPanel() {
  const [category, setCategory] = useState('困った');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ requestId: string; category: string; message: string } | null>(null);
  const locked = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !message.trim()) return;
    locked.current = true; setBusy(true); setError('');
    if (!request.current || request.current.message !== message.trim() || request.current.category !== category) request.current = { requestId: crypto.randomUUID(), category, message: message.trim() };
    try {
      const response = await fetch('/api/feedback', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.current) });
      const result = await response.json();
      if (!response.ok || !result.received) throw new Error(result.error || '送信を確認できませんでした。同じ内容でもう一度送れます。');
      setSent(true);
    } catch (error) { setError(error instanceof Error ? error.message : '送信を確認できませんでした。同じ内容でもう一度送れます。'); }
    finally { locked.current = false; setBusy(false); }
  }
  return <main className={styles.page}>
    <Link href="/" className={styles.back}><ArrowLeft size={16}/>学習に戻る</Link>
    <section className={styles.card}>
      <MessageSquare size={26} aria-hidden="true"/><p className={styles.eyebrow}>使った感想を、ひとこと。</p>
      <h1>どこが使いにくかった？</h1><p>「ここが好き」も、「こうだったらいいな」も。次の改善に使います。</p>
      {sent ? <div className={styles.success} role="status"><CheckCircle2 size={26}/><h2>届けました。ありがとう！</h2><p>入力した感想を届けました。教材や学習記録は添付していません。</p><Link href="/" className="button primary">学習に戻る</Link></div> : <form onSubmit={submit}>
        <fieldset disabled={busy}><legend>どんな感想？</legend><div className={styles.choices}>{['困った','よかった','ほしい'].map(value => <label key={value}><input type="radio" name="category" value={value} checked={category === value} onChange={() => setCategory(value)}/>{value}</label>)}</div></fieldset>
        <label className={styles.field}>ひとこと<textarea required maxLength={1200} rows={6} value={message} disabled={busy} onChange={event => setMessage(event.target.value)} placeholder="どの画面で、どうなった？ ひとことでも大丈夫。"/></label>
        <p className={styles.note}>この文章はアプリの運営に届きます。教材の本文・写真や個人情報を入れずに書いてください。学習記録は自動送信しません。</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <button className="button primary" disabled={busy || !message.trim()}><Send size={16}/>{busy ? '送っています…' : '感想を送る'}</button>
      </form>}
    </section>
  </main>;
}

export function BetaBillingPanel() {
  return <main className={styles.page}><Link href="/" className={styles.back}><ArrowLeft size={16}/>学習に戻る</Link><section className={styles.card}>
    <p className={styles.eyebrow}>テスト利用中</p><h1>いまは、課金なし。</h1>
    <p>有料プランはまだ始まっていません。月額料金は決まり次第、ここでお知らせします。自動で課金されることはありません。</p>
    <div className={styles.inset}><h2>支払いと学習は、別々に。</h2><p>有料プランの開始後は、必要なときだけ支払いをお願いする流れを用意します。支払う人に、写真・PDF・問題・AIとの会話・成績を見せる機能はありません。</p></div>
    <p className={styles.note}>テスト期間中のAIには利用回数の上限があります。保存した問題と用意された教材は、AIの作問を追加せず学べます。</p><Link href="/" className="button primary">学習を続ける</Link>
  </section></main>;
}

type Feedback = { id: string; createdAt: string; category: string; message: string; version: string };
export function BetaFeedbackInbox() {
  const [rows, setRows] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController();
    void fetch('/api/feedback', { signal: controller.signal, cache: 'no-store' }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || '読み込めませんでした。'); setRows(result.feedback); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <main className={styles.page}><Link href="/admin" className={styles.back}><ArrowLeft size={16}/>運営画面に戻る</Link><section className={styles.card}><h1>届いた感想</h1><p>利用者が送った文章だけを表示します。教材・成績・AIとの相談は表示しません。</p>{error && <p role="alert">{error}</p>}{loading ? <p role="status">読み込んでいます…</p> : !rows.length && <p>まだ感想は届いていません。</p>}{rows.map(row => <article className={styles.feedback} key={row.id}><strong>{row.category}</strong><small>{new Date(row.createdAt).toLocaleString('ja-JP')} · v{row.version}</small><p>{row.message}</p></article>)}</section></main>;
}
