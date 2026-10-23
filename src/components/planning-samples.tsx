'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, CircleHelp, MessageCircle, RefreshCw, Sparkles } from 'lucide-react';
import type { LearningPlan, PlanningProposal, PlanningTurn } from '@/lib/types';
import type { StudyController } from './controller';
import { resolveBulkVolume } from '@/lib/sample-volume';
import styles from './planning-samples.module.css';

type Stage = 'samples' | 'adjust' | 'quantity';
export function PlanningSamples({ c, plan, turn, proposal, canGenerate, onGenerated, blockedAction }: {
  c: StudyController; plan: LearningPlan; turn: PlanningTurn; proposal: PlanningProposal; canGenerate: boolean; onGenerated: () => void;
  blockedAction?: { message: string; label: string; run: () => void };
}) {
  const [stage, setStage] = useState<Stage>('samples');
  const [index, setIndex] = useState(0);
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState<'total'|'schedule'>('total');
  const [total, setTotal] = useState<number | null>(null);
  const [days, setDays] = useState('7');
  const [daily, setDaily] = useState(10);
  const [attempted, setAttempted] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const top = useRef<HTMLElement>(null);
  const sampleTop = useRef<HTMLDivElement>(null);
  const own = plan.ownerId === c.profile.id;
  const samples = proposal.samples ?? [];
  const complete = samples.length === 3;
  const sample = samples[Math.min(index, Math.max(0, samples.length-1))];
  const volume = resolveBulkVolume(mode === 'total' ? {mode, total} : {mode, days:Number(days), daily});
  const disabled = !canGenerate || c.busy || localBusy;
  useEffect(() => { setStage('samples'); setIndex(0); setComment(''); setTotal(null); }, [turn.id, proposal.id]);
  function move(next: Stage) { setStage(next); setAttempted(false); requestAnimationFrame(()=>{if(top.current?.getClientRects().length)top.current.scrollIntoView({block:'start'});}); }
  function selectSample(next:number){setIndex(next);requestAnimationFrame(()=>{if(sampleTop.current?.getClientRects().length)sampleTop.current.scrollIntoView({block:'start'});});}
  async function revise(missing = false) {
    if (disabled || !missing && !comment.trim()) return;
    setAttempted(true); setLocalBusy(true);
    try {
      const message = missing
        ? `「${proposal.title}」の案で、まず実際の四択問題を3問だけ試作してください。出題内容：${proposal.instructions.slice(0,1800)}。問題文、選択肢、正解、解説を見て調整します。全体の分量はまだ決めません。`
        : `「${proposal.title}」の試作3問を、次の希望を反映して作り直してください。四択のまま、問題文・選択肢・正解・解説が確認できる3問をお願いします。全体の問題はまだ作りません。\n希望：${comment.trim()}`;
      if (await c.actions.sendPlanningMessage(plan.id,message)) { setComment('');setAttempted(false);move('samples'); }
    } finally { setLocalBusy(false); }
  }
  async function generate() {
    if (disabled || !complete || !volume.valid) return;
    setAttempted(true);setLocalBusy(true);
    try { if(await c.actions.generateProposal(plan.id,turn.id,proposal.id,volume.total,mode==='schedule'?{dailyQuestionTarget:daily,plannedDays:Number(days)}:undefined)){setAttempted(false);onGenerated();} }
    finally{setLocalBusy(false);}
  }
  return <article ref={top} className={`panel ${styles.card}`}>
    <div className={styles.steps} aria-label="問題作成の段階"><span className={stage!=='quantity'?styles.current:''}>1 · 試作で調整</span><ArrowRight size={13}/><span className={stage==='quantity'?styles.current:''}>2 · 分量を決める</span></div>
    <div className={styles.heading}><span className="subject-badge">{proposal.subject}</span><small>四択</small></div>
    <h2>{stage==='quantity'?'この作り方で、どれくらい作る？':stage==='adjust'?'出し方を、もう少し調整する。':'サンプルを確認'}</h2>
    <details className={styles.answer}><summary>出題内容・難しさ</summary><strong>{proposal.title}</strong><p>難しさ：{proposal.difficulty}</p>{proposal.description&&<p>{proposal.description}</p>}</details>
    {c.demo&&<p className={styles.demo}>操作確認用の例題です。AIへの送信はなく、入力した希望で問題内容は変わりません。</p>}
    {stage==='samples'&&<>
      {!complete ? <><p className={styles.note}>この案には試作がまだありません。先に3問で出し方と難しさを確かめます。</p>{own&&<button type="button" className="button primary" disabled={disabled} onClick={()=>void revise(true)}><Sparkles size={17}/>この案の試作3問を作る</button>}</> : <>
        <div ref={sampleTop} className={styles.pager}><button type="button" aria-label="前の試作問題" disabled={index===0} onClick={()=>selectSample(Math.max(0,index-1))}><ChevronLeft size={20}/></button><strong>試作 {index+1} / 3</strong><button type="button" aria-label="次の試作問題" disabled={index===2} onClick={()=>selectSample(Math.min(2,index+1))}><ChevronRight size={20}/></button></div>
        <div key={`${turn.id}:${index}`} className={styles.sample}>{sample.needsReview&&<p className={styles.uncertain}>資料の読み取りや答えに、確認が必要な点があります。根拠を見て、気になる点は「調整する」から伝えられます。</p>}<h3>{sample.prompt}</h3><ol>{sample.choices.map((choice,i)=><li key={i}><span>{String.fromCharCode(65+i)}</span><p>{choice}</p></li>)}</ol><details className={styles.answer}><summary>正解・解説を見る</summary><strong>正解：{String.fromCharCode(65+sample.correctIndex)}. {sample.choices[sample.correctIndex]}</strong><p>{sample.explanation}</p>{sample.learningPoint&&<p className={styles.learningPoint}>覚えるポイント：{sample.learningPoint}</p>}{sample.sourceNote&&<div className={styles.sourceNote}><strong>作問の根拠</strong><p>{sample.sourceNote}</p></div>}</details></div>
        {comment.trim()&&<p className={styles.note}>入力中の希望はまだ反映されていません。「調整する」から送信するか、コメントを消すと次へ進めます。</p>}
        {own&&<div className={styles.actions}><button key="adjust" type="button" className="button secondary" disabled={disabled} onClick={()=>move('adjust')}><MessageCircle size={16}/>調整する</button><button key="accept-samples" type="button" className="button primary" disabled={disabled||!!comment.trim()} onClick={event=>{event.preventDefault();move('quantity');}}>この3問で進む<ArrowRight size={16}/></button></div>}
      </>}
    </>}
    {stage==='adjust'&&<>
      <p className={styles.note}>サンプルのどこを変えたいか伝えてください。変更後の3問を見てから、まとめて作成できます。</p>
      <div className={styles.quickComments}>{['現代語訳を隠す','穴埋め中心','文脈から意味を選ぶ','少し難しく','解説を短めに'].map(text=><button type="button" key={text} disabled={disabled} onClick={()=>setComment(previous=>previous.includes(text)?previous:previous?`${previous}\n${text}`:text)}>{text}</button>)}</div>
      <label className={styles.field}>変えたいところ<textarea value={comment} onChange={event=>setComment(event.target.value)} disabled={disabled} rows={3} maxLength={2000} placeholder="例：現代語訳を問題文に出さず、助詞の意味を文脈から選びたい"/></label>
      <p className={styles.note}>四択で答える形式です。意味・空欄・文脈・訳の選び方を調整できます。</p>
      <div className={styles.actions}><button key="back-samples" type="button" className="button secondary" disabled={localBusy} onClick={()=>move('samples')}><ArrowLeft size={16}/>試作に戻る</button><button key="revise-samples" type="button" className="button primary" disabled={disabled||!comment.trim()} onClick={()=>void revise()}><RefreshCw size={16}/>希望を反映して3問</button></div>
    </>}
    {stage==='quantity'&&<>
      <p className={styles.accepted}><Check size={16}/>いま見た3問の出し方・難しさで作ります。</p>
      <div className={styles.volumeMode} role="group" aria-label="問題数の決め方"><button type="button" aria-pressed={mode==='total'} onClick={()=>setMode('total')} disabled={disabled}>総数で決める</button><button type="button" aria-pressed={mode==='schedule'} onClick={()=>setMode('schedule')} disabled={disabled}>日数 × 1日の問題数</button></div>
      {mode==='total'?<div className={styles.counts} role="group" aria-label="新しく作る問題数">{[10,30,100,200,300].map(count=><button type="button" key={count} aria-pressed={total===count} disabled={disabled} onClick={()=>setTotal(count)}>{count}問</button>)}</div>:<div className={styles.schedule}><label className={styles.field}>何日分？<input type="number" inputMode="numeric" min={1} max={300} value={days} onChange={event=>setDays(event.target.value)} disabled={disabled}/></label><label className={styles.field}>1日何問？<select value={daily} onChange={event=>setDaily(Number(event.target.value))} disabled={disabled}>{[5,10,15,20].map(count=><option key={count} value={count}>{count}問</option>)}</select></label></div>}
      <div className={styles.total} role="status">{volume.valid?<><strong>新しく {volume.total}問</strong><span>{mode==='schedule'?`${days}日 × 1日${daily}問`:'1回10問を目安に、自分のペースで'}</span></>:<span>{volume.message}</span>}</div>
      {mode==='schedule'&&<p className={styles.note}>日数は作る分量の目安です。練習は1回10問ずつで、途中で終えても回答は残ります。</p>}
      <p className={styles.note}>試作の3問はこの総数に含みません。下のボタンで初めてまとめて作成します。最大300問、保存した分から練習できます。</p>
      <div className={styles.actions}><button key="back-before-generate" type="button" className="button secondary" disabled={localBusy} onClick={()=>move('samples')}><ArrowLeft size={16}/>3問に戻る</button><button key="generate-bulk" type="button" className="button primary" disabled={disabled||!complete||!volume.valid} onClick={()=>void generate()}><Sparkles size={16}/>{localBusy?'依頼を保存しています':volume.valid?`この形式で新しく${volume.total}問作る`:'分量を選んでください'}</button></div>
    </>}
    {blockedAction&&<div className={styles.blocked}><p>{blockedAction.message}</p><button type="button" className="text-button" onClick={blockedAction.run}>{blockedAction.label}<ArrowRight size={15}/></button></div>}
    {(localBusy||c.busy)&&<p className={styles.note} role="status">依頼を保存しています。重ねて送らず、このままお待ちください。</p>}
    {attempted&&c.error&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{c.error}</span></div>}
  </article>;
}
