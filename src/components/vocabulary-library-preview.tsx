'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GlossaryEntry } from '@/lib/vocabulary-glossary';
import { VOCABULARY_LEVELS, type VocabularyAudio, type VocabularyBatchSummary, type VocabularyEntry } from '@/lib/vocabulary-types';
import VocabularyMarathon from './vocabulary-marathon';
import styles from './vocabulary-marathon.module.css';

type BatchPreview = { entries: VocabularyEntry[]; audio: VocabularyAudio[]; batchId: string; canPrepareAudio: boolean };

/** Fetch only the chosen batch. Thousands of cards are never included in the initial page. */
export default function VocabularyLibraryPreview({ initial, batches, glossary, preparation }: {
  initial: BatchPreview; batches: VocabularyBatchSummary[]; glossary: GlossaryEntry[]; preparation?: ReactNode;
}) {
  const [preview, setPreview] = useState(initial);
  const [selected, setSelected] = useState(initial.batchId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const choose = async (batchId: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setSelected(batchId); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/vocabulary-samples?batch=${encodeURIComponent(batchId)}`, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error('教材を読み込めませんでした。もう一度選んでください。');
      const data: BatchPreview = await response.json();
      if (data.batchId !== batchId || !Array.isArray(data.entries) || !Array.isArray(data.audio)) throw new Error('教材を読み込めませんでした。');
      if (controller.signal.aborted) return;
      setPreview(data);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSelected(preview.batchId);
      setError(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '読み込みに時間がかかっています。接続を確認して、もう一度選んでください。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const picker = batches.length > 1 ? <section className={styles.libraryPicker} aria-label="単語ライブラリ">
    <label htmlFor="vocabulary-library-batch">学ぶ教材</label>
    <select id="vocabulary-library-batch" value={selected} onChange={event => void choose(event.target.value)} aria-describedby="vocabulary-library-help">
      {batches.filter(batch => !batch.level).map(batch => <option key={batch.id} value={batch.id}>{batch.title}（{batch.entryCount}語）</option>)}
      {VOCABULARY_LEVELS.filter(level => batches.some(batch => batch.level === level)).map(level => <optgroup key={level} label={level}>
        {batches.filter(batch => batch.level === level).map(batch => <option key={batch.id} value={batch.id}>{batch.title}（{batch.entryCount}語）</option>)}
      </optgroup>)}
    </select>
    <p id="vocabulary-library-help">全{batches.reduce((count, batch) => count + batch.entryCount, 0).toLocaleString()}語から選べます。別の教材に切り替えると、この見本の回答はリセットされます。</p>
    {busy && <p role="status">選んだ教材を読み込んでいます…</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section> : null;

  return <VocabularyMarathon key={preview.batchId} {...preview} glossary={glossary}
    preparation={<>{picker}{preview.canPrepareAudio && preparation}</>} />;
}
