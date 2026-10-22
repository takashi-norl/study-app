'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, CircleHelp, FileImage, FileText, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Sparkles, Target, Upload } from 'lucide-react';
import type { LearningPlan, PlanningProposal, PlanningTurn, SourceDocument } from '@/lib/types';
import type { StudyController, UploadStatus } from './controller';
import { PRACTICE_CATEGORIES, QUESTION_COUNTS, LEVEL_OPTIONS, PURPOSE_OPTIONS, SCHEDULE_OPTIONS, DAILY_MINUTES, questionVolumeLabel, buildQuickStart } from '@/lib/quick-start';
import styles from './planning-flow.module.css';

const dateLabel = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(date));
const compactVolumeLabel = (count: number) => questionVolumeLabel(count).split('（')[0];
const targetLabel = (date?: string) => date ? date.replaceAll('-', '/') : '期限は相談して決める';
function showSection(element: HTMLElement | null) { if (element?.getClientRects().length) element.scrollIntoView({block:'start'}); }

export function UploadFeedback({ status }: { status: UploadStatus | null }) {
  if (!status) return null;
  const pending = status.phase !== 'complete' && status.phase !== 'failed';
  return <div className={`upload-feedback ${status.phase}`} role={status.phase === 'failed' ? 'alert' : 'status'}>
    <div className="upload-feedback-heading">{pending ? <LoaderCircle size={18} className="spin" /> : status.phase === 'failed' ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}<strong>{status.phase === 'failed' ? 'アップロードを中断しました' : status.phase === 'complete' ? '教材の追加が完了しました' : `${status.current} / ${status.total}件目 · ${status.message}`}</strong></div>
    {status.phase !== 'complete' && <span className="upload-file-name">{status.fileName}</span>}
    {pending ? <><div className="progress-track" role="progressbar" aria-label="保存した教材の数" aria-valuenow={status.completed} aria-valuemin={0} aria-valuemax={status.total}><span style={{ width: `${status.completed / status.total * 100}%` }} /></div><p>{status.completed} / {status.total}件を保存済みです。この画面を開いたままお待ちください。</p></> : <><p>{status.message}</p>{status.phase === 'failed' && <p>保存を確認できた教材は{status.completed}件です。下の一覧にない教材だけ選び直してください。</p>}{status.phase === 'complete' && <p>次は、使う教材を一覧で選んで問題づくりへ進めます。</p>}</>}
  </div>;
}

