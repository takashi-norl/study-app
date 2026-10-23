'use client';

import { useState } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import type { SourceDocument } from '@/lib/types';
import { SourceReadingEditor } from './source-reading-editor';
import styles from './source-material-panel.module.css';

/** Renders only source URLs already returned by the authorized study state. */
export function SourceMaterialPanel({ sources, title = '原本と見比べる', defaultOpen = false, demo = false }: {
  sources: SourceDocument[]; title?: string; defaultOpen?: boolean; demo?: boolean;
}) {
  const [selectedId, setSelectedId] = useState('');
  const source = sources.find(item => item.id === selectedId) ?? sources[0];
  if (!source) return null;
  return <details className={styles.panel} open={defaultOpen || undefined}>
    <summary><FileText size={17}/><span>{title}<small>写真・PDFと、各問の作問の根拠を照合</small></span></summary>
    <div className={styles.body}>
      {sources.length > 1 && <label>表示する教材<select value={source.id} onChange={event => setSelectedId(event.target.value)}>{sources.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.name}</option>)}</select></label>}
      <p className={styles.name}>{source.name}</p>
      {source.previewUrl ? <>
        {source.mimeType === 'application/pdf' ? <iframe className={styles.pdf} src={source.previewUrl} title={`教材の原本：${source.name}`}/>
          : source.mimeType.startsWith('image/') ? <a href={source.previewUrl} target="_blank" rel="noreferrer"><img src={source.previewUrl} alt={`教材の原本：${source.name}`} loading="lazy"/></a> : null}
        <a className="text-button" href={source.previewUrl} target="_blank" rel="noreferrer">原本を別画面で拡大<ArrowUpRight size={14}/></a>
      </> : <p className={styles.empty}>この教材のプレビューを取得できません。教材ストックから原本を確認してください。</p>}
      <p className={styles.note}>文字の読み違い・本文の範囲・解説の根拠を確認します。写真の内容がすべて出題済みかは、自動判定していません。</p>
      <SourceReadingEditor key={source.id} source={source} demo={demo}/>
    </div>
  </details>;
}
