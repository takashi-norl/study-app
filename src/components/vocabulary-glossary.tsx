'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookmarkPlus, Check, ChevronLeft, ChevronRight, History, RefreshCw, X } from 'lucide-react';
import { matchGlossaryTerms, type GlossaryEntry, type LookupRecord } from '@/lib/vocabulary-glossary';
import styles from './vocabulary-glossary.module.css';

export const GLOSSARY_PAUSE_AUDIO_EVENT = 'hibi-vocabulary-pause-audio';
type LookupAction = 'lookup' | 'practice' | 'known';
type SheetView = { kind: 'term'; termId: string; example: number } | { kind: 'history' };
type SaveOperation = { termId: string; action: LookupAction; requestId: string; state: 'saving' | 'saved' | 'error'; error?: string };
type HistoryFilter = 'all' | 'practice' | 'known';
type GlossaryContextValue = {
  entries: GlossaryEntry[];
  recordCount: number;
  openTerm: (termId: string, trigger: HTMLElement, sourceText?: string) => void;
  openHistory: (trigger: HTMLElement) => void;
};
const GlossaryContext = createContext<GlossaryContextValue | null>(null);
const statusLabels: Record<LookupRecord['status'], string> = { 'looked-up': '調べた', practice: '復習の目印', known: '確認できた' };

function lookupDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function GlossarySentence({ text, excludeEntryId }: { text: string; excludeEntryId?: string }) {
  const glossary = useContext(GlossaryContext);
  if (!glossary) return <>{text}</>;
  return <>{matchGlossaryTerms(text, glossary.entries).map((part, index) => part.entryId && part.entryId !== excludeEntryId
    ? <button type="button" className={styles.termLink} key={`${index}-${part.entryId}`} aria-label={`「${part.text}」の意味を見る`} onClick={event => glossary.openTerm(part.entryId!, event.currentTarget, text)}>{part.text}</button>
    : <span key={index}>{part.text}</span>)}</>;
}

export function GlossaryHistoryButton() {
  const glossary = useContext(GlossaryContext);
  if (!glossary) return null;
  return <button type="button" className={styles.historyButton} onClick={event => glossary.openHistory(event.currentTarget)}><History size={15} aria-hidden="true" />調べた言葉{glossary.recordCount > 0 && <span>{glossary.recordCount}</span>}</button>;
}

