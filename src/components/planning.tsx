'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, CircleHelp, FileImage, FileText, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Sparkles, Target, Upload } from 'lucide-react';
import type { GenerationJob, LearningPlan, PlanningTurn, Question, SourceDocument } from '@/lib/types';
import type { StudyController, UploadStatus } from './controller';
import { PlanningWait } from './planning-wait';
import { PlanningSamples } from './planning-samples';
import { SourceReadingEditor } from './source-reading-editor';
import { SetSharingActions } from './question-library';
import { isPracticeReadyQuestion, mayPracticeLibraryTopic } from '@/lib/library-policy';
import { PRACTICE_CATEGORIES, LEVEL_OPTIONS, SCHEDULE_OPTIONS, DAILY_MINUTES, KOBUN_QUESTION_STYLES, buildQuickStart, quickStartDefaults, purposeOptionsForSubject, type QuickStartPreset, type KobunQuestionStyle } from '@/lib/quick-start';
import styles from './planning-flow.module.css';

const dateLabel = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(date));
const targetLabel = (date?: string) => date ? date.replaceAll('-', '/') : '期限は相談して決める';
function showSection(element: HTMLElement | null) { if (element?.getClientRects().length) element.scrollIntoView({block:'start'}); }

export function latestGenerationJobs(jobs: GenerationJob[]) {
  const continued = new Set(jobs.flatMap(job => job.retryOfJobId ? [job.retryOfJobId] : []));
  // One pass handles an arbitrarily long retry chain without recursively following it.
  return jobs.filter(job => job.status !== 'failed' || !continued.has(job.id));
}

export function savedTopicQuestionCount(questions: Question[], topicIds: Iterable<string>) {
  const selected = new Set(topicIds);
  return new Set(questions.filter(question => selected.has(question.topicId)).map(question => question.id)).size;
}

export function UploadFeedback({ status }: { status: UploadStatus | null }) {
  if (!status) return null;
  const pending = status.phase !== 'complete' && status.phase !== 'failed';
  return <div className={`upload-feedback ${status.phase}`} role={status.phase === 'failed' ? 'alert' : 'status'}>
    <div className="upload-feedback-heading">{pending ? <LoaderCircle size={18} className="spin" /> : status.phase === 'failed' ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}<strong>{status.phase === 'failed' ? 'アップロードを中断しました' : status.phase === 'complete' ? '教材の追加が完了しました' : `${status.current} / ${status.total}件目 · ${status.message}`}</strong></div>
    {status.phase !== 'complete' && <span className="upload-file-name">{status.fileName}</span>}
    {pending ? <><div className="progress-track" role="progressbar" aria-label="保存した教材の数" aria-valuenow={status.completed} aria-valuemin={0} aria-valuemax={status.total}><span style={{ width: `${status.completed / status.total * 100}%` }} /></div><p>{status.completed} / {status.total}件を保存済みです。この画面を開いたままお待ちください。</p></> : <><p>{status.message}</p>{status.phase === 'failed' && <p>保存を確認できた教材は{status.completed}件です。下の一覧にない教材だけ選び直してください。</p>}{status.phase === 'complete' && <p>次は、使う教材を一覧で選んで問題づくりへ進めます。</p>}</>}
  </div>;
}

