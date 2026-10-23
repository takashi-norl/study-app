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
  return <main className={styles.page}><Link href="/">← 自分の学習へ戻る</Link><p className={styles.label}>運営専用の取り込み</p><h1>確認した問題を、自分の問題集に保存。</h1><p>作成済みの問題セットを選び、内容を確認してから自分のアカウントに保存します。教材や問題は他の利用者には公開されません。</p>
    <label className={styles.upload}>問題セットのファイル<input aria-label="問題セットのファイル" type="file" accept=".json,application/json" disabled={busy} onChange={e=>void choose(e.target.files?.[0])}/></label>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {bundle&&<><section className={styles.summary}><span>{bundle.subject}・{bundle.questions.length}問</span><h2>{bundle.title}</h2><p>{bundle.description}</p><p>自分の教材に対応する問題として取り込みます。この操作ではAIに送信しません。</p></section>
      <ol className={styles.questions} aria-label="取り込む問題の一覧">{bundle.questions.map((q,i)=><li key={i}><h3>{q.prompt}</h3><p className={styles.point}>{q.learningPoint}</p><details><summary>選択肢・正解・解説を確認</summary><ol type="A">{q.choices.map((choice,j)=><li key={j}>{choice}{j===q.correctIndex&&<strong> ✓ 正解</strong>}</li>)}</ol><p>{q.explanation}</p><small>{q.sourceNote}</small></details></li>)}</ol>
      {!saved&&<section className={styles.save}><label><input type="checkbox" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/>原本・正解・解説を確認しました</label><button className="button primary" disabled={busy||!checked} onClick={()=>void save()}>{busy?'保存しています':`確認済みの${bundle.questions.length}問を保存`}</button><p>同じファイルを再度取り込んでも、問題セットは重複しません。</p></section>}
    </>}
    {saved&&<section className={styles.saved} role="status"><h2>{saved}</h2><p>「自分の問題・教材」から、保存した問題を解いたり編集したりできます。</p><Link className="button primary" href="/">自分の学習へ戻る</Link></section>}
  </main>;
}