export function VocabularyGlossaryProvider({ entries, children }: { entries: GlossaryEntry[]; children: ReactNode }) {
  const [stack, setStack] = useState<SheetView[]>([]);
  const [records, setRecords] = useState<LookupRecord[]>([]);
  const [saves, setSaves] = useState<Record<string, SaveOperation>>({});
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyPage, setHistoryPage] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const originSentence = useRef<string | undefined>(undefined);
  const hasLoaded = useRef(false);
  const loadInFlight = useRef(false);
  const mutationVersion = useRef(0);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const view = stack.at(-1);
  const open = stack.length > 0;
  const entry = view?.kind === 'term' ? entries.find(item => item.id === view.termId) : undefined;
  const record = entry ? records.find(item => item.termId === entry.id) : undefined;
  const save = entry ? saves[entry.id] : undefined;
  const example = entry && view?.kind === 'term' ? entry.examples[view.example] : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const close = useCallback(() => {
    dialog.current?.close();
    setStack([]);
    const returnTo = opener.current;
    requestAnimationFrame(() => { if (returnTo?.isConnected) returnTo.focus({ preventScroll: true }); });
  }, []);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = oldOverflow;
      if (element?.open) element.close();
    };
  }, [open]);

  const viewKey = view?.kind === 'term' ? `term-${view.termId}` : view?.kind;
  useEffect(() => {
    if (!viewKey) return;
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      content.current?.scrollTo({ top: 0, behavior: 'instant' });
    });
  }, [viewKey]);

  const loadHistory = useCallback(async (force = false) => {
    if (loadInFlight.current || hasLoaded.current && !force) return;
    loadInFlight.current = true;
    setLoadingHistory(true);
    setHistoryError('');
    const version = mutationVersion.current;
    try {
      const response = await fetch('/api/vocabulary/lookups', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('調べた履歴を読み込めませんでした。');
      const data: { records?: LookupRecord[] } = await response.json();
      if (!Array.isArray(data.records)) throw new Error('調べた履歴を読み込めませんでした。');
      if (mounted.current) {
        setRecords(current => mutationVersion.current === version ? data.records! : [...new Map([...data.records!, ...current].map(item => [item.termId, item])).values()]);
        hasLoaded.current = true;
      }
    } catch {
      if (mounted.current) setHistoryError('履歴を読み込めませんでした。説明はそのまま見られます。');
    } finally {
      loadInFlight.current = false;
      if (mounted.current) setLoadingHistory(false);
    }
  }, []);

  const performSave = useCallback(async (operation: SaveOperation) => {
    try {
      const response = await fetch('/api/vocabulary/lookups', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termId: operation.termId, action: operation.action, requestId: operation.requestId }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(data.error || '履歴を保存できませんでした。');
      }
      const data: { record?: LookupRecord } = await response.json();
      if (!data.record || data.record.termId !== operation.termId) throw new Error('保存結果を確認できませんでした。');
      mutationVersion.current += 1;
      if (mounted.current) {
        setRecords(current => [...current.filter(item => item.termId !== data.record!.termId), data.record!]);
        setSaves(current => current[operation.termId]?.requestId === operation.requestId ? { ...current, [operation.termId]: { ...operation, state: 'saved' } } : current);
      }
    } catch {
      if (mounted.current) setSaves(current => current[operation.termId]?.requestId === operation.requestId ? { ...current, [operation.termId]: { ...operation, state: 'error', error: '保存を確認できませんでした。再試行しても二重には記録しません。' } } : current);
    }
  }, []);

  const enqueueSave = useCallback((operation: SaveOperation) => {
    setSaves(current => ({ ...current, [operation.termId]: { ...operation, state: 'saving', error: undefined } }));
    // Keep actual navigations in order; retrying a failed operation retains its request ID.
    mutationQueue.current = mutationQueue.current.catch(() => {}).then(() => performSave(operation));
  }, [performSave]);

  const saveAction = useCallback((termId: string, action: LookupAction) => {
    enqueueSave({ termId, action, requestId: crypto.randomUUID(), state: 'saving' });
  }, [enqueueSave]);

  const pauseStudyAudio = () => {
    document.dispatchEvent(new Event(GLOSSARY_PAUSE_AUDIO_EVENT));
    document.querySelectorAll('audio').forEach(element => element.pause());
  };

  const openTerm = (termId: string, trigger: HTMLElement, sourceText?: string) => {
    if (!entries.some(item => item.id === termId) || view?.kind === 'term' && view.termId === termId) return;
    if (!open) {
      opener.current = trigger;
      originSentence.current = sourceText;
    }
    pauseStudyAudio();
    setStack(current => [...current, { kind: 'term', termId, example: 0 }]);
    void loadHistory();
    saveAction(termId, 'lookup');
  };

  const openHistory = (trigger: HTMLElement) => {
    opener.current = trigger;
    originSentence.current = undefined;
    pauseStudyAudio();
    setHistoryPage(0);
    setStack([{ kind: 'history' }]);
    void loadHistory(true);
  };

  const goBack = () => {
    if (stack.length <= 1) { close(); return; }
    setStack(current => current.slice(0, -1));
  };
  const moveExample = (index: number) => setStack(current => current.map((item, position) => position === current.length - 1 && item.kind === 'term' ? { ...item, example: index } : item));
  const historyRecords = records.filter(item => entries.some(entry => entry.id === item.termId));
  const inHistoryFilter = (item: LookupRecord, filter: HistoryFilter) => filter === 'all' || (filter === 'practice' ? item.status === 'looked-up' || item.status === 'practice' : item.status === 'known');
  const filteredRecords = historyRecords.filter(item => inHistoryFilter(item, historyFilter)).sort((first, second) => second.lastLookedUpAt.localeCompare(first.lastLookedUpAt));
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / 10));
  const currentPage = Math.min(historyPage, pageCount - 1);
  const visibleRecords = filteredRecords.slice(currentPage * 10, (currentPage + 1) * 10);
  const parentView = stack.at(-2);
  const parentLabel = parentView?.kind === 'history' ? '調べた言葉' : parentView?.kind === 'term' ? entries.find(item => item.id === parentView.termId)?.term : undefined;
  const successMessage = save?.action === 'practice' ? '復習の目印を付けました' : save?.action === 'known' ? '「確認できた」と記録しました' : '調べた履歴に保存しました';

  return <GlossaryContext.Provider value={{ entries, recordCount: historyRecords.length, openTerm, openHistory }}>
    {children}
    <dialog ref={dialog} className={styles.sheet} aria-labelledby="vocabulary-glossary-heading" onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
      <header className={styles.header}>
        <div className={styles.location}>{stack.length > 1 ? <button type="button" className={styles.back} onClick={goBack}><ArrowLeft size={17} aria-hidden="true" />戻る</button> : <span>{view?.kind === 'history' ? '自分の調べた履歴' : '例文の言葉を調べる'}</span>}{parentLabel && <><ChevronRight size={13} aria-hidden="true" /><span>{parentLabel}</span></>}</div>
        <button type="button" className={styles.close} onClick={close} aria-label="用語説明を閉じる"><X size={21} aria-hidden="true" /></button>
      </header>
      <div className={styles.content} ref={content}>
        {entry && view?.kind === 'term' && <>
          <div className={styles.termHeading}><h2 id="vocabulary-glossary-heading" ref={heading} tabIndex={-1} lang="en">{entry.term}</h2><span>{entry.level}</span></div>
          <p className={styles.meaning}>{entry.meaning}</p>
          <p className={styles.definition} lang="en"><GlossarySentence text={entry.definition} excludeEntryId={entry.id} /></p>
          {example && <section className={styles.examples} aria-label="使い方の例文">
            <p className={styles.exampleLabel}>使い方の例文 {view.example + 1} / {entry.examples.length}</p>
            <p lang="en" className={styles.exampleText}><GlossarySentence text={example.text} excludeEntryId={entry.id} /></p>
            <p className={styles.translation}>{example.translation}</p>
            {entry.examples.length > 1 && <div className={styles.pager}><button type="button" aria-label="前の用語例文" disabled={view.example === 0} onClick={() => moveExample(view.example - 1)}><ChevronLeft size={19} /></button><span>{view.example + 1} / {entry.examples.length}</span><button type="button" aria-label="次の用語例文" disabled={view.example === entry.examples.length - 1} onClick={() => moveExample(view.example + 1)}><ChevronRight size={19} /></button></div>}
          </section>}
          {entry.relatedIds.some(id => entries.some(item => item.id === id)) && <section className={styles.related} aria-label="関連する言葉"><p>あわせて知っておくと便利</p><div>{entry.relatedIds.flatMap(id => {
            const related = entries.find(item => item.id === id);
            return related && related.id !== entry.id ? [<button type="button" key={id} lang="en" onClick={event => openTerm(id, event.currentTarget)}>{related.term}<ArrowRight size={13} aria-hidden="true" /></button>] : [];
          })}</div></section>}
          {originSentence.current && <details className={styles.origin}><summary>元の例文を見る</summary><p lang="en">{originSentence.current}</p></details>}
          <section className={styles.record} aria-label="この言葉の記録">
            {record && <p className={styles.recordMeta}><span>{record.lookupCount}回調べました</span><span>前回 {lookupDate(record.lastLookedUpAt)}</span><span>{statusLabels[record.status]}</span></p>}
            <div className={styles.recordActions}>
              <button type="button" disabled={!record || save?.state === 'saving' || save?.state === 'error' || record.status === 'practice'} aria-pressed={record?.status === 'practice'} onClick={() => saveAction(entry.id, 'practice')}>{record?.status === 'practice' ? <Check size={15} aria-hidden="true" /> : <BookmarkPlus size={15} aria-hidden="true" />}{record?.status === 'practice' ? '復習の目印を付けました' : 'あとで復習する'}</button>
              <button type="button" disabled={!record || save?.state === 'saving' || save?.state === 'error' || record.status === 'known'} aria-pressed={record?.status === 'known'} onClick={() => saveAction(entry.id, 'known')}><Check size={15} aria-hidden="true" />{record?.status === 'known' ? '確認できた・記録済み' : '今は分かった'}</button>
            </div>
            {save?.state === 'saving' && <p className={styles.saveStatus} role="status">履歴を保存しています。説明はこのまま読めます。</p>}
            {save?.state === 'saved' && <p className={styles.saveStatus} role="status"><Check size={13} aria-hidden="true" />{successMessage}</p>}
            {save?.state === 'error' && <div className={styles.saveError} role="alert"><p>{save.error}</p><button type="button" onClick={() => enqueueSave(save)}><RefreshCw size={14} aria-hidden="true" />同じ記録を再試行する</button></div>}
            <p className={styles.recordNote}>調べた言葉は復習候補に残ります。「今は分かった」で確認済みにできます。履歴は自分のアカウントに保存します。</p>
            {historyError && <div className={styles.saveError} role="alert"><p>{historyError}</p><button type="button" disabled={loadingHistory} onClick={() => void loadHistory(true)}>履歴を読み直す</button></div>}
          </section>
        </>}
        {view?.kind === 'history' && <>
          <div className={styles.historyHeading}><h2 id="vocabulary-glossary-heading" ref={heading} tabIndex={-1}>調べた言葉</h2><button type="button" className={styles.refresh} aria-label="調べた履歴を更新" disabled={loadingHistory} onClick={() => void loadHistory(true)}><RefreshCw size={17} aria-hidden="true" /></button></div>
          <p className={styles.historyNote}>調べた言葉は復習候補に残ります。「今は分かった」で確認済みにできます。自分の履歴は、ほかの端末でも確認できます。</p>
          <div className={styles.filters} aria-label="履歴の絞り込み">{(['all', 'practice', 'known'] as const).map(value => <button type="button" key={value} aria-pressed={historyFilter === value} onClick={() => { setHistoryFilter(value); setHistoryPage(0); }}>{value === 'all' ? 'すべて' : value === 'practice' ? '復習候補' : '確認できた'}<span>{historyRecords.filter(item => inHistoryFilter(item, value)).length}</span></button>)}</div>
          {loadingHistory && <p className={styles.saveStatus} role="status">保存された履歴を読み込んでいます…</p>}
          {historyError && <div className={styles.saveError} role="alert"><p>{historyError}</p><button type="button" disabled={loadingHistory} onClick={() => void loadHistory(true)}>もう一度読み込む</button></div>}
          <div className={styles.historyList}>{visibleRecords.map(item => {
            const word = entries.find(entry => entry.id === item.termId)!;
            return <button type="button" className={styles.historyRow} key={item.termId} onClick={event => openTerm(item.termId, event.currentTarget)}><span><strong lang="en">{word.term}</strong><small>{item.lookupCount}回 · {lookupDate(item.lastLookedUpAt)}</small></span><em>{statusLabels[item.status]}</em><ChevronRight size={16} aria-hidden="true" /></button>;
          })}</div>
          {!loadingHistory && !historyError && visibleRecords.length === 0 && <p className={styles.empty}>{historyFilter === 'all' ? '例文の下線がある言葉を押すと、ここに記録されます。' : historyFilter === 'practice' ? '今は復習候補がありません。新しく調べた言葉はここに残ります。' : '説明を読んで「今は分かった」を選ぶと、ここで確認できます。'}</p>}
          {pageCount > 1 && <div className={styles.historyPager}><button type="button" disabled={currentPage === 0} onClick={() => { setHistoryPage(currentPage - 1); content.current?.scrollTo({ top: 0, behavior: 'instant' }); }}><ChevronLeft size={16} aria-hidden="true" />前の10件</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage === pageCount - 1} onClick={() => { setHistoryPage(currentPage + 1); content.current?.scrollTo({ top: 0, behavior: 'instant' }); }}>次の10件<ChevronRight size={16} aria-hidden="true" /></button></div>}
        </>}
      </div>
      <footer className={styles.footer}><button type="button" className={styles.return} onClick={close}><ArrowLeft size={17} aria-hidden="true" />{originSentence.current ? '元の例文に戻る' : '学習に戻る'}</button></footer>
    </dialog>
  </GlossaryContext.Provider>;
}