function SourceRows({ sources, selected, onChange, disabled, demo = false }: { sources: SourceDocument[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean; demo?: boolean }) {
  return <div className="planning-source-rows">{[...sources].reverse().map(source => <div className="source-row" key={source.id}>
    <input type="checkbox" className="source-pick" checked={selected.includes(source.id)} disabled={disabled || (!selected.includes(source.id) && selected.length >= 20)} onChange={event => onChange(event.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id))} aria-label={`${source.name}を選ぶ`} />
    {source.mimeType === 'application/pdf' ? <FileText size={20} /> : <FileImage size={20} />}<span>{source.name}<small>{dateLabel(source.createdAt)}</small></span>
    {source.previewUrl && <a className="text-button" href={source.previewUrl} target="_blank" rel="noreferrer">原本<ArrowRight size={14} /></a>}
    <SourceReadingEditor source={source} demo={demo} compact/>
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
        {sources.length ? <div className={styles.sourceList}><SourceRows demo={c.demo} sources={sources} selected={selection} onChange={setSelected} disabled={c.busy} /></div> : <p className="planning-empty">まだ教材がありません。教材を使わず、目標だけで学習相談を始めることもできます。</p>}
        <div className={`planning-actions ${styles.sourceAction}`}><span>{selection.length ? `${selection.length}件を選択中` : '教材なしでも作れます'}</span><button className="button primary" disabled={c.busy} onClick={() => onConsult(selection)}><MessageCircle size={17} />{selection.length ? 'この教材で問題を作る' : '教材なしで問題を作る'}<ArrowRight size={16} /></button></div>
        <p className="under-note">保存だけではAIは動きません。「この内容で3問を試作」を押したときに、選んだ教材と希望をAIへ送ります。</p>
      </div>
    </section>
  </div>;
}

export default function Planning({ c, initialSourceIds, initialPreset, initialRequest, requestedPlanId, review, openTopic, onBack, onLocationChange, onScreenChange, active = true }: { c: StudyController; initialSourceIds?: string[]; initialPreset?: QuickStartPreset; initialRequest: number; requestedPlanId?: string; active?: boolean; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void; onBack?: () => void; onLocationChange?: (label:string) => void; onScreenChange?: (screen: 'list'|'new'|'plan'|'sources') => void }) {
  const top = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [screen, setScreen] = useState<'list'|'new'|'plan'|'sources'>(initialSourceIds || initialPreset ? 'new' : 'list');
  const [hasDraft, setHasDraft] = useState(!!initialSourceIds || !!initialPreset);
  const [savingDraft, setSavingDraft] = useState(false);
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  const [creationKey, setCreationKey] = useState(0);
  const [sourceIds, setSourceIds] = useState<string[]>(initialSourceIds ?? []);
  const [preset, setPreset] = useState<QuickStartPreset | undefined>(initialPreset);
  const plans = c.data.plans.filter(item => c.profile.role === 'parent' || item.ownerId === c.profile.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const uploading = !!c.uploadStatus && !['complete','failed'].includes(c.uploadStatus.phase);
  const navigationBusy = uploading || savingDraft;
  useEffect(() => { if (requestedPlanId) { openPlan(requestedPlanId); } else if (initialSourceIds || initialPreset) { newConsultation(initialSourceIds ?? [], initialPreset); } }, [initialRequest]);
  useEffect(() => { if (active) showSection(top.current); }, [screen, activeId, initialRequest, active]);
  useEffect(() => { onScreenChange?.(screen); }, [screen, onScreenChange]);
  useEffect(() => { if(screen==='list')onLocationChange?.('問題を作る');else if(screen==='sources')onLocationChange?.('教材ストック'); }, [screen,onLocationChange]);
  function newConsultation(ids: string[] = [], nextPreset?: QuickStartPreset) { setSourceIds(ids); setPreset(nextPreset); setHasDraft(true); setScreen('new'); setCreationKey(value => value + 1); }
  function openPlan(id:string) { setActiveId(id); setVisitedIds(current=>current.includes(id) ? current : [...current,id]); setScreen('plan'); }
  return <div ref={top} className={styles.flow}>
    <div className={styles.navigation}>
      {screen === 'list' ? onBack && <button type="button" className="text-button" onClick={onBack}><ArrowLeft size={17} />ホームへ</button>
        : <button type="button" className="text-button" disabled={navigationBusy} onClick={()=>setScreen('list')}><ArrowLeft size={17} />問題づくり一覧へ</button>}
      {screen === 'new' && <span>選択はこの画面内に保持<br/>再読み込みすると消えます</span>}
    </div>
    <div hidden={screen !== 'list'} className={styles.screen}>
      <div className="page-heading"><div><p className="eyebrow">YOUR NEXT STEP</p><h1>問題を作る</h1><p className="page-description">条件を選ぶ → 3問で試す → 分量を決めて作る。</p></div></div>
      <section className={`panel ${styles.kobunStart}`}><div><span className="subject-badge">古文</span><h2>撮った教材から、古文の問題を。</h2><p>写真・PDFを選び、文脈・文法・敬語・現代語訳の出し方を3問で確かめます。</p></div><button type="button" className="button primary" disabled={navigationBusy} onClick={()=>newConsultation([], 'kobun-material')}><FileImage size={18}/>{hasDraft ? '選択をリセットして古文で作る' : '古文を教材から作る'}<ArrowRight size={17}/></button>{hasDraft&&<p className={styles.hint}>入力中の選択を残す場合は、下の「選択の続きをする」から再開できます。</p>}</section>
      <section className={`panel ${styles.startCard}`}><div><Sparkles size={24} /><h2>{hasDraft ? '選んだところから、続きを。' : '4つのステップで、自分に合う問題を。'}</h2><p>タイトルの入力は不要です。最後に内容を確認してからAIに依頼します。</p></div>
        <button type="button" className="button primary" disabled={navigationBusy} onClick={()=>hasDraft ? setScreen('new') : newConsultation()}>{hasDraft ? '選択の続きをする' : '新しく作る'}<ArrowRight size={17} /></button>
        <div className={styles.listActions}>{hasDraft && <button type="button" className="text-button" disabled={navigationBusy} onClick={()=>newConsultation()}>選択をリセットして作り直す</button>}<button type="button" className="text-button" disabled={navigationBusy} onClick={()=>setScreen('sources')}><BookOpen size={16} />教材ストックを見る</button></div>
      </section>
      <div className={styles.listHeading}><h2>保存した学習プラン</h2><span>{plans.length}件</span></div>
      <div className={styles.planList}>{plans.map(item=>{
        const owner=c.data.profiles.find(profile=>profile.id===item.ownerId);
        const jobs=c.data.jobs.filter(job=>job.planId===item.id);
        const completed=savedTopicQuestionCount(c.data.questions,[...c.data.topics.filter(topic=>topic.planId===item.id).map(topic=>topic.id),...jobs.map(job=>job.topicId),...(item.libraryTopicId?[item.libraryTopicId]:[])]);
        const pending=jobs.some(job=>job.status==='queued'||job.status==='running') || c.data.planningTurns.some(turn=>turn.planId===item.id&&(turn.status==='queued'||turn.status==='running'));
        return <button type="button" key={item.id} className={styles.planRow} disabled={navigationBusy} onClick={()=>openPlan(item.id)}><span className="subject-badge">{item.subject}</span><strong>{item.title}</strong><span>{item.testOnly ? 'テスト用 · ' : ''}{owner?.name || '自分'}{completed ? ` · ${completed}問` : ''}</span><small>{pending ? 'AIの処理が進行中' : completed ? '作った問題を確認する' : '提案・相談を続ける'}</small><ArrowRight size={18} /></button>;
      })}</div>
      {!plans.length && <p className="planning-empty">まだプランはありません。「新しく作る」から始められます。</p>}
    </div>
    <div hidden={screen !== 'sources'} className={styles.screen}><SourceBank c={c} onConsult={newConsultation} /></div>
    <div hidden={screen !== 'new'} className={styles.screen}><NewPlan key={`new-${creationKey}`} c={c} sourceIds={sourceIds} preset={preset} active={active && screen==='new'} onLocationChange={onLocationChange} savingChanged={setSavingDraft} cancel={()=>setScreen('list')} created={id=>{setHasDraft(false);openPlan(id);}} /></div>
    {plans.filter(item=>visitedIds.includes(item.id)).map(plan=><div key={plan.id} hidden={screen !== 'plan' || activeId !== plan.id} className={styles.screen}><PlanConversation notificationRequest={requestedPlanId === plan.id ? initialRequest : undefined} c={c} plan={plan} active={active && screen==='plan'&&activeId===plan.id} onLocationChange={onLocationChange} onOpenPlan={openPlan} onList={()=>setScreen('list')} review={review} openTopic={openTopic} /></div>)}
    {screen === 'plan' && !plans.some(plan=>plan.id===activeId) && <p role="status" className="planning-empty">学習プランを開いています。</p>}
  </div>;
}

function NewPlan({ c, sourceIds: initialIds, preset, created, cancel, savingChanged, active, onLocationChange }: { c: StudyController; sourceIds: string[]; preset?: QuickStartPreset; created: (id: string) => void; cancel?: () => void; savingChanged: (saving: boolean) => void; active: boolean; onLocationChange?: (label:string)=>void }) {
  const defaults = quickStartDefaults(preset, initialIds);
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(active)onLocationChange?.(`問題を作る · ${step+1}/4`);},[step,active,onLocationChange]);
  const [subject, setSubject] = useState<string>(defaults.subject);
  const [materialMode, setMaterialMode] = useState<'ai' | 'sources'>(defaults.materialMode);
  const [purpose, setPurpose] = useState('日々の練習');
  const [projectName, setProjectName] = useState('');
  const [schedule, setSchedule] = useState('1か月');
  const [minutesPerDay, setMinutesPerDay] = useState(10);
  const [examTarget, setExamTarget] = useState('準1級');
  const [focus, setFocus] = useState<string>(defaults.focus);
  const [kobunQuestionStyle, setKobunQuestionStyle] = useState<KobunQuestionStyle>('context');
  const [difficulty, setDifficulty] = useState<string>(LEVEL_OPTIONS[0]);
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
  const kobunStyle = KOBUN_QUESTION_STYLES.find(item=>item.id===kobunQuestionStyle)!;
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
      const input = buildQuickStart({ subject, materialMode, focus, difficulty, sourceIds: selection, comment: comment.trim(), targetDate: targetDate || undefined, purpose, schedule, minutesPerDay, examTarget: purpose === '英検' ? examTarget : undefined, kobunQuestionStyle: subject==='古文'?kobunQuestionStyle:undefined });
      const project = projectName.trim();
      const id = await c.actions.createPlan({ ...input.plan, ...(project ? { tags: [project], title: `${project}｜${subject}${focus === 'おまかせ' ? '' : `・${focus}`}`.slice(0, 150) } : {}), ...(c.profile.role === 'parent' && testOnly ? { testOnly: true } : {}) });
      if (!id) return;
      if (consult) await c.actions.sendPlanningMessage(id, input.message);
      created(id);
    } finally { setLocalBusy(false); savingChanged(false); }
  }
  const stepTitles = ['科目と目的を選ぶ', '教材と練習内容を選ぶ', 'ペースと難しさを選ぶ', '内容を確認して3問を試す'];
  return <section className={`panel ${styles.wizard}`}>
    <header className={styles.stepHeader}><div className={styles.stepProgress} aria-label={`ステップ${step+1} / 4`}>{stepTitles.map((title,index)=><span key={title} className={index <= step ? styles.stepDone : ''} aria-current={index===step ? 'step' : undefined} />)}</div><p>ステップ {step+1} / 4</p><h1 ref={stepHeading} tabIndex={-1}>{stepTitles[step]}</h1></header>
    <form className={`planning-form ${styles.wizardForm}`} onSubmit={event=>{event.preventDefault();if(step===3) void save(true);else if(step!==1 || !needsSources) changeStep(step+1);}}>
      <div hidden={step!==0} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>科目</legend><div className="quick-choice-options">{PRACTICE_CATEGORIES.map(item=><button type="button" key={item.subject} className={subject===item.subject?'selected':''} aria-pressed={subject===item.subject} onClick={()=>{setSubject(item.subject);setFocus(item.focusOptions[0]);if(item.subject!=='英語'&&(purpose==='英検'||purpose==='IELTS'))setPurpose('日々の練習');}}>{item.subject}</button>)}</div></fieldset>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>何に向けて？</legend><div className="quick-choice-options">{purposeOptionsForSubject(subject).map(item=><button type="button" key={item} className={purpose===item?'selected':''} aria-pressed={purpose===item} onClick={()=>{setPurpose(item);if(item==='英検'||item==='IELTS'){setSubject('英語');setFocus(item==='英検'?'英検対策':'おまかせ');}}}>{item}</button>)}</div></fieldset>
        <label>まとめるプロジェクト <span className="optional">任意</span><input disabled={disabled} value={projectName} onChange={event=>setProjectName(event.target.value)} maxLength={40} list="new-plan-projects" placeholder="例：2学期中間テスト"/><datalist id="new-plan-projects">{[...new Set(c.data.plans.filter(plan=>plan.ownerId===c.profile.id).flatMap(plan=>plan.tags??[]))].map(tag=><option key={tag} value={tag}/>)}</datalist></label><p className={styles.hint}>同じ名前のプランをまとめ、プロジェクト → 科目の順に進み具合を見られます。あとから変更もできます。</p>
        {purpose==='英検'&&<fieldset className="quick-choice-group" disabled={disabled}><legend>目標の級</legend><div className="quick-choice-options">{['2級','準1級','1級'].map(item=><button type="button" key={item} className={examTarget===item?'selected':''} aria-pressed={examTarget===item} onClick={()=>setExamTarget(item)}>{item}</button>)}</div></fieldset>}
        {purpose==='IELTS'&&<p className={styles.hint}>目標スコアは、最後の確認画面で添えられます。</p>}
      </div>
      <div hidden={step!==1} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>問題のもと</legend><div className="quick-choice-options material-options"><button type="button" className={materialMode==='ai'?'selected':''} aria-pressed={materialMode==='ai'} onClick={()=>setMaterialMode('ai')}><Sparkles size={17}/><span>AIにおまかせ<small>教材なしで作る</small></span></button><button type="button" className={materialMode==='sources'?'selected':''} aria-pressed={materialMode==='sources'} onClick={()=>setMaterialMode('sources')}><BookOpen size={17}/><span>自分の教材<small>写真・PDFを使う</small></span></button></div></fieldset>
        {materialMode==='sources'&&<div className={styles.materialPicker}><div className="planning-section-heading"><strong>{selection.length} / 20件を選択</strong>{sources.length>0&&<button type="button" className="text-button" disabled={disabled} onClick={()=>setSelected(selection.length?[]:[...sources].reverse().slice(0,20).map(source=>source.id))}>{selection.length?'選択を解除':sources.length>20?'新しい20件を選ぶ':'すべて選ぶ'}</button>}</div>
          {sources.length>0?<details className={styles.materialDetails} open={materialsOpen} onToggle={event=>setMaterialsOpen(event.currentTarget.open)}><summary>保存した教材を選ぶ・変更する</summary><div className={styles.sourceList}><SourceRows demo={c.demo} sources={sources} selected={selection} onChange={setSelected} disabled={disabled}/></div></details>:<p className={styles.hint}>ノートや教科書を撮影した写真、PDFを追加できます。</p>}
          <button type="button" className="button secondary" disabled={disabled} onClick={()=>input.current?.click()}><Upload size={16}/>写真・PDFを追加</button><input ref={input} className="sr-only" type="file" multiple disabled={disabled} accept="image/*,application/pdf" aria-label="相談で使う写真やPDFを追加" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';if(files.length)void upload(files);}}/><div className="upload-zone quick-upload-feedback"><UploadFeedback status={uploadStatus}/></div>
        </div>}
        <fieldset className="quick-choice-group" disabled={disabled}><legend>練習する内容</legend><div className="quick-choice-options">{category.focusOptions.map(item=><button type="button" key={item} className={focus===item?'selected':''} aria-pressed={focus===item} onClick={()=>setFocus(item)}>{item}</button>)}</div></fieldset>
        {subject==='古文'&&<fieldset className={`quick-choice-group ${styles.kobunChoices}`} disabled={disabled}><legend>どんな聞き方で練習する？</legend><div className="quick-choice-options">{KOBUN_QUESTION_STYLES.map(item=><button type="button" key={item.id} className={kobunQuestionStyle===item.id?'selected':''} aria-pressed={kobunQuestionStyle===item.id} onClick={()=>setKobunQuestionStyle(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div><p className={styles.hint}>必要な本文を問題に載せ、正解と訳の解説は答えを確認するときに読める形にします。教材が読めない箇所は推測で埋めません。</p></fieldset>}
        {needsSources&&<p className={styles.hint} role="status">使う教材を選ぶか、写真・PDFを追加してください。</p>}
      </div>
      <div hidden={step!==2} className={styles.stepBody}>
        <fieldset className="quick-choice-group" disabled={disabled}><legend>いつまで・どれくらい？</legend><div className="quick-choice-options">{SCHEDULE_OPTIONS.map(item=><button type="button" key={item} className={schedule===item?'selected':''} aria-pressed={schedule===item} onClick={()=>{setSchedule(item);if(item==='身につくまで')setTargetDate('');}}>{item}</button>)}</div></fieldset>
        <div className={styles.controlGrid}>{schedule!=='あと1時間'&&<label>1日の目安<select disabled={disabled} value={minutesPerDay} onChange={event=>setMinutesPerDay(Number(event.target.value))}>{DAILY_MINUTES.map(value=><option key={value} value={value}>{value}分</option>)}</select></label>}<label>難しさ<select disabled={disabled} value={difficulty} onChange={event=>setDifficulty(event.target.value)}>{LEVEL_OPTIONS.map(value=><option key={value}>{value}</option>)}</select></label></div>
        <p className={styles.hint}>{schedule==='あと1時間'?'直前に押さえたい要点を優先し、まず10問から確認します。':schedule==='身につくまで'?'期限は決めず、別の日にも解けるかを確かめながら進めます。':'1回10問ずつ。時間があるときは、続けて練習できます。'}</p>
      </div>
      <div hidden={step!==3} className={styles.stepBody}>
        <dl className={styles.selectionSummary}>{projectName.trim()&&<div><dt>プロジェクト</dt><dd>{projectName.trim()} → {subject}</dd></div>}<div><dt>科目・目的</dt><dd>{subject} · {purpose}{purpose==='英検'?` ${examTarget}`:''}</dd></div><div><dt>練習内容</dt><dd>{focus} · {difficulty}</dd></div>{subject==='古文'&&<div><dt>出題方法</dt><dd>{kobunStyle.label}<small className={styles.summaryNote}>本文の根拠・正解が一つか・誤答の理由を、試作3問で確認します。</small></dd></div>}<div><dt>教材</dt><dd>{materialMode==='sources'?`選んだ教材 ${selection.length}件`:'AIにおまかせ（教材なし）'}</dd></div><div><dt>期間・ペース</dt><dd>{schedule}{schedule==='あと1時間'?'':` · 1日${minutesPerDay}分`}</dd></div></dl>
        <label>ひとこと添える <span className="optional">任意</span><textarea disabled={disabled} value={comment} onChange={event=>setComment(event.target.value)} rows={2} maxLength={2000} placeholder="例：試験範囲に合わせて／単語を多めに"/></label>
        <details className={styles.extraOptions}><summary>目標日・その他の設定</summary>{schedule!=='身につくまで'&&<label>目標の日 <span className="optional">任意</span><input disabled={disabled} type="date" value={targetDate} onChange={event=>setTargetDate(event.target.value)}/></label>}{c.profile.role==='parent'&&<label className={styles.testToggle}><input type="checkbox" checked={testOnly} onChange={event=>setTestOnly(event.target.checked)} disabled={disabled}/><span>テスト用として作る<small>学習者には表示しません</small></span></label>}<button type="button" className="text-button" disabled={disabled||needsSources} onClick={()=>void save(false)}>AIに送らず、選択だけ保存</button></details>
        <p className={styles.hint}>提案とサンプル3問が届きます。出し方や難しさを確かめてから、まとめて作る分量を決めます。</p>
        {c.error&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{c.error}</span></div>}
        {needsSources&&<p className={styles.hint}>教材の選択を確認してください。</p>}
      </div>
      <div className={styles.stepActions}><button type="button" className="button secondary" disabled={disabled} onClick={()=>step>0?changeStep(step-1):cancel?.()}><ArrowLeft size={17}/>{step===0?'一覧へ':'戻る'}</button>{step<3?<button key="next-step" type="button" className="button primary" disabled={disabled||(step===1&&needsSources)} onClick={event=>{event.preventDefault();changeStep(step+1);}}>次へ<ArrowRight size={17}/></button>:<button key="request-proposal" type="submit" className="button primary" disabled={disabled||needsSources}>{localBusy?<LoaderCircle className="spin" size={17}/>:<Sparkles size={17}/>}この内容で3問を試作</button>}</div>
    </form>
  </section>;
}

function PlanConversation({ c, plan, review, openTopic, active, onLocationChange, onOpenPlan, onList, notificationRequest }: { c: StudyController; plan: LearningPlan; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void; active:boolean; onLocationChange?:(label:string)=>void; onOpenPlan:(id:string)=>void; onList:()=>void; notificationRequest?:number }) {
  const [message, setMessage] = useState('');
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<string | null>(null);
  const own = plan.ownerId === c.profile.id;
  const turns = c.data.planningTurns.filter(turn => turn.planId === plan.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const waiting = turns.some(turn => turn.status === 'queued' || turn.status === 'running');
  const pending = [...turns].reverse().find(turn=>turn.status==='queued'||turn.status==='running');
  const latest = [...turns].reverse().find(turn => turn.status === 'complete');
  const newest = turns.at(-1);
  const topics = c.data.topics.filter(topic => topic.planId === plan.id);
  const jobs = latestGenerationJobs(c.data.jobs.filter(job => job.planId === plan.id || topics.some(topic => topic.id === job.topicId)));
  const activeJob = c.data.jobs.find(job => job.status === 'queued' || job.status === 'running');
  const generating = !!activeJob;
  const activeJobPlanAvailable = !!activeJob?.planId && c.data.plans.some(item=>item.id===activeJob.planId);
  const owner = c.data.profiles.find(profile => profile.id === plan.ownerId);
  const [tab,setTab] = useState<'proposals'|'chat'|'questions'>(plan.arrangedFromTopicId&&!turns.length?'chat':waiting || notificationRequest ? 'proposals' : jobs.length||plan.libraryTopicId?'questions':'proposals');
  const [proposalIndex,setProposalIndex] = useState(0);
  useEffect(()=>{if(active)onLocationChange?.(`学習プラン · ${{proposals:'試作',chat:'相談',questions:'できた問題'}[tab]}`);},[active,tab,onLocationChange]);
  const sectionTop=useRef<HTMLDivElement>(null);
  const previousLatest=useRef(latest?.id);
  const proposals=latest?.proposals??[];
  const activeProposal=Math.min(proposalIndex,Math.max(0,proposals.length-1));
  const questionCount=savedTopicQuestionCount(c.data.questions,[...topics.map(topic=>topic.id),...jobs.map(job=>job.topicId),...(plan.libraryTopicId?[plan.libraryTopicId]:[])]);
  function selectTab(next:'proposals'|'chat'|'questions') { setTab(next); requestAnimationFrame(()=>showSection(sectionTop.current)); }
  useEffect(()=>{if(notificationRequest)selectTab(plan.arrangedFromTopicId&&!turns.length?'chat':'proposals');},[notificationRequest]);
  useEffect(()=>{if(latest?.id!==previousLatest.current){previousLatest.current=latest?.id;setProposalIndex(0);if(latest?.id)setTab('proposals');}},[latest?.id]);
  function consultAgain() { if(!message.trim())setMessage('保存した目標と教材をもとに、出題内容や難しさを変えた別の問題作成案を提案してください。');selectTab('chat'); }
  async function retry(jobId:string) { if(c.busy||retryingJob||generating)return;setRetryAttempt(jobId);setRetryingJob(jobId);try{await c.actions.retryGeneration(jobId);}finally{setRetryingJob(null);} }
  const blockedAction = !own ? {message:'ここは閲覧用です。案の変更・作問は、このプランを作った本人が操作できます。',label:'相談の内容を見る',run:()=>selectTab('chat')}
    : waiting ? {message:'この相談への回答を待っています。新しい提案が届くまで作問はできません。',label:'進み具合を見る',run:()=>selectTab('proposals')}
    : activeJob ? {message:activeJob.planId===plan.id?'このプランの問題を作成しています。完了後に別の案も作れます。':`別の問題を作成しています（${activeJob.generatedCount} / ${activeJob.targetCount}問）。今はこの案を確認でき、作問はその処理が終わってから再開できます。`,label:activeJob.planId===plan.id||activeJobPlanAvailable?'作成状況を確認する':'問題づくり一覧へ',run:()=>{if(activeJob.planId===plan.id)selectTab('questions');else if(activeJob.planId&&activeJobPlanAvailable)onOpenPlan(activeJob.planId);else onList();}}
    : latest&&latest.version!==plan.version ? {message:'この案を出した後に相談が更新されました。最新の条件で再提案してから作成してください。',label:'最新の条件で相談する',run:()=>{if(!message.trim())setMessage('更新した条件に合わせて、改めて問題作成案を提案してください。');selectTab('chat');}} : undefined;
  async function send(event: FormEvent) { event.preventDefault(); if (!own||waiting||c.busy) return; if (message.trim() && await c.actions.sendPlanningMessage(plan.id, message)) {setMessage('');selectTab('proposals');} }
  function renderTurn(turn:PlanningTurn) { return <div className="conversation-turn" key={turn.id}><div className="chat-bubble user"><span>{owner?.name||'自分'} · {dateLabel(turn.createdAt)}</span>{turn.message.startsWith('この選択から、')?<details><summary>選んだ条件からの依頼</summary><p>{turn.message}</p></details>:<p>{turn.message}</p>}</div>{turn.status==='complete'?<div className="chat-bubble assistant"><span><Sparkles size={14}/>AIの回答{c.demo&&'（サンプル）'}</span><p>{turn.reply}</p>{turn.id!==latest?.id&&!!turn.proposals?.length&&<small>この回答の作問案は以前のものです。「提案」に最新の案があります。</small>}</div>:turn.status==='failed'?<div className="flash error" role="alert"><CircleHelp size={17}/><span>{turn.error||'回答を完了できませんでした。内容を確認して、もう一度相談できます。'}</span></div>:<p className={styles.hint}>返信を準備しています。</p>}</div>; }
  return <div className={styles.conversation}>
    <header className={styles.planHeader}><div><span className="subject-badge">{plan.subject}</span>{plan.testOnly&&<span className="count-pill">テスト用</span>}<h1>{plan.title}</h1><p>{owner?.name||'自分'}の学習プラン · 1日{plan.dailyQuestionTarget}問が目安</p></div>
      <details className={styles.planDetails}><summary>目標・教材などの条件を見る</summary><p>{plan.goal}</p><div className="plan-facts"><span><Target size={15}/>{targetLabel(plan.targetDate)}</span><span>教材{plan.sourceIds.length}件</span><span>{plan.difficulty}</span></div>{plan.sourceIds.length>0&&<ul>{plan.sourceIds.map(id=>{const source=c.data.sources.find(item=>item.id===id);return <li key={id}>{source?.previewUrl?<a href={source.previewUrl} target="_blank" rel="noreferrer">{source.name}</a>:source?.name||'保存済みの教材'}</li>;})}</ul>}</details>
      {!own&&<p className="planning-readonly">相談と問題を確認できます。返信・作問は本人のアカウントから行えます。</p>}
    </header>
    <div ref={sectionTop} className={styles.detailTop}>
      <div className={styles.detailTabs} role="tablist" aria-label="学習プランの表示">{([{id:'proposals',label:'試作3問',count:proposals.length ? undefined : 0},{id:'chat',label:'相談',count:turns.length},{id:'questions',label:'できた問題',count:questionCount}] as const).map(item=><button key={item.id} id={`plan-tab-${plan.id}-${item.id}`} type="button" role="tab" aria-selected={tab===item.id} aria-controls={`plan-panel-${plan.id}-${item.id}`} onClick={()=>selectTab(item.id)}>{item.label}<span>{item.count}</span></button>)}</div>
      {!pending&&newest?.status==='failed'&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{newest.error||'回答を完了できませんでした。'}<button type="button" className="text-button" onClick={()=>selectTab('chat')}>相談内容を見直す<ArrowRight size={14}/></button></span></div>}
    </div>
    <div id={`plan-panel-${plan.id}-proposals`} aria-labelledby={`plan-tab-${plan.id}-proposals`} role="tabpanel" hidden={tab!=='proposals'} className={styles.screen}>
      {pending&&<PlanningWait c={c} turn={pending} own={own} onLeave={onList} active={active && tab==='proposals'} />}
      {!!proposals.length&&latest&&!pending?<>
        <div className={styles.nextStep}><strong>まず3問で、出し方を確認。</strong><p>サンプルを見ながら調整できます。まとめて作る数は、そのあとで決めます。</p></div>
        {latest.version!==plan.version&&<p className={styles.hint}>相談内容が更新されています。最新の回答を待つか、「相談」から案を調整してください。</p>}
        {proposals.length>1&&<div className={styles.proposalPicker} aria-label="問題作成案を選ぶ">{proposals.map((proposal,index)=><button type="button" key={proposal.id} aria-pressed={activeProposal===index} onClick={()=>setProposalIndex(index)}><span>案 {index+1}</span><strong>{proposal.title}</strong></button>)}</div>}
        {proposals.map((proposal,index)=><div key={`${latest.id}:${proposal.id}`} hidden={activeProposal!==index} className={styles.screen}><details className={styles.authoringConditions}><summary>この作り方の条件</summary><p>{proposal.instructions}</p></details><PlanningSamples c={c} plan={plan} turn={latest} proposal={proposal} canGenerate={own&&!waiting&&!generating&&latest.version===plan.version} onGenerated={()=>selectTab('questions')} blockedAction={blockedAction}/></div>)}
        {latest.reply&&<details className={styles.replyDetails}><summary>AIの説明・学習の進め方を見る</summary><p>{latest.reply}</p></details>}
        {own&&<p className={styles.hint}>{plan.testOnly?'テスト用の問題は保護者だけが試せます。あとでライブラリに公開できます。':c.profile.role==='student'?'自分で作った問題はすぐ練習できます。保護者も内容と記録を確認できます。':'作った問題は管理者用に保存します。「学習者に届ける」で本人用のセットを渡せます。登録ユーザー全体への公開も別に選べます。'}</p>}
      </>:!pending&&<section className={`panel ${styles.emptyCard}`}><Sparkles size={25}/><h2>{latest?.reply?'AIからの回答を確認しよう。':'このプランの提案をもらおう。'}</h2>{latest?.reply?<p className={styles.clarificationReply}>{latest.reply}</p>:<p>条件は保存済みです。相談を送ると、作れる問題の案が届きます。</p>}{c.error&&!latest?.reply&&<p className={styles.stateError} role="alert">{c.error}</p>}{own?<button type="button" className="button primary" disabled={c.busy||waiting} onClick={()=>{if(!message.trim()&&!latest?.reply)setMessage('保存した目標と教材に合わせて、最初の試作3問を提案してください。');selectTab('chat');}}>{latest?.reply?'回答・希望を伝える':'相談内容を確認して送る'}<ArrowRight size={16}/></button>:<p className={styles.hint}>返信は、このプランを作った本人のアカウントから行えます。</p>}</section>}
      {jobs.length>0&&<button type="button" className={`button secondary ${styles.wideAction}`} onClick={()=>selectTab('questions')}><BookOpen size={17}/>できた問題を確認する<ArrowRight size={16}/></button>}
    </div>
    <div id={`plan-panel-${plan.id}-chat`} aria-labelledby={`plan-tab-${plan.id}-chat`} role="tabpanel" hidden={tab!=='chat'} className={styles.screen}>
      <section className={`panel conversation-panel ${styles.chatPanel}`}>{plan.arrangedFromTopicId&&!turns.length&&<div className={styles.stateHelp}><p>元の問題集はそのまま残します。変えたいところを伝えると、新しいプライベートの問題を3問で試せます。</p></div>}
        {waiting&&<div className={styles.stateHelp}><p>AIの回答待ちです。回答が届くと、次の相談を送れます。</p><button type="button" className="text-button" onClick={()=>selectTab('proposals')}>進み具合を見る<ArrowRight size={15}/></button></div>}
        {own&&<form className="chat-composer" onSubmit={send}><label htmlFor={`message-${plan.id}`}>{plan.arrangedFromTopicId&&!turns.length?'どう変えたいですか？':'希望を伝えて、試作を調整する'}</label><textarea id={`message-${plan.id}`} value={message} onChange={event=>setMessage(event.target.value)} disabled={waiting||c.busy} rows={3} maxLength={4000} placeholder={plan.arrangedFromTopicId?'例：元の問題より少し難しく、穴埋めを中心に。まず3問で確認したい':'例：少し難しいので基礎から。単語の意味を選ぶ四択にして'}/><div className="chat-suggestions">{['もう少しやさしくして','別の聞き方の問題もほしい'].map(text=><button key={text} type="button" disabled={waiting||c.busy} onClick={()=>setMessage(text)}>{text}</button>)}</div>{c.error&&<div className="flash error" role="alert"><CircleHelp size={17}/><span>{c.error}</span></div>}<div className={styles.composerActions}><button type="button" className="text-button" onClick={()=>selectTab('proposals')}><ArrowLeft size={15}/>試作に戻る</button><button type="submit" className="button primary" disabled={c.busy||waiting||!message.trim()}>{c.busy?<LoaderCircle className="spin" size={17}/>:<Send size={17}/>}送信して試作3問をもらう</button></div></form>}
        <div className={styles.history}><h2>最近の相談</h2>{newest?renderTurn(newest):<p className="planning-empty">まだ相談はありません。ひとこと送って始められます。</p>}{turns.length>1&&<details className={styles.olderTurns}><summary>以前の相談 {turns.length-1}件を見る</summary><div className="conversation-turns">{turns.slice(0,-1).reverse().map(renderTurn)}</div></details>}</div>
      </section>
    </div>
    <div id={`plan-panel-${plan.id}-questions`} aria-labelledby={`plan-tab-${plan.id}-questions`} role="tabpanel" hidden={tab!=='questions'} className={styles.screen}>
      {plan.libraryTopicId&&own&&<section className={`panel ${styles.emptyCard}`}><BookOpen size={25}/><h2>ライブラリから追加した問題</h2><button type="button" className="button primary" disabled={c.busy} onClick={()=>openTopic(plan.libraryTopicId!)}>追加した問題を練習<ArrowRight size={16}/></button></section>}
    {!!jobs.length && <section className="panel planning-jobs"><h2>この相談から作った問題</h2>{jobs.map(job => {
      const topic = topics.find(item => item.id === job.topicId);
      const test = !!plan.testOnly || !!job.testOnly || !!topic?.testOnly;
      const practice = !!topic && mayPracticeLibraryTopic(c.data,c.profile,topic) && c.data.questions.some(question => question.topicId === job.topicId && isPracticeReadyQuestion(question));
      const active = job.status === 'queued' || job.status === 'running';
      const savedCount = Math.max(job.generatedCount, savedTopicQuestionCount(c.data.questions, [job.topicId]));
      const available = c.data.questions.some(question => question.topicId === job.topicId && question.status !== 'archived' && (c.profile.role === 'parent' || practice));
      const canConfirmStart = job.status === 'queued' && job.requestedBy === c.profile.id;
      const canContinue = own && job.requestedBy === c.profile.id && job.status === 'failed' && savedCount < job.targetCount;
      return <article key={job.id}>
        <div><strong>{topic?.title || '作成中の問題集'}</strong><p role={active ? 'status' : undefined}>{active ? job.status === 'queued' ? '作成の依頼を受け付けました' : '問題を作成しています' : job.status === 'failed' ? '作成が途中で止まりました' : test ? 'プライベート・テスト用' : 'プライベート'} · {savedCount} / {job.targetCount}問を保存済み</p>{active && <p>10問ずつ保存します。保存した問題から確認できます。</p>}{job.error && <p className="planning-job-error">{job.error}</p>}</div>
        {practice && <button type="button" className="button primary" disabled={c.busy} onClick={() => openTopic(job.topicId)}>10問練習する<ArrowRight size={15}/></button>}
        {available && c.profile.role === 'parent' && <button type="button" className="text-button" onClick={()=>review(job.topicId,true)}>一覧でレビュー・編集<ArrowRight size={15}/></button>}
        {canContinue && <div className="job-recovery"><span>{generating ? 'ほかの問題を作成中です。その作成が終わると続きを依頼できます。' : savedCount ? `保存した${savedCount}問は残して、同じ条件で残りの作成をAIに依頼します。` : '条件は保存されています。同じ条件で、もう一度作成をAIに依頼できます。'}</span><button type="button" className="button primary" disabled={c.busy || generating || !!retryingJob} onClick={() => void retry(job.id)}><RefreshCw size={15} />{retryingJob === job.id ? '依頼を確認しています' : '同じ条件で続きを作る'}</button>{retryAttempt === job.id && c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}</div>}
        {topic && <div className="job-sharing"><SetSharingActions c={c} topic={topic}/></div>}
        {active && <div className="job-recovery"><span>{c.sync.error ? '最新の状況を確認できていません。通信が戻ると、保存済みの件数を確認できます。' : 'ほかの画面に移っても、保存済みの問題はここから確認できます。'}</span><button type="button" className="text-button" disabled={c.busy || c.sync.checking} onClick={() => void (canConfirmStart ? c.actions.resumeGeneration(job.id) : c.actions.refreshStatus())}><RefreshCw size={14} />{c.busy || c.sync.checking ? '状況を確認しています' : canConfirmStart ? '開始を確認する' : '最新の状況を確認'}</button></div>}
      </article>;
    })}</section>}
      {!jobs.length&&!plan.libraryTopicId&&<section className={`panel ${styles.emptyCard}`}><BookOpen size={25}/><h2>問題はここにまとまります。</h2><p>「提案」で案を選ぶと、ここから練習・確認できます。</p><button type="button" className="button primary" onClick={()=>selectTab('proposals')}>提案を選ぶ<ArrowRight size={16}/></button></section>}
      {jobs.some(job=>job.status==='failed')&&own&&<div className={styles.stateHelp}><p>出題内容や難しさを変えたいときは、別の案も相談できます。</p><button type="button" className="text-button" disabled={c.busy} onClick={consultAgain}>条件を変えて相談する<ArrowRight size={16}/></button></div>}
    </div>
  </div>;
}