function SourceRows({ sources, selected, onChange, disabled }: { sources: SourceDocument[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  return <div className="planning-source-rows">{[...sources].reverse().map(source => <div className="source-row" key={source.id}>
    <input type="checkbox" className="source-pick" checked={selected.includes(source.id)} disabled={disabled || (!selected.includes(source.id) && selected.length >= 20)} onChange={event => onChange(event.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id))} aria-label={`${source.name}を選ぶ`} />
    {source.mimeType === 'application/pdf' ? <FileText size={20} /> : <FileImage size={20} />}<span>{source.name}<small>{dateLabel(source.createdAt)}</small></span>
    {source.previewUrl && <a className="text-button" href={source.previewUrl} target="_blank" rel="noreferrer">原本<ArrowRight size={14} /></a>}
  </div>)}</div>;
}

export function SourceBank({ c, onConsult }: { c: StudyController; onConsult: (ids: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const sources = c.data.sources.filter(source => c.profile.role === 'parent' || source.ownerId === c.profile.id);
  const selection = selected.filter(id => sources.some(source => source.id === id));
  const status = c.uploadStatus && !c.uploadStatus.topicId ? c.uploadStatus : null;
  const uploading = !!status && status.phase !== 'complete' && status.phase !== 'failed';
  function upload(files: File[]) { if (!c.busy && files.length) void c.actions.uploadSources(undefined, files); }
  return <div className={`source-bank ${styles.sourceBank}`}>
    <section className="panel">
      <div className="panel-heading"><div><h2>教材を、先に保存しておこう。</h2><p>写真やPDFは、何度でも別の問題づくりに使えます。問題集の作成は後からで大丈夫です。</p></div></div>
      <div className={`upload-zone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); upload(Array.from(event.dataTransfer.files)); }}>
        <span className="upload-symbol"><Upload size={25} /></span><h3>写真・PDFを教材ストックへ</h3><p>教科書、ノート、問題集などを選んでください。</p>
        <button className="button secondary" disabled={c.busy} onClick={() => input.current?.click()}>{uploading ? <Upload size={17} /> : <Plus size={17} />}{uploading ? '保存しています' : '写真・PDFを選ぶ'}</button>
        <small>一度に20件まで・PDFは1件10MBまで</small><input ref={input} className="sr-only" type="file" multiple disabled={c.busy} accept="image/*,application/pdf" aria-label="教材ストックに写真やPDFを追加" onChange={event => { upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <UploadFeedback status={status} />
      </div>
      <div className="source-bank-content"><div className="planning-section-heading"><h3>保存した教材 <span>{sources.length}件</span></h3><span>{selection.length} / 20件を選択</span></div>
        {sources.length ? <div className={styles.sourceList}><SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={c.busy} /></div> : <p className="planning-empty">まだ教材がありません。教材を使わず、目標だけで学習相談を始めることもできます。</p>}
        <div className={`planning-actions ${styles.sourceAction}`}><span>{selection.length ? `${selection.length}件を選択中` : '教材なしでも作れます'}</span><button className="button primary" disabled={c.busy} onClick={() => onConsult(selection)}><MessageCircle size={17} />{selection.length ? 'この教材で問題を作る' : '教材なしで問題を作る'}<ArrowRight size={16} /></button></div>
        <p className="under-note">保存だけではAIは動きません。「この内容で提案して」を押したときに、選んだ教材と希望をAIへ送ります。</p>
      </div>
    </section>
  </div>;
}

export default function Planning({ c, initialSourceIds, initialRequest, review, openTopic, onBack, onLocationChange }: { c: StudyController; initialSourceIds?: string[]; initialRequest: number; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void; onBack?: () => void; onLocationChange?: (label:string) => void }) {
  const top = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [screen, setScreen] = useState<'list'|'new'|'plan'|'sources'>(initialSourceIds ? 'new' : 'list');
  const [hasDraft, setHasDraft] = useState(!!initialSourceIds);
  const [savingDraft, setSavingDraft] = useState(false);
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  const [creationKey, setCreationKey] = useState(0);
  const [sourceIds, setSourceIds] = useState<string[]>(initialSourceIds ?? []);
  const plans = c.data.plans.filter(item => c.profile.role === 'parent' || item.ownerId === c.profile.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const uploading = !!c.uploadStatus && !['complete','failed'].includes(c.uploadStatus.phase);
  const navigationBusy = uploading || savingDraft;
  useEffect(() => { if (initialSourceIds) { setSourceIds(initialSourceIds); setHasDraft(true); setScreen('new'); setCreationKey(value => value + 1); } }, [initialRequest]);
  useEffect(() => { showSection(top.current); }, [screen, activeId, initialRequest]);
  useEffect(() => { if(screen==='list')onLocationChange?.('問題を作る');else if(screen==='sources')onLocationChange?.('教材ストック'); }, [screen,onLocationChange]);
  function newConsultation(ids: string[] = []) { setSourceIds(ids); setHasDraft(true); setScreen('new'); setCreationKey(value => value + 1); }
  function openPlan(id:string) { setActiveId(id); setVisitedIds(current=>current.includes(id) ? current : [...current,id]); setScreen('plan'); }
  return <div ref={top} className={styles.flow}>
    <div className={styles.navigation}>
      {screen === 'list' ? onBack && <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={17} />ホームへ</button>
        : <button type="button" className="text-button" disabled={navigationBusy} onClick={()=>setScreen('list')}><ArrowLeft size={17} />学習プラン一覧へ</button>}
      {screen === 'new' && <span>選択はこの画面内に保持<br/>再読み込みすると消えます</span>}
    </div>
    <div hidden={screen !== 'list'} className={styles.screen}>
      <div className="page-heading"><div><p className="eyebrow">YOUR NEXT STEP</p><h1>問題を作る</h1><p className="page-description">条件を選ぶ → 提案を確認 → 問題を作成。</p></div></div>
      <section className={`panel ${styles.startCard}`}><div><Sparkles size={24} /><h2>{hasDraft ? '選んだところから、続きを。' : '4つのステップで、自分に合う問題を。'}</h2><p>タイトルの入力は不要です。最後に内容を確認してからAIに依頼します。</p></div>
        <button type="button" className="button primary" disabled={navigationBusy} onClick={()=>hasDraft ? setScreen('new') : newConsultation()}>{hasDraft ? '選択の続きをする' : '新しく作る'}<ArrowRight size={17} /></button>
        <div className={styles.listActions}>{hasDraft && <button type="button" className="text-button" disabled={navigationBusy} onClick={()=>newConsultation()}>選択をリセットして作り直す</button>}<button type="button" className="text-button" disabled={navigationBusy} onClick={()=>setScreen('sources')}><BookOpen size={16} />教材ストックを見る</button></div>
      </section>
      <div className={styles.listHeading}><h2>保存した学習プラン</h2><span>{plans.length}件</span></div>
      <div className={styles.planList}>{plans.map(item=>{
        const owner=c.data.profiles.find(profile=>profile.id===item.ownerId);
        const jobs=c.data.jobs.filter(job=>job.planId===item.id);
        const completed=jobs.reduce((count,job)=>count+job.generatedCount,0);
        const pending=jobs.some(job=>job.status==='queued'||job.status==='running') || c.data.planningTurns.some(turn=>turn.planId===item.id&&(turn.status==='queued'||turn.status==='running'));
        return <button type="button" key={item.id} className={styles.planRow} disabled={navigationBusy} onClick={()=>openPlan(item.id)}><span className="subject-badge">{item.subject}</span><strong>{item.title}</strong><span>{item.testOnly ? 'テスト用 · ' : ''}{owner?.name || '自分'}{completed ? ` · ${completed}問` : ''}</span><small>{pending ? 'AIの処理が進行中' : completed ? '作った問題を確認する' : '提案・相談を続ける'}</small><ArrowRight size={18} /></button>;
      })}</div>
      {!plans.length && <p className="planning-empty">まだプランはありません。「新しく作る」から始められます。</p>}
    </div>
    <div hidden={screen !== 'sources'} className={styles.screen}><SourceBank c={c} onConsult={newConsultation} /></div>
    <div hidden={screen !== 'new'} className={styles.screen}><NewPlan key={`new-${creationKey}`} c={c} sourceIds={sourceIds} active={screen==='new'} onLocationChange={onLocationChange} savingChanged={setSavingDraft} cancel={()=>setScreen('list')} created={id=>{setHasDraft(false);openPlan(id);}} /></div>
    {plans.filter(item=>visitedIds.includes(item.id)).map(plan=><div key={plan.id} hidden={screen !== 'plan' || activeId !== plan.id} className={styles.screen}><PlanConversation c={c} plan={plan} active={screen==='plan'&&activeId===plan.id} onLocationChange={onLocationChange} onOpenPlan={openPlan} onList={()=>setScreen('list')} review={review} openTopic={openTopic} /></div>)}
    {screen === 'plan' && !plans.some(plan=>plan.id===activeId) && <p role="status" className="planning-empty">学習プランを開いています。</p>}
  </div>;
}

function NewPlan({ c, sourceIds: initialIds, created, cancel, savingChanged, active, onLocationChange }: { c: StudyController; sourceIds: string[]; created: (id: string) => void; cancel?: () => void; savingChanged: (saving: boolean) => void; active: boolean; onLocationChange?: (label:string)=>void }) {
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(active)onLocationChange?.(`問題を作る · ${step+1}/4`);},[step,active,onLocationChange]);
  const [subject, setSubject] = useState<string>(PRACTICE_CATEGORIES[0].subject);
  const [materialMode, setMaterialMode] = useState<'ai' | 'sources'>(initialIds.length ? 'sources' : 'ai');
  const [purpose, setPurpose] = useState('日々の練習');
  const [schedule, setSchedule] = useState('1か月');
  const [minutesPerDay, setMinutesPerDay] = useState(10);
  const [examTarget, setExamTarget] = useState('準1級');
  const [focus, setFocus] = useState<string>(PRACTICE_CATEGORIES[0].focusOptions[0]);
  const [difficulty, setDifficulty] = useState<string>(LEVEL_OPTIONS[0]);
  const [totalQuestions, setTotalQuestions] = useState(100);
  const [comment, setComment] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [testOnly, setTestOnly] = useState(false);
  const [selected, setSelected] = useState(initialIds);
  const [materialsOpen, setMaterialsOpen] = useState(initialIds.length === 0);
  const [localBusy, setLocalBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploadSelection = useRef<{ before: Set<string>; ownerId: string; finished: boolean } | null>(null);
  const [uploadFinished, setUploadFinished] = useState(0);
  const sources = c.data.sources.filter(source => c.profile.role === 'parent' || source.ownerId === c.profile.id);
  const selection = selected.filter(id => sources.some(source => source.id === id));
  const category = PRACTICE_CATEGORIES.find(item => item.subject === subject) ?? PRACTICE_CATEGORIES[0];
  const disabled = c.busy || localBusy;
  const needsSources = materialMode === 'sources' && !selection.length;
  const uploadStatus = c.uploadStatus && !c.uploadStatus.topicId ? c.uploadStatus : null;
  useEffect(() => {
    const pending = uploadSelection.current;
    if (!pending) return;
    if (pending.ownerId !== c.profile.id) { uploadSelection.current = null; return; }
    const added = c.data.sources.filter(source => source.ownerId === pending.ownerId && !pending.before.has(source.id)).map(source => source.id);
    if (added.length) setSelected(current => {
      const next = [...new Set([...current, ...added])].slice(0, 20);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
    if (pending.finished) uploadSelection.current = null;
  }, [c.data.sources, c.profile.id, uploadFinished]);
  async function upload(files: File[]) {
    if (disabled || !files.length || uploadSelection.current) return;
    uploadSelection.current = { before: new Set(c.data.sources.map(source => source.id)), ownerId: c.profile.id, finished: false };
    try { await c.actions.uploadSources(undefined, files); }
    finally {
      if (uploadSelection.current) uploadSelection.current.finished = true;
      setUploadFinished(value => value + 1);
    }
  }
  function changeStep(next: number) { setStep(next); requestAnimationFrame(() => { showSection(stepHeading.current); if(stepHeading.current?.getClientRects().length) stepHeading.current.focus({preventScroll:true}); }); }
  async function save(consult: boolean) {
    if (disabled || needsSources) return;
    setLocalBusy(true);
    savingChanged(true);
    try {
      const input = buildQuickStart({ subject, materialMode, focus, difficulty, totalQuestions, sourceIds: selection, comment: comment.trim(), targetDate: targetDate || undefined, purpose, schedule, minutesPerDay, examTarget: purpose === '英検' ? examTarget : undefined });
      const id = await c.actions.createPlan({ ...input.plan, ...(c.profile.role === 'parent' && testOnly ? { testOnly: true } : {}) });
      if (!id) return;
      if (consult) await c.actions.sendPlanningMessage(id, input.message);
      created(id);
    } finally { setLocalBusy(false); savingChanged(false); }
  }
  const stepTitles = ['科目と目的を選ぶ', '教材と練習内容を選ぶ', 'ペースと分量を決める', '内容を確認して提案をもらう'];
  return <section className={`panel ${styles.wizard}`}>
    <header className={styles.stepHeader}><div className={styles.stepProgress} aria-label={`ステップ${step+1} / 4`}>{stepTitles.map((title,index)=><span key={title} className={index <= step ? styles.stepDone : ''} aria-current={index===step ? 'step' : undefined} />)}</div><p>ステップ {step+1} / 4</p><h1 ref={stepHeading} tabIndex={-1}>{stepTitles[step]}</h1></header>
    <form className={`planning-form ${styles.wizardForm}`} onSubmit={event=>{event.preventDefault();if(step===3) void save(true);else if(step!==1 || !needsSources) changeStep(step+1);}}>
      <div hidden={step!==0} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>科目</legend><div className="quick-choice-options">{PRACTICE_CATEGORIES.map(item=><button type="button" key={item.subject} className={subject===item.subject?'selected':''} aria-pressed={subject===item.subject} onClick={()=>{setSubject(item.subject);setFocus(item.focusOptions[0]);if(item.subject!=='英語'&&(purpose==='英検'||purpose==='IELTS'))setPurpose('日々の練習');}}>{item.subject}</button>)}</div></fieldset>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>何に向けて？</legend><div className="quick-choice-options">{PURPOSE_OPTIONS.map(item=><button type="button" key={item} className={purpose===item?'selected':''} aria-pressed={purpose===item} onClick={()=>{setPurpose(item);if(item==='英検'||item==='IELTS'){setSubject('英語');setFocus(item==='英検'?'英検対策':'おまかせ');}}}>{item}</button>)}</div></fieldset>
        {purpose==='英検'&&<fieldset className="quick-choice-group" disabled={disabled}><legend>目標の級</legend><div className="quick-choice-options">{['2級','準1級','1級'].map(item=><button type="button" key={item} className={examTarget===item?'selected':''} aria-pressed={examTarget===item} onClick={()=>setExamTarget(item)}>{item}</button>)}</div></fieldset>}
        {purpose==='IELTS'&&<p className={styles.hint}>目標スコアは、最後の確認画面で添えられます。</p>}
      </div>
      <div hidden={step!==1} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>問題のもと</legend><div className="quick-choice-options material-options"><button type="button" className={materialMode==='ai'?'selected':''} aria-pressed={materialMode==='ai'} onClick={()=>setMaterialMode('ai')}><Sparkles size={17}/><span>AIにおまかせ<small>教材なしで作る</small></span></button><button type="button" className={materialMode==='sources'?'selected':''} aria-pressed={materialMode==='sources'} onClick={()=>setMaterialMode('sources')}><BookOpen size={17}/><span>自分の教材<small>写真・PDFを使う</small></span></button></div></fieldset>
        {materialMode==='sources'&&<div className={styles.materialPicker}><div className="planning-section-heading"><strong>{selection.length} / 20件を選択</strong>{sources.length>0&&<button type="button" className="text-button" disabled={disabled} onClick={()=>setSelected(selection.length?[]:[...sources].reverse().slice(0,20).map(source=>source.id))}>{selection.length?'選択を解除':sources.length>20?'新しい20件を選ぶ':'すべて選ぶ'}</button>}</div>
          {sources.length>0?<details className={styles.materialDetails} open={materialsOpen} onToggle={event=>setMaterialsOpen(event.currentTarget.open)}><summary>保存した教材を選ぶ・変更する</summary><div className={styles.sourceList}><SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={disabled}/></div></details>:<p className={styles.hint}>ノートや教科書を撮影した写真、PDFを追加できます。</p>}
          <button type="button" className="button secondary" disabled={disabled} onClick={()=>input.current?.click()}><Upload size={16}/>写真・PDFを追加</button><input ref={input} className="sr-only" type="file" multiple disabled={disabled} accept="image/*,application/pdf" aria-label="相談で使う写真やPDFを追加" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(files.length)void upload(files);}}/><div className="upload-zone quick-upload-feedback"><UploadFeedback status={uploadStatus}/></div>
        </div>}
        <fieldset className="quick-choice-group" disabled={disabled}><legend>練習する内容</legend><div className="quick-choice-options">{category.focusOptions.map(item=><button type="button" key={item} className={focus===item?'selected':''} aria-pressed={focus===item} onClick={()=>setFocus(item)}>{item}</button>)}</div></fieldset>
        {needsSources&&<p className={styles.hint} role="status">使う教材を選ぶか、写真・PDFを追加してください。</p>}
      </div>
      <div hidden={step!==2} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>いつまで・どれくらい？</legend><div className="quick-choice-options">{SCHEDULE_OPTIONS.map(item=><button type="button" key={item} className={schedule===item?'selected':''} aria-pressed={schedule===item} onClick={()=>{setSchedule(item);if(item==='身につくまで')setTargetDate('');if(item==='あと1時間')setTotalQuestions(Math.min(totalQuestions,30));else if(item==='1か月')setTotalQuestions(100);}}>{item}</button>)}</div></fieldset>
        <div className={styles.controlGrid}>{schedule!=='あと1時間'&&<label>1日の目安<select disabled={disabled} value={minutesPerDay} onChange={event=>setMinutesPerDay(Number(event.target.value))}>{DAILY_MINUTES.map(value=><option key={value} value={value}>{value}分</option>)}</select></label>}<label>難しさ<select disabled={disabled} value={difficulty} onChange={event=>setDifficulty(event.target.value)}>{LEVEL_OPTIONS.map(value=><option key={value}>{value}</option>)}</select></label></div>
        <label>作る問題の分量<select disabled={disabled} value={totalQuestions} onChange={event=>setTotalQuestions(Number(event.target.value))}>{QUESTION_COUNTS.map(count=><option key={count} value={count}>{questionVolumeLabel(count)}</option>)}</select></label>
        <p className={styles.hint}>{schedule==='あと1時間'?'直前に押さえたい要点を優先し、まず10問から確認します。':schedule==='身につくまで'?'期限は決めず、別の日にも解けるかを確かめながら進めます。':'1回10問ずつ。時間があるときは、続けて練習できます。'}</p>
      </div>
      <div hidden={step!==3} className={styles.stepBody}>
        <dl className={styles.selectionSummary}><div><dt>科目・目的</dt><dd>{subject} · {purpose}{purpose==='英検'?` ${examTarget}`:''}</dd></div><div><dt>練習内容</dt><dd>{focus} · {difficulty}</dd></div><div><dt>教材</dt><dd>{materialMode==='sources'?`選んだ教材 ${selection.length}件`:'AIにおまかせ（教材なし）'}</dd></div><div><dt>期間・分量</dt><dd>{schedule}{schedule==='あと1時間'?'':` · 1日${minutesPerDay}分`}<br/>{questionVolumeLabel(totalQuestions)}</dd></div></dl>
        <label>ひとこと添える <span className="optional">任意</span><textarea disabled={disabled} value={comment} onChange={event=>setComment(event.target.value)} rows={2} maxLength={2000} placeholder="例：試験範囲に合わせて／単語を多めに"/></label>
        <details className={styles.extraOptions}><summary>目標日・その他の設定</summary>{schedule!=='身につくまで'&&<label>目標の日 <span className="optional">任意</span><input disabled={disabled} type="date" value={targetDate} onChange={event=>setTargetDate(event.target.value)}/></label>}{c.profile.role==='parent'&&<label className={styles.testToggle}><input type="checkbox" checked={testOnly} onChange={event=>setTestOnly(event.target.checked)} disabled={disabled}/><span>テスト用として作る<small>学習者には表示しません</small></span></label>}<button type="button" className="text-button" disabled={disabled||needsSources} onClick={()=>void save(false)}>AIに送らず、選択だけ保存</button></details>
        <p className={styles.hint}>まず提案を受け取り、気に入った案を選んでから問題を作ります。</p>
        {c.error&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{c.error}</span></div>}
        {needsSources&&<p className={styles.hint}>教材の選択を確認してください。</p>}
      </div>
      <div className={styles.stepActions}><button type="button" className="button secondary" disabled={disabled} onClick={()=>step>0?changeStep(step-1):cancel?.()}><ArrowLeft size={17}/>{step===0?'一覧へ':'戻る'}</button>{step<3?<button key="next-step" type="button" className="button primary" disabled={disabled||(step===1&&needsSources)} onClick={event=>{event.preventDefault();changeStep(step+1);}}>次へ<ArrowRight size={17}/></button>:<button key="request-proposal" type="submit" className="button primary" disabled={disabled||needsSources}>{localBusy?<LoaderCircle className="spin" size={17}/>:<Sparkles size={17}/>}この内容で提案して</button>}</div>
    </form>
  </section>;
}

function PlanConversation({ c, plan, review, openTopic, active, onLocationChange, onOpenPlan, onList }: { c: StudyController; plan: LearningPlan; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void; active:boolean; onLocationChange?:(label:string)=>void; onOpenPlan:(id:string)=>void; onList:()=>void }) {
  const [message, setMessage] = useState('');
  const [publishingTopic, setPublishingTopic] = useState<string | null>(null);
  const own = plan.ownerId === c.profile.id;
  const turns = c.data.planningTurns.filter(turn => turn.planId === plan.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const waiting = turns.some(turn => turn.status === 'queued' || turn.status === 'running');
  const pending = [...turns].reverse().find(turn=>turn.status==='queued'||turn.status==='running');
  const latest = [...turns].reverse().find(turn => turn.status === 'complete');
  const newest = turns.at(-1);
  const topics = c.data.topics.filter(topic => topic.planId === plan.id);
  const jobs = c.data.jobs.filter(job => job.planId === plan.id || topics.some(topic => topic.id === job.topicId));
  const activeJob = c.data.jobs.find(job => job.status === 'queued' || job.status === 'running');
  const generating = !!activeJob;
  const activeJobPlanAvailable = !!activeJob?.planId && c.data.plans.some(item=>item.id===activeJob.planId);
  const owner = c.data.profiles.find(profile => profile.id === plan.ownerId);
  const [tab,setTab] = useState<'proposals'|'chat'|'questions'>(jobs.length||plan.libraryTopicId?'questions':'proposals');
  const [proposalIndex,setProposalIndex] = useState(0);
  useEffect(()=>{if(active)onLocationChange?.(`学習プラン · ${{proposals:'提案',chat:'相談',questions:'できた問題'}[tab]}`);},[active,tab,onLocationChange]);
  const sectionTop=useRef<HTMLDivElement>(null);
  const previousLatest=useRef(latest?.id);
  const proposals=latest?.proposals??[];
  const activeProposal=Math.min(proposalIndex,Math.max(0,proposals.length-1));
  const questionCount=jobs.reduce((count,job)=>count+job.generatedCount,0);
  function selectTab(next:'proposals'|'chat'|'questions') { setTab(next); requestAnimationFrame(()=>showSection(sectionTop.current)); }
  useEffect(()=>{if(latest?.id!==previousLatest.current){previousLatest.current=latest?.id;setProposalIndex(0);if(latest?.id)setTab('proposals');}},[latest?.id]);
  function consultAgain() { if(!message.trim())setMessage('保存した目標と教材に合わせて、新しい問題作成案を提案してください。作成が止まった問題の再開ではなく、改めて作る案を確認したいです。');selectTab('chat'); }
  const blockedAction = !own ? {message:'ここは閲覧用です。案の変更・作問は、このプランを作った本人が操作できます。',label:'相談の内容を見る',run:()=>selectTab('chat')}
    : waiting ? {message:'この相談への回答を待っています。新しい提案が届くまで作問はできません。',label:'相談の状況を見る',run:()=>selectTab('chat')}
    : activeJob ? {message:activeJob.planId===plan.id?'このプランの問題を作成しています。完了後に別の案も作れます。':`別の問題を作成しています（${activeJob.generatedCount} / ${activeJob.targetCount}問）。今はこの案を確認でき、作問はその処理が終わってから再開できます。`,label:activeJob.planId===plan.id||activeJobPlanAvailable?'作成状況を確認する':'学習プラン一覧へ',run:()=>{if(activeJob.planId===plan.id)selectTab('questions');else if(activeJob.planId&&activeJobPlanAvailable)onOpenPlan(activeJob.planId);else onList();}}
    : latest&&latest.version!==plan.version ? {message:'この案を出した後に相談が更新されました。最新の条件で再提案してから作成してください。',label:'最新の条件で相談する',run:()=>{if(!message.trim())setMessage('更新した条件に合わせて、改めて問題作成案を提案してください。');selectTab('chat');}} : undefined;
  async function send(event: FormEvent) { event.preventDefault(); if (!own||waiting||c.busy) return; if (message.trim() && await c.actions.sendPlanningMessage(plan.id, message)) {setMessage('');selectTab('proposals');} }
  function renderTurn(turn:PlanningTurn) { return <div className="conversation-turn" key={turn.id}><div className="chat-bubble user"><span>{owner?.name||'自分'} · {dateLabel(turn.createdAt)}</span>{turn.message.startsWith('この選択から、')?<details><summary>選んだ条件からの依頼</summary><p>{turn.message}</p></details>:<p>{turn.message}</p>}</div>{turn.status==='complete'?<div className="chat-bubble assistant"><span><Sparkles size={14}/>AIの回答{c.demo&&'（サンプル）'}</span><p>{turn.reply}</p>{turn.id!==latest?.id&&!!turn.proposals?.length&&<small>この回答の作問案は以前のものです。「提案」に最新の案があります。</small>}</div>:turn.status==='failed'?<div className="flash error" role="alert"><CircleHelp size={17}/><span>{turn.error||'回答を完了できませんでした。内容を確認して、もう一度相談できます。'}</span></div>:<p className={styles.hint}>返信を準備しています。</p>}</div>; }
  return <div className={styles.conversation}>
    <header className={styles.planHeader}><div><span className="subject-badge">{plan.subject}</span>{plan.testOnly&&<span className="count-pill">テスト用</span>}<h1>{plan.title}</h1><p>{owner?.name||'自分'}の学習プラン · 1回{plan.dailyQuestionTarget}問が目安</p></div>
      <details className={styles.planDetails}><summary>目標・教材などの条件を見る</summary><p>{plan.goal}</p><div className="plan-facts"><span><Target size={15}/>{targetLabel(plan.targetDate)}</span><span>教材{plan.sourceIds.length}件</span><span>{plan.difficulty}</span></div>{plan.sourceIds.length>0&&<ul>{plan.sourceIds.map(id=>{const source=c.data.sources.find(item=>item.id===id);return <li key={id}>{source?.previewUrl?<a href={source.previewUrl} target="_blank" rel="noreferrer">{source.name}</a>:source?.name||'保存済みの教材'}</li>;})}</ul>}</details>
      {!own&&<p className="planning-readonly">相談と問題を確認できます。返信・作問は本人のアカウントから行えます。</p>}
    </header>
    <div ref={sectionTop} className={styles.detailTop}>
      <div className={styles.detailTabs} role="tablist" aria-label="学習プランの表示">{([{id:'proposals',label:'提案',count:proposals.length},{id:'chat',label:'相談',count:turns.length},{id:'questions',label:'できた問題',count:questionCount}] as const).map(item=><button key={item.id} id={`plan-tab-${plan.id}-${item.id}`} type="button" role="tab" aria-selected={tab===item.id} aria-controls={`plan-panel-${plan.id}-${item.id}`} onClick={()=>selectTab(item.id)}>{item.label}<span>{item.count}</span></button>)}</div>
      {pending&&<div className={styles.pending} role="status"><LoaderCircle className="spin" size={19}/><div><strong>提案を考えています</strong><p>回答は保存されます。ほかの画面に移っても大丈夫です。</p>{own&&<button type="button" className="text-button" disabled={c.busy} onClick={()=>void c.actions.resumePlanningTurn(pending.id)}><RefreshCw size={14}/>進まない場合は再開</button>}</div></div>}
      {!pending&&newest?.status==='failed'&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{newest.error||'回答を完了できませんでした。'}<button type="button" className="text-button" onClick={()=>selectTab('chat')}>相談内容を見直す<ArrowRight size={14}/></button></span></div>}
    </div>
    <div id={`plan-panel-${plan.id}-proposals`} aria-labelledby={`plan-tab-${plan.id}-proposals`} role="tabpanel" hidden={tab!=='proposals'} className={styles.screen}>
      {!!proposals.length&&latest?<>
        <div className={styles.nextStep}><strong>次は、気に入った案から問題を作成。</strong><p>案を選んで内容を確認し、「この案で作る」を押してください。</p></div>
        {latest.version!==plan.version&&<p className={styles.hint}>相談内容が更新されています。最新の回答を待つか、「相談」から案を調整してください。</p>}
        {proposals.length>1&&<div className={styles.proposalPicker} aria-label="問題作成案を選ぶ">{proposals.map((proposal,index)=><button type="button" key={proposal.id} aria-pressed={activeProposal===index} onClick={()=>setProposalIndex(index)}><span>案 {index+1}</span><strong>{proposal.title}</strong></button>)}</div>}
        {proposals.map((proposal,index)=><div key={`${latest.id}:${proposal.id}`} hidden={activeProposal!==index} className={styles.screen}><ProposalCard c={c} plan={plan} turn={latest} proposal={proposal} canGenerate={own&&!waiting&&!generating&&latest.version===plan.version} onGenerated={()=>selectTab('questions')} blockedAction={blockedAction}/></div>)}
        {latest.reply&&<details className={styles.replyDetails}><summary>AIの説明・学習の進め方を見る</summary><p>{latest.reply}</p></details>}
        {own&&<p className={styles.hint}>{plan.testOnly?'テスト用の問題は保護者だけが試せます。あとでライブラリに公開できます。':c.profile.role==='student'?'自分で作った問題はすぐ練習できます。保護者も内容と記録を確認できます。':'作成後、内容を確認してから学習者へ公開できます。'}</p>}
      </>:!pending&&<section className={`panel ${styles.emptyCard}`}><Sparkles size={25}/><h2>{latest?.reply?'AIからの回答を確認しよう。':'このプランの提案をもらおう。'}</h2>{latest?.reply?<p className={styles.clarificationReply}>{latest.reply}</p>:<p>条件は保存済みです。相談を送ると、作れる問題の案が届きます。</p>}{c.error&&!latest?.reply&&<p className={styles.stateError} role="alert">{c.error}</p>}{own?<button type="button" className="button primary" disabled={c.busy||waiting} onClick={()=>{if(!message.trim()&&!latest?.reply)setMessage('保存した目標と教材に合わせて、最初の問題作成案を提案してください。');selectTab('chat');}}>{latest?.reply?'回答・希望を伝える':'相談内容を確認して送る'}<ArrowRight size={16}/></button>:<p className={styles.hint}>返信は、このプランを作った本人のアカウントから行えます。</p>}</section>}
      {jobs.length>0&&<button type="button" className={`button secondary ${styles.wideAction}`} onClick={()=>selectTab('questions')}><BookOpen size={17}/>できた問題を確認する<ArrowRight size={16}/></button>}
    </div>
    <div id={`plan-panel-${plan.id}-chat`} aria-labelledby={`plan-tab-${plan.id}-chat`} role="tabpanel" hidden={tab!=='chat'} className={styles.screen}>
      <section className={`panel conversation-panel ${styles.chatPanel}`}>
        {own&&<form className="chat-composer" onSubmit={send}><label htmlFor={`message-${plan.id}`}>希望を伝えて、案を調整する</label><textarea id={`message-${plan.id}`} value={message} onChange={event=>setMessage(event.target.value)} disabled={waiting||c.busy} rows={3} maxLength={4000} placeholder="例：少し難しいので基礎から。まずは単語の意味を選ぶ問題にして"/><div className="chat-suggestions">{['もう少しやさしくして','別の聞き方の問題もほしい'].map(text=><button key={text} type="button" disabled={waiting||c.busy} onClick={()=>setMessage(text)}>{text}</button>)}</div>{c.error&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{c.error}</span></div>}<div className={styles.composerActions}><button type="button" className="text-button" onClick={()=>selectTab('proposals')}><ArrowLeft size={15}/>提案に戻る</button><button type="submit" className="button primary" disabled={c.busy||waiting||!message.trim()}>{c.busy?<LoaderCircle className="spin" size={17}/>:<Send size={17}/>}送信して提案をもらう</button></div></form>}
        <div className={styles.history}><h2>最近の相談</h2>{newest?renderTurn(newest):<p className="planning-empty">まだ相談はありません。ひとこと送って始められます。</p>}{turns.length>1&&<details className={styles.olderTurns}><summary>以前の相談 {turns.length-1}件を見る</summary><div className="conversation-turns">{turns.slice(0,-1).reverse().map(renderTurn)}</div></details>}</div>
      </section>
    </div>
    <div id={`plan-panel-${plan.id}-questions`} aria-labelledby={`plan-tab-${plan.id}-questions`} role="tabpanel" hidden={tab!=='questions'} className={styles.screen}>
      {plan.libraryTopicId&&own&&<section className={`panel ${styles.emptyCard}`}><BookOpen size={25}/><h2>ライブラリから追加した問題</h2><button type="button" className="button primary" disabled={c.busy} onClick={()=>openTopic(plan.libraryTopicId!)}>追加した問題を練習<ArrowRight size={16}/></button></section>}
    {!!jobs.length && <section className="panel planning-jobs"><h2>この相談から作った問題</h2>{jobs.map(job => {
      const topic = topics.find(item => item.id === job.topicId);
      const personal = !!job.audienceUserId || !!topic?.audienceUserId;
      const test = !!plan.testOnly || !!job.testOnly || !!topic?.testOnly;
      const practice = test && c.profile.role === 'parent' || personal && c.profile.role === 'student';
      const active = job.status === 'queued' || job.status === 'running';
      const published = c.data.topics.some(item => item.libraryPublished && item.librarySourceTopicId === job.topicId);
      return <article key={job.id}>
        <div><strong>{topic?.title || '作成中の問題集'}</strong><p>{active ? '問題を作成しています' : job.status === 'failed' ? '作成が途中で止まりました' : test ? 'テスト用・保護者のみ' : personal ? '自習用' : '下書きの確認待ち'} · {job.generatedCount} / {job.targetCount}問</p>{job.error && <p className="planning-job-error">{job.error}</p>}</div>
        {active ? <LoaderCircle size={18} className="spin" /> : job.generatedCount > 0 && <button className="button secondary" disabled={c.busy} onClick={() => practice ? openTopic(job.topicId) : review(job.topicId, personal)}>{test && c.profile.role === 'parent' ? '親だけで試す' : personal && c.profile.role === 'student' ? '練習する' : '内容を確認'}<ArrowRight size={15} /></button>}
        {test && c.profile.role === 'parent' && !active && job.generatedCount > 0 && <div className="job-recovery"><span>{published ? 'ライブラリに公開済みです。学習者が自分のプランに追加できます。' : '公開すると、学習者のライブラリに問題が表示されます。テストの相談・練習記録は公開されません。'}</span>{!published && <button type="button" className="button primary" disabled={c.busy} onClick={() => { setPublishingTopic(job.topicId); void c.actions.publishLibrary(job.topicId); }}><BookOpen size={15} />ライブラリに公開</button>}{publishingTopic === job.topicId && c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}</div>}
        {active && own && <div className="job-recovery"><span>画面を閉じても、処理は続きます。</span><button type="button" className="text-button" disabled={c.busy} onClick={() => void c.actions.resumeGeneration(job.id)}><RefreshCw size={14} />進まない場合は再開</button></div>}
      </article>;
    })}</section>}
      {!jobs.length&&!plan.libraryTopicId&&<section className={`panel ${styles.emptyCard}`}><BookOpen size={25}/><h2>問題はここにまとまります。</h2><p>「提案」で案を選ぶと、ここから練習・確認できます。</p><button type="button" className="button primary" onClick={()=>selectTab('proposals')}>提案を選ぶ<ArrowRight size={16}/></button></section>}
      {jobs.some(job=>job.status==='failed')&&<div className={styles.stateHelp}><p>終了した作成依頼は再開できません。保存できた問題はそのまま使えます。追加で作るときは、新しい案を相談してください。</p>{own&&<button type="button" className="text-button" onClick={consultAgain}>新しい案を相談する<ArrowRight size={16}/></button>}</div>}
    </div>
  </div>;
}

function ProposalCard({ c, plan, turn, proposal, canGenerate, onGenerated, blockedAction }: { c: StudyController; plan: LearningPlan; turn: PlanningTurn; proposal: PlanningProposal; canGenerate: boolean; onGenerated: () => void; blockedAction?: {message:string;label:string;run:()=>void} }) {
  const [count, setCount] = useState(proposal.targetCount);
  const [comment, setComment] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const own = plan.ownerId === c.profile.id;
  const options = [...new Set<number>([...QUESTION_COUNTS, proposal.targetCount])].sort((a, b) => a - b);
  const hasComment = !!comment.trim();
  const disabled = !canGenerate || c.busy || localBusy;
  async function revise() {
    if (!hasComment || disabled) return;
    setAttempted(true);
    setLocalBusy(true);
    try {
      const message = `「${proposal.title}」の案を、次のコメントに合わせて再提案してください。\n元の出題内容${proposal.instructions.length > 1400 ? '（抜粋）' : ''}：${proposal.instructions.slice(0, 1400)}\n希望の分量：${questionVolumeLabel(count)}（合計${count}問）\nコメント：${comment.trim()}\nまだ問題は作成せず、調整後の案を提示してください。`;
      if (await c.actions.sendPlanningMessage(plan.id, message)) { setComment(''); setAttempted(false); }
    } finally { setLocalBusy(false); }
  }
  return <article className={`panel proposal-card ${styles.proposalCard}`}><div className="planning-section-heading"><span className="subject-badge">{proposal.subject}</span><span>{proposal.difficulty} · 四択</span></div><h3>{proposal.title}</h3><p>{proposal.description}</p><details><summary>出題内容・アレンジ</summary><p>{proposal.instructions}</p></details>
    <div className="proposal-bottom"><label>作る分量<select value={count} disabled={disabled} onChange={event => setCount(Number(event.target.value))}>{options.map(value => <option key={value} value={value}>{compactVolumeLabel(value)}</option>)}</select></label>{own && <button className="button primary" disabled={disabled || hasComment} onClick={async () => { setAttempted(true); setLocalBusy(true); try { if (await c.actions.generateProposal(plan.id, turn.id, proposal.id, count)) { setAttempted(false); onGenerated(); } } finally { setLocalBusy(false); } }}><Sparkles size={17} />この案で作る</button>}</div>
    {blockedAction?<div className={styles.stateHelp}><p>{blockedAction.message}</p><button type="button" className="text-button" onClick={blockedAction.run}>{blockedAction.label}<ArrowRight size={15}/></button></div>:(c.busy||localBusy)&&<p className={styles.hint} role="status">依頼の保存状況を確認しています。重ねて送信せず、そのままお待ちください。</p>}
    {own && <details className={`proposal-comment ${styles.proposalComment}`}><summary>コメントで案を調整する <span>任意</span></summary><label htmlFor={`proposal-comment-${proposal.id}`}>変えたいところがあれば <span>任意</span></label><textarea id={`proposal-comment-${proposal.id}`} value={comment} onChange={event => setComment(event.target.value)} disabled={disabled} rows={2} maxLength={2000} placeholder="例：意味を選ぶだけでなく、文中の空欄を埋める問題もほしい" />{hasComment && <><p className="quick-choice-note">コメントを反映した案を確認してから、作成できます。</p><button type="button" className="button secondary" disabled={disabled} onClick={() => void revise()}>{localBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}コメントを反映して再提案</button></>}</details>}
    {hasComment && <p className={styles.hint}>コメントを入力中です。上の「コメントで案を調整する」から再提案を依頼してください。</p>}
    {attempted && c.error && <div className="flash error proposal-error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}
  </article>;
}
