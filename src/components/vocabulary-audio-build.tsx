'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Status = { total: number; ready: number; missing: number; failed: number; pending: number; running: boolean };
export default function VocabularyAudioBuild({ canBuild, initial }: { canBuild: boolean; initial: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [watch, setWatch] = useState(initial.ready < initial.total);
  const [error, setError] = useState('');
  async function refresh() {
    const response = await fetch('/api/admin/vocabulary-samples/build', { cache: 'no-store' });
    if (!response.ok) throw new Error('音声の準備状況を確認できませんでした。');
    const next: Status = await response.json(); setStatus(next);
    if (next.ready > status.ready) router.refresh();
    if (next.ready === next.total) { setWatch(false); router.refresh(); }
    return next;
  }
  useEffect(() => {
    if (!watch) return;
    let cancelled = false;
    const timer = setInterval(() => { if (!cancelled) void refresh().catch(() => setError('通信を確認できませんでした。保存済みの音声は残っています。')); }, 12000);
    return () => { cancelled = true; clearInterval(timer); };
  // Refresh uses the latest saved count so a completed asset updates the player once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, status.ready]);
  if (status.ready === status.total) return <p style={{ fontSize: 12, color: '#627858', marginBottom: 12 }}>✓ {status.total}語の発音・例文音声を保存済み</p>;
  async function begin() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/vocabulary-samples/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || '準備を開始できませんでした。'); }
      setStatus(value => ({ ...value, running: true })); setWatch(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '準備を開始できませんでした。'); }
    finally { setBusy(false); }
  }
  return <details style={{ border: '1px solid #d9e5d0', background: '#f5f8ef', padding: '10px 14px', borderRadius: 10, marginBottom: 12, fontSize: 12 }}>
    <summary style={{ cursor: 'pointer', minHeight: 32, lineHeight: '32px' }}>音声 {status.ready} / {status.total}語 保存済み{status.running ? '・準備中' : ''}</summary>
    <p style={{ lineHeight: 1.8 }}>単語と例文3つを、1語ずつ保存します。準備を始めた後は、画面を閉じても続きます。保存済みの単語から聞けます。</p>
    <progress value={status.ready} max={status.total} style={{ width: '100%', margin: '8px 0' }} />
    {(status.failed > 0 || status.pending > 0) && <p>保存を確認できていない音声：{status.failed + status.pending}語。重複生成を避けるため、自動で再生成しません。</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {canBuild && status.missing > 0 && <button type="button" className="button secondary" disabled={busy || status.running} onClick={() => void begin()}>{busy ? '開始しています' : status.running ? '音声を準備しています' : '未作成の音声をまとめて準備'}</button>}
      <button type="button" className="text-button" disabled={busy} onClick={() => { setError(''); void refresh().catch(failure => setError(failure.message)); }}>保存状況を確認</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
