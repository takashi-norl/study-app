'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, CircleHelp, FileImage, FileText, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Sparkles, Target, Upload } from 'lucide-react';
import type { LearningPlan, PlanningProposal, PlanningTurn, SourceDocument } from '@/lib/types';
import type { StudyController, UploadStatus } from './controller';
import { PRACTICE_CATEGORIES, QUESTION_COUNTS, LEVEL_OPTIONS, PURPOSE_OPTIONS, SCHEDULE_OPTIONS, DAILY_MINUTES, questionVolumeLabel, buildQuickStart } from '@/lib/quick-start';

const dateLabel = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(date));
const compactVolumeLabel = (count: number) => questionVolumeLabel(count).split('（')[0];
const targetLabel = (date?: string) => date ? date.replaceAll('-', '/') : '期限は相談して決める';

export function UploadFeedback({ status }: { status: UploadStatus | null }) {
  if (!status) return null;
  const pending = status.phase !== 'complete' && status.phase !== 'failed';
  return <div className={`upload-feedback ${status.phase}`} role={status.phase === 'failed' ? 'alert' : 'status'}>
    <div className="upload-feedback-heading">{pending ? <LoaderCircle size={18} className="spin" /> : status.phase === 'failed' ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}<strong>{status.phase === 'failed' ? 'アップロードを中断しました' : status.phase === 'complete' ? '教材の追加が完了しました' : `${status.current} / ${status.total}件目 · ${status.message}`}</strong></div>
    {status.phase !== 'complete' && <span className="upload-file-name">{status.fileName}</span>}
    {pending ? <><div className="progress-track" role="progressbar" aria-label="保存した教材の数" aria-valuenow={status.completed} aria-valuemin={0} aria-valuemax={status.total}><span style={{ width: `${status.completed / status.total * 100}%` }} /></div><p>{status.completed} / {status.total}件を保存済みです。この画面を開いたままお待ちください。</p></> : <><p>{status.message}</p>{status.phase === 'failed' && <p>保存を確認できた教材は{status.completed}件です。下の一覧にない教材だけ選び直してください。</p>}</>}
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
  return <div className="source-bank">
    <section className="panel">
      <div className="panel-heading"><div><h2>教材を、先に保存しておこう。</h2><p>写真やPDFは、何度でも別の問題づくりに使えます。問題集の作成は後からで大丈夫です。</p></div></div>
      <div className={`upload-zone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); upload(Array.from(event.dataTransfer.files)); }}>
        <span className="upload-symbol"><Upload size={25} /></span><h3>写真・PDFを教材ストックへ</h3><p>教科書、ノート、問題集などを選んでください。</p>
        <button className="button secondary" disabled={c.busy} onClick={() => input.current?.click()}>{uploading ? <Upload size={17} /> : <Plus size={17} />}{uploading ? '保存しています' : '写真・PDFを選ぶ'}</button>
        <small>一度に20件まで・PDFは1件10MBまで</small><input ref={input} className="sr-only" type="file" multiple disabled={c.busy} accept="image/*,application/pdf" aria-label="教材ストックに写真やPDFを追加" onChange={event => { upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <UploadFeedback status={status} />
      </div>
      <div className="source-bank-content"><div className="planning-section-heading"><h3>保存した教材 <span>{sources.length}件</span></h3><span>{selection.length} / 20件を選択</span></div>
        {sources.length ? <SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={c.busy} /> : <p className="planning-empty">まだ教材がありません。教材を使わず、目標だけで学習相談を始めることもできます。</p>}
        <div className="planning-actions"><button className="button primary" disabled={c.busy} onClick={() => onConsult(selection)}><MessageCircle size={17} />{selection.length ? '選んだ教材で相談する' : '教材なしで相談する'}<ArrowRight size={16} /></button></div>
        <p className="under-note">保存だけではAIは動きません。「この内容で提案して」を押したときに、選んだ教材と希望をAIへ送ります。</p>
      </div>
    </section>
  </div>;
}

export default function Planning({ c, initialSourceIds, initialRequest, review, openTopic }: { c: StudyController; initialSourceIds?: string[]; initialRequest: number; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void }) {
  const [activeId, setActiveId] = useState<string>('');
  const [creating, setCreating] = useState(!c.data.plans.length || !!initialSourceIds);
  const [creationKey, setCreationKey] = useState(0);
  const [tab, setTab] = useState<'plans' | 'sources'>('plans');
  const [sourceIds, setSourceIds] = useState<string[]>(initialSourceIds ?? []);
  const plans = c.data.plans.filter(item => c.profile.role === 'parent' || item.ownerId === c.profile.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const plan = plans.find(item => item.id === activeId) ?? plans.find(item => item.ownerId === c.profile.id) ?? plans[0];
  useEffect(() => { if (initialSourceIds) { setSourceIds(initialSourceIds); setCreating(true); setTab('plans'); } }, [initialRequest]);
  function newConsultation(ids: string[] = []) { setSourceIds(ids); setCreating(true); setTab('plans'); setCreationKey(value => value + 1); }
  return <>
    <div className="page-heading planning-page-heading"><div><p className="eyebrow">YOUR NEXT STEP</p><h1>学習相談</h1><p className="page-description">科目や練習内容を選ぶと、AIが問題の案を提案します。</p></div><button className="button primary" onClick={() => newConsultation()}><Plus size={17} />新しく作る</button></div>
    <div className="planning-tabs" role="tablist" aria-label="学習相談の表示"><button role="tab" aria-selected={tab === 'plans'} className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}><MessageCircle size={16} />相談・目標</button><button role="tab" aria-selected={tab === 'sources'} className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><BookOpen size={16} />教材ストック</button></div>
    {tab === 'sources' ? <SourceBank c={c} onConsult={newConsultation} /> : <div className="planning-layout">
      <aside className="planning-list"><h2>保存した相談 <span>{plans.length}</span></h2>{plans.map(item => { const owner = c.data.profiles.find(profile => profile.id === item.ownerId); return <button key={item.id} className={!creating && plan?.id === item.id ? 'active' : ''} onClick={() => { setActiveId(item.id); setCreating(false); }}><span>{item.subject} · {owner?.name || '自分'}{item.ownerId !== c.profile.id ? 'の相談' : ''}</span><strong>{item.title}</strong><small>{item.testOnly ? 'テスト用 · ' : ''}{targetLabel(item.targetDate)}</small></button>; })}{!plans.length && <p>目標を保存すると、いつでも相談を続けられます。</p>}</aside>
      <div className="planning-main">{creating || !plan ? <NewPlan key={`new-${initialRequest}-${creationKey}-${sourceIds.join(':')}`} c={c} sourceIds={sourceIds} cancel={plans.length ? () => setCreating(false) : undefined} created={id => { setActiveId(id); setCreating(false); }} /> : <PlanConversation key={plan.id} c={c} plan={plan} review={review} openTopic={openTopic} />}</div>
    </div>}
  </>;
}

function NewPlan({ c, sourceIds: initialIds, created, cancel }: { c: StudyController; sourceIds: string[]; created: (id: string) => void; cancel?: () => void }) {
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
  async function save(consult: boolean) {
    if (disabled || needsSources) return;
    setLocalBusy(true);
    try {
      const input = buildQuickStart({ subject, materialMode, focus, difficulty, totalQuestions, sourceIds: selection, comment: comment.trim(), targetDate: targetDate || undefined, purpose, schedule, minutesPerDay, examTarget: purpose === '英検' ? examTarget : undefined });
      const id = await c.actions.createPlan({ ...input.plan, ...(c.profile.role === 'parent' && testOnly ? { testOnly: true } : {}) });
      if (!id) return;
      if (consult) await c.actions.sendPlanningMessage(id, input.message);
      created(id);
    } finally { setLocalBusy(false); }
  }
  return <section className="panel planning-form-panel quick-start-panel">
    <div className="planning-section-heading"><div><span className="planning-icon"><Sparkles size={23} /></span><h2>選んで、問題を作ろう。</h2></div>{cancel && <button type="button" className="text-button" onClick={cancel}><ArrowLeft size={15} />相談に戻る</button>}</div>
    <p className="planning-intro">試験直前も、毎日の練習も。希望を選んで案を見たら、コメントで調整して作れます。</p>
    <form className="planning-form quick-start-form" onSubmit={event => { event.preventDefault(); void save(true); }}>
      {c.profile.role === 'parent' && <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}><input type="checkbox" checked={testOnly} onChange={event => setTestOnly(event.target.checked)} disabled={disabled} style={{ width: 18, height: 18, minHeight: 18, margin: 0, flex: 'none' }} /><span>テスト用 <span className="optional">（学習者には表示しない）</span></span></label>}
      <fieldset className="quick-choice-group" disabled={disabled}><legend><span>1</span>科目・目的</legend><div className="quick-choice-options">{PRACTICE_CATEGORIES.map(item => <button type="button" key={item.subject} className={subject === item.subject ? 'selected' : ''} aria-pressed={subject === item.subject} onClick={() => { setSubject(item.subject); setFocus(item.focusOptions[0]); if (item.subject !== '英語' && (purpose === '英検' || purpose === 'IELTS')) setPurpose('日々の練習'); }}>{item.subject}</button>)}</div><p className="quick-subheading">何に向けて？</p><div className="quick-choice-options">{PURPOSE_OPTIONS.map(item => <button type="button" key={item} className={purpose === item ? 'selected' : ''} aria-pressed={purpose === item} onClick={() => { setPurpose(item); if (item === '英検' || item === 'IELTS') { setSubject('英語'); setFocus(item === '英検' ? '英検対策' : 'おまかせ'); } }}>{item}</button>)}</div>{purpose === '英検' && <div className="quick-exam-target"><span>目標の級</span><div className="quick-choice-options">{['2級', '準1級', '1級'].map(item => <button type="button" key={item} className={examTarget === item ? 'selected' : ''} aria-pressed={examTarget === item} onClick={() => setExamTarget(item)}>{item}</button>)}</div></div>}{purpose === 'IELTS' && <p className="quick-choice-note">目標スコアがあれば、下の「ひとこと」に添えられます。</p>}</fieldset>
      <fieldset className="quick-choice-group" disabled={disabled}><legend><span>2</span>教材・練習内容</legend><div className="quick-choice-options material-options"><button type="button" className={materialMode === 'ai' ? 'selected' : ''} aria-pressed={materialMode === 'ai'} onClick={() => setMaterialMode('ai')}><Sparkles size={16} /><span>AIにおまかせ<small>教材なしで作る</small></span></button><button type="button" className={materialMode === 'sources' ? 'selected' : ''} aria-pressed={materialMode === 'sources'} onClick={() => { setMaterialMode('sources'); if (!selection.length) setSelected([...sources].reverse().slice(0, 20).map(source => source.id)); }}><BookOpen size={16} /><span>保存した教材<small>教科書・ノートなどから</small></span></button></div>
        {materialMode === 'sources' && <div className="quick-source-picker"><div className="planning-section-heading"><span>{selection.length} / 20件を選択</span>{sources.length > 0 && <button type="button" className="text-button" onClick={() => setSelected(selection.length ? [] : [...sources].reverse().slice(0, 20).map(source => source.id))}>{selection.length ? '選択を解除' : sources.length > 20 ? '新しい20件を選ぶ' : 'すべて選ぶ'}</button>}</div>{sources.length > 0 ? <SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={disabled} /> : <p className="planning-empty">写真やPDFを追加してください。保存したら、この相談で使う教材を選べます。</p>}<button type="button" className="button secondary" onClick={() => input.current?.click()}><Upload size={16} />写真・PDFを追加</button><input ref={input} className="sr-only" type="file" multiple accept="image/*,application/pdf" aria-label="相談で使う写真やPDFを追加" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void upload(files); }} /><div className="upload-zone quick-upload-feedback"><UploadFeedback status={uploadStatus} /></div></div>}
        <p className="quick-subheading">練習する内容</p><div className="quick-choice-options">{category.focusOptions.map(item => <button type="button" key={item} className={focus === item ? 'selected' : ''} aria-pressed={focus === item} onClick={() => setFocus(item)}>{item}</button>)}</div>
      </fieldset>
      <fieldset className="quick-choice-group" disabled={disabled}><legend><span>3</span>期間・ペース</legend><div className="quick-choice-options">{SCHEDULE_OPTIONS.map(item => <button type="button" key={item} className={schedule === item ? 'selected' : ''} aria-pressed={schedule === item} onClick={() => { setSchedule(item); if (item === '身につくまで') setTargetDate(''); if (item === 'あと1時間') setTotalQuestions(Math.min(totalQuestions, 30)); else if (item === '1か月') setTotalQuestions(100); }}>{item}</button>)}</div>{schedule !== 'あと1時間' ? <div className="quick-exam-target"><span>1日</span><div className="quick-choice-options">{DAILY_MINUTES.map(minutes => <button type="button" key={minutes} className={minutesPerDay === minutes ? 'selected' : ''} aria-pressed={minutesPerDay === minutes} onClick={() => setMinutesPerDay(minutes)}>{minutes}分</button>)}</div></div> : <p className="quick-choice-note">直前に確認したい要点を優先して、短時間で取り組める案にします。</p>}{schedule === '身につくまで' && <p className="quick-choice-note">期限は決めず、日を空けても解けるかを見ながら調整します。</p>}</fieldset>
      <fieldset className="quick-choice-group" disabled={disabled}><legend><span>4</span>難しさ</legend><div className="quick-choice-options">{LEVEL_OPTIONS.map(item => <button type="button" key={item} className={difficulty === item ? 'selected' : ''} aria-pressed={difficulty === item} onClick={() => setDifficulty(item)}>{item}</button>)}</div><p className="quick-choice-note">進学校の高校1年生を目安に、学習記録と目的に合わせて調整します。</p></fieldset>
      <fieldset className="quick-choice-group" disabled={disabled}><legend><span>5</span>分量</legend><div className="quick-choice-options volume-options">{QUESTION_COUNTS.map(count => <button type="button" key={count} className={totalQuestions === count ? 'selected' : ''} aria-pressed={totalQuestions === count} onClick={() => setTotalQuestions(count)} aria-label={questionVolumeLabel(count)}>{compactVolumeLabel(count)}</button>)}</div><p className="quick-choice-note">1回10問ずつ、時間があるときは続けて練習できます。</p></fieldset>
      <details className="quick-extra-options"><summary>{schedule === '身につくまで' ? '希望を添える' : '希望や目標日を添える'} <span>任意</span></summary><label>ひとこと<textarea disabled={disabled} value={comment} onChange={event => setComment(event.target.value)} rows={3} maxLength={2000} placeholder="例：期末テストの範囲に合わせて／英検準1級の単語を多めに" /></label>{schedule !== '身につくまで' && <label>目標の日<input disabled={disabled} type="date" value={targetDate} onChange={event => setTargetDate(event.target.value)} /></label>}</details>
      {c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}
      {needsSources && <p className="quick-choice-note" role="status">使う教材を1件以上選ぶか、「AIにおまかせ」を選んでください。</p>}
      <div className="planning-actions quick-start-actions"><button className="button primary" disabled={disabled || needsSources}>{localBusy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}この内容で提案して<ArrowRight size={16} /></button><button type="button" className="text-button" disabled={disabled || needsSources} onClick={() => void save(false)}>選択だけ保存</button></div>
      <p className="under-note">ここでは案の提案まで。問題を作るのは、案を選んで「この案で作る」を押してからです。AIへの相談・作問にはAPI利用料がかかります。</p>
    </form>
  </section>;
}

function PlanConversation({ c, plan, review, openTopic }: { c: StudyController; plan: LearningPlan; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void }) {
  const [message, setMessage] = useState('');
  const [publishingTopic, setPublishingTopic] = useState<string | null>(null);
  const own = plan.ownerId === c.profile.id;
  const turns = c.data.planningTurns.filter(turn => turn.planId === plan.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const waiting = turns.some(turn => turn.status === 'queued' || turn.status === 'running');
  const latest = [...turns].reverse().find(turn => turn.status === 'complete');
  const topics = c.data.topics.filter(topic => topic.planId === plan.id);
  const jobs = c.data.jobs.filter(job => job.planId === plan.id || topics.some(topic => topic.id === job.topicId));
  const generating = c.data.jobs.some(job => job.status === 'queued' || job.status === 'running');
  const owner = c.data.profiles.find(profile => profile.id === plan.ownerId);
  async function send(event: FormEvent) { event.preventDefault(); if (message.trim() && await c.actions.sendPlanningMessage(plan.id, message)) setMessage(''); }
  return <>
    <section className="panel plan-summary"><div className="planning-section-heading"><div><span className="subject-badge">{plan.subject}</span>{plan.testOnly && <span className="count-pill" style={{ marginLeft: 8 }}>テスト用</span>}<h2>{plan.title}</h2></div><span className="plan-owner">{owner?.name || '自分'}の目標</span></div><p>{plan.goal}</p>{plan.testOnly && <p className="self-study-notice">保護者だけが試せる問題です。相談内容・問題・練習記録は学習者には表示されません。</p>}<div className="plan-facts"><span><Target size={15} />{targetLabel(plan.targetDate)}</span><span>1日{plan.dailyQuestionTarget}問が目安</span><span>教材{plan.sourceIds.length}件{!plan.sourceIds.length && ' · 目標から相談'}</span></div><p className="plan-level"><strong>今のレベル・苦手：</strong>{plan.difficulty}</p>{plan.sourceIds.length > 0 && <details className="plan-source-details"><summary>使っている教材を見る</summary><ul>{plan.sourceIds.map(id => { const source = c.data.sources.find(item => item.id === id); return <li key={id}>{source?.previewUrl ? <a href={source.previewUrl} target="_blank" rel="noreferrer">{source.name}</a> : source?.name || '保存済みの教材'}</li>; })}</ul></details>}{plan.libraryTopicId && own && <div className="planning-actions"><button type="button" className="button primary" disabled={c.busy} onClick={() => openTopic(plan.libraryTopicId!)}><BookOpen size={17} />追加した問題を練習<ArrowRight size={15} /></button></div>}{!own && <div className="planning-readonly">{owner?.name || 'このアカウント'}さんの相談内容と作った問題を確認できます。返信・作問は本人のアカウントから行えます。</div>}</section>
    <section className="panel conversation-panel"><div className="planning-section-heading"><h2><MessageCircle size={19} />相談の履歴</h2><span>{turns.length}回の相談</span></div>
      {!turns.length && <p className="planning-empty">「最初の10問を提案して」「基礎から始めたい」など、相談したいことを送ってみましょう。</p>}
      <div className="conversation-turns">{turns.map(turn => <div className="conversation-turn" key={turn.id}><div className="chat-bubble user"><span>{owner?.name || '自分'} · {dateLabel(turn.createdAt)}</span>{turn.message.startsWith('この選択から、') ? <><p>選んだ条件から提案を依頼しました。</p><details><summary>選んだ条件を見る</summary><p style={{ whiteSpace: 'pre-wrap' }}>{turn.message}</p></details></> : <p>{turn.message}</p>}</div>{turn.status === 'complete' ? <div className="chat-bubble assistant"><span><Sparkles size={14} />AIからの提案{c.demo && '（サンプル）'}</span><p>{turn.reply}</p>{turn.id !== latest?.id && !!turn.proposals?.length && <small>この回答には{turn.proposals.length}件の作問案があります。下に最新の案を表示しています。</small>}</div> : turn.status === 'failed' ? <div className="flash error" role="alert"><CircleHelp size={17} /><span>{turn.error || '回答を完了できませんでした。内容を確認して、もう一度相談できます。'}</span></div> : <div className="chat-pending" role="status"><LoaderCircle className="spin" size={18} /><span>{turn.status === 'queued' ? '相談を受け付けました' : '目標と教材を読み、提案を考えています'}<small>回答は保存されます。この画面を閉じても大丈夫です。</small>{own && <button type="button" className="text-button planning-resume" disabled={c.busy} onClick={() => void c.actions.resumePlanningTurn(turn.id)}><RefreshCw size={14} />進まない場合は再開</button>}</span></div>}</div>)}</div>
      {own && <form className="chat-composer" onSubmit={send}><label htmlFor={`message-${plan.id}`}>相談を続ける</label><textarea id={`message-${plan.id}`} value={message} onChange={event => setMessage(event.target.value)} disabled={waiting} rows={3} maxLength={4000} placeholder="例：少し難しいので基礎から。最初は単語の意味を選ぶ10問にして" /><div className="chat-suggestions">{['まず最初の10問を提案して', 'もう少しやさしくして', '別の聞き方の問題もほしい'].map(text => <button key={text} type="button" disabled={waiting || c.busy} onClick={() => setMessage(text)}>{text}</button>)}</div>{c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}<div className="planning-actions"><small>AIへの相談・作問にはAPI利用料がかかります。</small><button className="button primary" disabled={c.busy || waiting || !message.trim()}>{c.busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}AIに相談</button></div></form>}
    </section>
    {latest?.proposals?.length ? <section className="planning-proposals"><div className="planning-section-heading"><div><h2>次に取り組む問題の案</h2><p>話し合って調整し、気に入った案から問題を作れます。</p></div></div>{latest.version !== plan.version && <p className="under-note">この案の後に相談内容が更新されています。最新の回答を待つか、改めて作問案を相談してください。</p>}{latest.proposals.map(proposal => <ProposalCard key={`${latest.id}:${proposal.id}`} c={c} plan={plan} turn={latest} proposal={proposal} canGenerate={own && !waiting && !generating && latest.version === plan.version} />)}{plan.ownerId === c.profile.id && <p className="under-note">{plan.testOnly ? '作成した問題は、保護者だけがテストできます。学習者には表示されません。' : c.profile.role === 'student' ? '自分で作った問題は「自習用」としてすぐ練習できます。保護者も内容と記録を確認できます。' : '作成した問題は下書きになります。レビューで確認してから、お子さまへ公開してください。'}</p>}</section> : null}
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

  </>;
}

function ProposalCard({ c, plan, turn, proposal, canGenerate }: { c: StudyController; plan: LearningPlan; turn: PlanningTurn; proposal: PlanningProposal; canGenerate: boolean }) {
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
  return <article className="panel proposal-card"><div className="planning-section-heading"><span className="subject-badge">{proposal.subject}</span><span>{proposal.difficulty} · 四択</span></div><h3>{proposal.title}</h3><p>{proposal.description}</p><details><summary>出題内容・アレンジ</summary><p>{proposal.instructions}</p></details>
    <div className="proposal-bottom"><label>作る分量<select value={count} disabled={disabled} onChange={event => setCount(Number(event.target.value))}>{options.map(value => <option key={value} value={value}>{compactVolumeLabel(value)}</option>)}</select></label>{own && <button className="button primary" disabled={disabled || hasComment} onClick={async () => { setAttempted(true); setLocalBusy(true); try { if (await c.actions.generateProposal(plan.id, turn.id, proposal.id, count)) setAttempted(false); } finally { setLocalBusy(false); } }}><Sparkles size={17} />この案で作る</button>}</div>
    {own && <div className="proposal-comment"><label htmlFor={`proposal-comment-${proposal.id}`}>変えたいところがあれば <span>任意</span></label><textarea id={`proposal-comment-${proposal.id}`} value={comment} onChange={event => setComment(event.target.value)} disabled={disabled} rows={2} maxLength={2000} placeholder="例：意味を選ぶだけでなく、文中の空欄を埋める問題もほしい" />{hasComment && <><p className="quick-choice-note">コメントを反映した案を確認してから、作成できます。</p><button type="button" className="button secondary" disabled={disabled} onClick={() => void revise()}>{localBusy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}コメントを反映して再提案</button></>}</div>}
    {attempted && c.error && <div className="flash error proposal-error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}
  </article>;
}
