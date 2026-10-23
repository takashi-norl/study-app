'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, FilePenLine, RotateCw, X } from 'lucide-react';
import type { SourceDocument } from '@/lib/types';
import { createSourceReadingLoader, parseSourceReadingResponse, type SourceReading } from '@/lib/source-reading';
import styles from './source-reading-editor.module.css';

export function SourcePhoto({ source }: { source: SourceDocument }) {
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  if (!source.previewUrl) return <p>原本の表示を取得できません。</p>;
  return <div className={styles.photo}>
    {source.mimeType.startsWith('image/') ? <><div className={styles.actions}><button type="button" className="text-button" onClick={() => setRotation(value => (value + 90) % 360)}><RotateCw size={15}/>表示を90度回す</button><button type="button" className="text-button" onClick={() => setZoom(value => value === 3 ? 1 : value + 1)}>拡大：{zoom}倍</button></div><div className={styles.imageFrame}><div className={styles.imageCanvas} style={{width:`${zoom * 100}%`}}><img src={source.previewUrl} alt={`原本：${source.name}`} style={{ transform: `rotate(${rotation}deg)` }}/></div></div></>
      : <iframe src={source.previewUrl} title={`原本：${source.name}`}/>}
    <a href={source.previewUrl} target="_blank" rel="noreferrer" className="text-button">原本を別画面で開く</a>
  </div>;
}

export function SourceReadingEditor({ source, demo = false, compact = false }: { source: SourceDocument; demo?: boolean; compact?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef<string | null>(null);
  const loader = useRef(createSourceReadingLoader());
  const saveController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [reading, setReading] = useState<SourceReading | null>(null);
  const [text, setText] = useState('');
  const [points, setPoints] = useState('');
  const [uncertainties, setUncertainties] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [opened, setOpened] = useState(false);
  const dirty = !!reading && (text !== (reading.analysis?.text ?? '') || points !== (reading.analysis?.learningPoints ?? []).join('\n') || uncertainties !== (reading.analysis?.uncertainties ?? []).join('\n'));
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
  const pointLines = lines(points), uncertainLines = lines(uncertainties);
  const invalid = !text.trim() || text.length > 18000 || pointLines.length > 80 || uncertainLines.length > 50 || [...pointLines, ...uncertainLines].some(line => line.length > 300);
  useEffect(() => {
    mounted.current = true;
    const currentLoader = loader.current;
    return () => { mounted.current = false; currentLoader.cancel(); saveController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function apply(value: SourceReading) { setReading(value); setText(value.analysis?.text ?? ''); setPoints((value.analysis?.learningPoints ?? []).join('\n')); setUncertainties((value.analysis?.uncertainties ?? []).join('\n')); requestId.current = null; }
  async function load() {
    if (dirty && !window.confirm('入力中の変更を破棄して、保存済みの読み取りを開きますか？')) return;
    setLoading(true); setError(''); setSaved(false);
    const result = await loader.current.load(source.id);
    if (result.status === 'superseded' || !mounted.current) return;
    if (result.status === 'loaded') apply(result.reading);
    else setError(result.message);
    setLoading(false);
  }
  function open() { if (dialog.current?.open) return; setOpened(true); dialog.current?.showModal(); if (!demo) void load(); }
  function close() { if (saving || dirty && !window.confirm('未保存の読み取り修正があります。変更を破棄して閉じますか？')) return; loader.current.cancel(); setLoading(false); if (reading) apply(reading); dialog.current?.close(); setOpened(false); }
  function edit(action: () => void) { action(); requestId.current = null; setSaved(false); }
  async function save() {
    if (!reading || saving || loading || invalid || !dirty) return;
    setSaving(true); setError(''); setSaved(false);
    requestId.current ??= crypto.randomUUID();
    const controller = new AbortController();
    saveController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(source.id)}/analysis`, { method: 'PATCH', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: requestId.current, expectedRevision: reading.revision, text: text.trim(), learningPoints: pointLines, uncertainties: uncertainLines }) });
      const body = await parseSourceReadingResponse(response, source.id);
      if (mounted.current) { apply(body); setSaved(true); }
    } catch (reason) { if (mounted.current) setError(controller.signal.aborted ? '保存結果を確認できませんでした。入力は残っています。同じ内容でもう一度保存すると、同じ依頼番号で結果を確認します。' : reason instanceof Error ? reason.message : '読み取り内容を保存できませんでした。'); }
    finally { clearTimeout(timeout); saveController.current = null; if (mounted.current) setSaving(false); }
  }
  return <>
    <button type="button" className={compact ? 'text-button' : 'button secondary'} onClick={open}><FilePenLine size={16}/>{compact ? '読み取りを確認' : '読み取り内容を確認・修正'}</button>
    <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); close(); }} aria-labelledby={`reading-title-${source.id}`}>
      <header><div><h2 id={`reading-title-${source.id}`}>写真の読み取りを確認</h2><p>{source.name}</p></div><button type="button" className="text-button" aria-label="読み取り画面を閉じる" disabled={saving} onClick={close}><X size={22}/></button></header>
      {opened && <div className={styles.layout}><SourcePhoto source={source}/><div className={styles.fields}>
        <p className={styles.note}>原本と見比べ、誤字・語の意味・試験範囲を直せます。保存した内容は次のAI相談と作問に使います。修正前の試作は作り直してください。</p>
        {demo ? <p>デモでは原本の表示だけを試せます。読み取りの確認・保存はログイン後に使えます。</p> : <>
          {loading && <p role="status">保存済みの読み取りを開いています…</p>}
          {reading && <><p className={styles.state}>{reading.reviewed ? '修正して保存した読み取り' : reading.analysis ? 'AIが読み取った内容・未確認' : 'まだ読み取りはありません'}{reading.updatedAt && ` · ${new Date(reading.updatedAt).toLocaleString('ja-JP')}`}</p>
            <label>本文・原本から確認できた内容<textarea rows={12} value={text} maxLength={18000} disabled={saving || loading} onChange={event => edit(() => setText(event.target.value))}/></label>
            <label>学習する語・ポイント（1行に1つ）<textarea rows={5} value={points} disabled={saving || loading} onChange={event => edit(() => setPoints(event.target.value))}/></label>
            <label>読めない箇所・確認が必要な点（1行に1つ）<textarea rows={3} value={uncertainties} disabled={saving || loading} onChange={event => edit(() => setUncertainties(event.target.value))}/></label>
            <p className={styles.note}>本文は18,000文字、ポイントは80行、不確かな点は50行まで。各行300文字以内。保存によって正確さが自動で保証されるわけではありません。</p>
          </>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          {saved && <p className={styles.saved} role="status"><Check size={16}/>修正を保存しました。この内容で新しく試作を依頼できます。</p>}
          <div className={styles.actions}><button type="button" className="button primary" disabled={!reading || !dirty || invalid || saving || loading} onClick={() => void save()}>{saving ? '保存しています' : '修正した読み取りを保存'}</button><button type="button" className="text-button" disabled={saving || loading} onClick={() => void load()}>保存済みを読み直す</button></div>
        </>}
      </div></div>}
    </dialog>
  </>;
}
