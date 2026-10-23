'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { QUESTION_SET_IMPORT_BYTES, questionSetBundleSchema, type QuestionSetBundle } from '@/lib/question-set-import';
import styles from './question-set-import.module.css';

export default function QuestionSetImport() {
  const [bundle,setBundle]=useState<QuestionSetBundle|null>(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[saved,setSaved]=useState('');
  const lock=useRef(false),selection=useRef(0);
  async function choose(file?:File) {
    const current=++selection.current;
    setBundle(null);setChecked(false);setError('');setSaved('');
    if(!file)return;
    try {
      if(file.size>QUESTION_SET_IMPORT_BYTES)throw new Error('ファイルは120KB以内にしてください。');
      const result=questionSetBundleSchema.safeParse(JSON.parse(await file.text()));
      if(!result.success)throw new Error('問題セットの形式を確認してください。問題文・四択・正解・解説・根拠が必要です。');
      if(current===selection.current)setBundle(result.data);
    }catch(e){if(current===selection.current)setError(e instanceof Error?e.message:'ファイルを読み取れませんでした。');}
  }
  async function save() {
    if(lock.current||!bundle||!checked)return;
    lock.current=true;setBusy(true);setError('');
    try {
      const response=await fetch('/api/admin/question-set-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bundle,reviewed:true})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'保存できませんでした。同じファイルで再試行できます。');
      setSaved(`「${result.title}」${result.count}問を保存しました。`);
    }catch(e){setError(e instanceof Error?e.message:'保存できませんでした。');}
    finally{lock.current=false;setBusy(false);}
  }
  return <main className={styles.page}><Link href="/">← アプリに戻る</Link><p className={styles.label}>管理者の問題セット</p><h1>確認した問題を、まとめて保存。</h1><p>作成済みの問題セットを選び、内容を見てから保存します。保存後はライブラリから学習者に届けられます。</p>
    <label className={styles.upload}>問題セットのファイル<input aria-label="問題セットのファイル" type="file" accept=".json,application/json" disabled={busy} onChange={e=>void choose(e.target.files?.[0])}/></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {bundle&&<><section className={styles.summary}><span>{bundle.subject}・{bundle.questions.length}問</span><h2>{bundle.title}</h2><p>{bundle.description}</p><p>この原本は管理者だけに表示されます。</p></section>
      <ol className={styles.questions} aria-label="取り込む問題の一覧">{bundle.questions.map((q,i)=><li key={i}><h3>{q.prompt}</h3><p className={styles.point}>{q.learningPoint}</p><details><summary>選択肢・正解・解説を確認</summary><ol type="A">{q.choices.map((choice,j)=><li key={j}>{choice}{j===q.correctIndex&&<strong> ✓ 正解</strong>}</li>)}</ol><p>{q.explanation}</p><small>{q.sourceNote}</small></details></li>)}</ol>
      {!saved&&<section className={styles.save}><label><input type="checkbox" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/>原本・正解・解説を確認しました</label><button className="button primary" disabled={busy||!checked} onClick={()=>void save()}>{busy?'保存しています':`確認済みの${bundle.questions.length}問を保存`}</button><p>同じファイルを再度取り込んでも、問題セットは重複しません。</p></section>}
    </>}
    {saved&&<section className={styles.saved} role="status"><h2>{saved}</h2><p>ライブラリの「学習者に届ける」から、本人用のセットを渡せます。</p><Link className="button primary" href="/">アプリを開く</Link></section>}
  </main>;
}
