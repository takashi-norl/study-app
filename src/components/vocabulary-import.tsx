'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { VOCABULARY_IMPORT_FILE_BYTES, vocabularyImportBundleSchema, vocabularyImportReceiptSchema, vocabularyImportResponseSchema, type VocabularyImportBundle, type VocabularyImportReceipt } from '@/lib/vocabulary-import';
import styles from './vocabulary-import.module.css';

const receiptSchema = z.object({ batchId: z.string(), sha256: z.string(), audio: vocabularyImportReceiptSchema });
type Receipt = z.infer<typeof receiptSchema>;
type Selection = { file: File; batchId: string; clips: { wordId: string; cacheKey: string; sha256: string }[] };
const keyOf = (batchId: string, clip: { wordId: string; sha256: string }) => `${batchId}|${clip.wordId}|${clip.sha256}`;

async function receiptDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('hibi-vocabulary-import-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('progress_storage_unavailable'));
    request.onblocked = () => reject(new Error('progress_storage_unavailable'));
  });
}
async function readReceipts(scope: string): Promise<Receipt[]> {
  const db = await receiptDb();
  try {
    return await new Promise<Receipt[]>((resolve, reject) => {
      const transaction = db.transaction('receipts', 'readonly');
      const request = transaction.objectStore('receipts').getAll(IDBKeyRange.bound(`${scope}|`, `${scope}|\uffff`));
      request.onsuccess = () => resolve(request.result.flatMap(value => { const result = receiptSchema.safeParse(value); return result.success ? [result.data] : []; }));
      request.onerror = () => reject(new Error('progress_storage_unavailable'));
    });
  } finally { db.close(); }
}
async function saveReceipt(scope: string, value: Receipt) {
  const db = await receiptDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('receipts', 'readwrite');
      transaction.objectStore('receipts').put({ id: `${scope}|${keyOf(value.batchId, { wordId: value.audio.wordId, sha256: value.sha256 })}`, ...value });
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('progress_storage_unavailable'));
    });
  } finally { db.close(); }
}
async function readBundle(file: File): Promise<VocabularyImportBundle> {
  if (file.size > VOCABULARY_IMPORT_FILE_BYTES) throw new Error(`${file.name} が大きすぎます。32MB以下に分けたファイルを選んでください。`);
  const bundle = vocabularyImportBundleSchema.safeParse(JSON.parse(await file.text()));
  if (!bundle.success) throw new Error(`${file.name} は音声取込用ファイルではありません。`);
  return bundle.data;
}
function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VocabularyImport({ receiptScope }: { receiptScope: string }) {
  const [selection, setSelection] = useState<Selection[]>([]);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const receiptsRef = useRef<Record<string, Receipt>>({});
  const [hydrated, setHydrated] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false), stopRef = useRef(false), selectionVersion = useRef(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [active, setActive] = useState('');
  useEffect(() => {
    let cancelled = false;
    void readReceipts(receiptScope).then(values => {
      if (cancelled) return;
      const found = Object.fromEntries(values.map(value => [keyOf(value.batchId, { wordId: value.audio.wordId, sha256: value.sha256 }), value]));
      receiptsRef.current = found; setReceipts(found);
    }).catch(() => { if (!cancelled) setWarning('このブラウザに進捗を保存できません。取込結果を保存してから画面を閉じてください。'); })
      .finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; stopRef.current = true; };
  }, [receiptScope]);

  const total = selection.reduce((sum, item) => sum + item.clips.length, 0);
  const completed = selection.reduce((sum, item) => sum + item.clips.filter(clip => !!receipts[keyOf(item.batchId, clip)]).length, 0);
  const results = new Map<string, VocabularyImportReceipt[]>();
  for (const item of selection) for (const clip of item.clips) {
    const record = receipts[keyOf(item.batchId, clip)];
    if (record) results.set(item.batchId, [...(results.get(item.batchId) ?? []), record.audio]);
  }

  async function chooseFiles(files: File[]) {
    const version = ++selectionVersion.current;
    setPreparing(true); setError(''); setMessage('ファイルの内容を確認しています。'); setSelection([]);
    try {
      if (files.length > 1000) throw new Error('一度に選べるファイルは1,000件までです。');
      const next: Selection[] = [], seen = new Set<string>();
      let count = 0;
      for (const file of files) {
        const bundle = await readBundle(file);
        if (version !== selectionVersion.current) return;
        const clips = bundle.clips.map(({ wordId, cacheKey, sha256 }) => ({ wordId, cacheKey, sha256 }));
        for (const clip of clips) {
          const key = `${bundle.batchId}|${clip.wordId}`;
          if (seen.has(key)) throw new Error('同じ単語が複数のファイルにあります。重複するファイルを外してください。');
          seen.add(key);
        }
        count += clips.length;
        if (count > 7500) throw new Error('一度に取り込める音声は7,500語までです。');
        next.push({ file, batchId: bundle.batchId, clips });
      }
      setSelection(next); setMessage(next.length ? '内容を確認しました。保存を開始できます。' : '');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'ファイルを読み込めませんでした。'); setMessage(''); }
    finally { if (version === selectionVersion.current) setPreparing(false); }
  }

  async function start() {
    if (busyRef.current || !selection.length || !hydrated) return;
    busyRef.current = true; stopRef.current = false; setBusy(true); setError(''); setMessage('');
    try {
      for (const item of selection) {
        if (stopRef.current) break;
        const bundle = await readBundle(item.file);
        for (const clip of bundle.clips) {
          if (stopRef.current) break;
          const key = keyOf(bundle.batchId, clip);
          if (receiptsRef.current[key]) continue;
          setActive(clip.wordId);
          const response = await fetch('/api/admin/vocabulary-import', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 2, batchId: bundle.batchId, clips: [clip] }),
            signal: AbortSignal.timeout(180_000),
          });
          const body: unknown = await response.json();
          if (!response.ok) throw new Error(typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : '保存を確認できませんでした。再開すると保存先を確認します。');
          const imported = vocabularyImportResponseSchema.parse(body);
          const audio = imported.audio[0];
          if (imported.batchId !== bundle.batchId || audio.wordId !== clip.wordId || audio.cacheKey !== clip.cacheKey) throw new Error('保存結果が一致しません。処理を止めました。');
          const receipt: Receipt = { batchId: bundle.batchId, sha256: clip.sha256, audio };
          receiptsRef.current = { ...receiptsRef.current, [key]: receipt }; setReceipts(receiptsRef.current);
          try { await saveReceipt(receiptScope, receipt); }
          catch { setWarning('このブラウザに進捗を保存できません。取込結果を保存してから画面を閉じてください。'); }
        }
      }
      setMessage(stopRef.current ? '一時停止しました。同じ画面から続きの保存を再開できます。' : '選んだ音声を保存しました。取込結果を保存してください。');
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' && failure.name !== 'TypeError' ? failure.message : '通信が中断しました。保存済みの音声は残っています。「保存を再開」で続けられます。');
    } finally { busyRef.current = false; setBusy(false); setActive(''); }
  }

  return <main className={styles.page}>
    <header className={styles.header}><Link href="/admin/vocabulary-samples">← 単語教材へ戻る</Link><span>Super User</span></header>
    <h1>作成済み音声の取込</h1>
    <p className={styles.lead}>単語と例文の音声を、アプリ専用のGoogle Driveへ保存します。</p>
    <section className={styles.card}>
      <h2>1. 取込ファイルを選ぶ</h2>
      <label className={styles.file}>音声取込用のJSONファイル（複数選択できます）
        <input type="file" accept="application/json,.json" multiple disabled={busy || preparing || !hydrated} onChange={event => void chooseFiles(Array.from(event.target.files ?? []))} />
      </label>
      <p>{preparing ? '内容を確認しています…' : selection.length ? `${selection.length}ファイル・${total}語を選択` : 'ファイルを選ぶと、音声の件数を確認できます。'}</p>
    </section>
    <section className={styles.card}>
      <h2>2. 音声を保存する</h2>
      <div className={styles.count} aria-live="polite"><strong>{completed} / {total}語</strong><span>保存済み</span></div>
      <progress value={completed} max={total || 1} className={styles.progress} />
      {busy && <p role="status">{active} を保存しています。画面を開いたままお待ちください。</p>}
      <div className={styles.actions}>
        <button className="button primary" type="button" disabled={!total || busy || preparing || !hydrated || completed === total} onClick={() => void start()}>{busy ? '保存しています' : total > 0 && completed === total ? '保存済み' : completed ? '保存を再開' : 'Google Driveへ保存'}</button>
        {busy && <button className="button secondary" type="button" onClick={() => { stopRef.current = true; setMessage('現在の1語を保存してから停止します。'); }}>一時停止</button>}
      </div>
      <p className={styles.note}>中断した場合も、同じファイルを選ぶと保存済みの続きから再開できます。</p>
    </section>
    {(message || error || warning) && <div className={styles.status}>
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}{warning && <p role="alert">{warning}</p>}
    </div>}
    {results.size > 0 && <section className={styles.card}>
      <h2>3. 取込結果を保存する</h2>
      <p>教材への反映に使う保存結果です。音声ファイルは含みません。</p>
      {Array.from(results).map(([batchId, audio]) => <button key={batchId} type="button" className={styles.receipt} onClick={() => downloadJson({ batchId, audio }, `${batchId}-audio-import.json`)}>{batchId}・{audio.length}語の取込結果を保存 ↓</button>)}
    </section>}
  </main>;
}
