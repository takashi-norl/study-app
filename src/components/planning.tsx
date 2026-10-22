'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, CircleHelp, FileImage, FileText, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Sparkles, Target, Upload } from 'lucide-react';
import type { LearningPlan, PlanningProposal, PlanningTurn, SourceDocument } from '@/lib/types';
import type { StudyController, UploadStatus } from './controller';

const subjectOptions = ['英語', '国語', '古文', '漢文', '数学', '社会', '理科', 'その他'];
const dateLabel = (date: string) => new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(date));
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
        <button className="button secondary" disabled={c.busy} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}{uploading ? '保存しています' : '写真・PDFを選ぶ'}</button>
        <small>一度に20件まで・PDFは1件10MBまで</small><input ref={input} className="sr-only" type="file" multiple disabled={c.busy} accept="image/*,application/pdf" aria-label="教材ストックに写真やPDFを追加" onChange={event => { upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <UploadFeedback status={status} />
      </div>
      <div className="source-bank-content"><div className="planning-section-heading"><h3>保存した教材 <span>{sources.length}件</span></h3><span>{selection.length} / 20件を選択</span></div>
        {sources.length ? <SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={c.busy} /> : <p className="planning-empty">まだ教材がありません。教材を使わず、目標だけで学習相談を始めることもできます。</p>}
        <div className="planning-actions"><button className="button primary" disabled={c.busy} onClick={() => onConsult(selection)}><MessageCircle size={17} />{selection.length ? '選んだ教材で相談する' : '教材なしで相談する'}<ArrowRight size={16} /></button></div>
        <p className="under-note">保存だけではAIは動きません。「AIに相談」を押したときに、選んだ教材と相談内容をAIへ送ります。</p>
      </div>
    </section>
  </div>;
}

export default function Planning({ c, initialSourceIds, initialRequest, review, openTopic }: { c: StudyController; initialSourceIds?: string[]; initialRequest: number; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void }) {
  const [activeId, setActiveId] = useState<string>('');
  const [creating, setCreating] = useState(!c.data.plans.length || !!initialSourceIds);
  const [tab, setTab] = useState<'plans' | 'sources'>('plans');
  const [sourceIds, setSourceIds] = useState<string[]>(initialSourceIds ?? []);
  const plans = c.data.plans.filter(item => c.profile.role === 'parent' || item.ownerId === c.profile.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const plan = plans.find(item => item.id === activeId) ?? plans.find(item => item.ownerId === c.profile.id) ?? plans[0];
  useEffect(() => { if (initialSourceIds) { setSourceIds(initialSourceIds); setCreating(true); setTab('plans'); } }, [initialRequest]);
  function newConsultation(ids: string[] = []) { setSourceIds(ids); setCreating(true); setTab('plans'); }
  return <>
    <div className="page-heading planning-page-heading"><div><p className="eyebrow">YOUR NEXT STEP</p><h1>学習相談</h1><p className="page-description">目標と今の力に合わせて、次に取り組む問題を一緒に考えよう。</p></div><button className="button primary" onClick={() => newConsultation()}><Plus size={17} />新しい相談</button></div>
    <div className="planning-tabs" role="tablist" aria-label="学習相談の表示"><button role="tab" aria-selected={tab === 'plans'} className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}><MessageCircle size={16} />相談・目標</button><button role="tab" aria-selected={tab === 'sources'} className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}><BookOpen size={16} />教材ストック</button></div>
    {tab === 'sources' ? <SourceBank c={c} onConsult={newConsultation} /> : <div className="planning-layout">
      <aside className="planning-list"><h2>保存した相談 <span>{plans.length}</span></h2>{plans.map(item => { const owner = c.data.profiles.find(profile => profile.id === item.ownerId); return <button key={item.id} className={!creating && plan?.id === item.id ? 'active' : ''} onClick={() => { setActiveId(item.id); setCreating(false); }}><span>{item.subject} · {owner?.name || '自分'}{item.ownerId !== c.profile.id ? 'の相談' : ''}</span><strong>{item.title}</strong><small>{targetLabel(item.targetDate)}</small></button>; })}{!plans.length && <p>目標を保存すると、いつでも相談を続けられます。</p>}</aside>
      <div className="planning-main">{creating || !plan ? <NewPlan key={`new-${initialRequest}-${sourceIds.join(':')}`} c={c} sourceIds={sourceIds} cancel={plans.length ? () => setCreating(false) : undefined} created={id => { setActiveId(id); setCreating(false); }} /> : <PlanConversation key={plan.id} c={c} plan={plan} review={review} openTopic={openTopic} />}</div>
    </div>}
  </>;
}

function NewPlan({ c, sourceIds: initialIds, created, cancel }: { c: StudyController; sourceIds: string[]; created: (id: string) => void; cancel?: () => void }) {
  const [subject, setSubject] = useState('英語');
  const [goal, setGoal] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [daily, setDaily] = useState(10);
  const [selected, setSelected] = useState(initialIds);
  const [localBusy, setLocalBusy] = useState(false);
  const sources = c.data.sources.filter(source => c.profile.role === 'parent' || source.ownerId === c.profile.id);
  const selection = selected.filter(id => sources.some(source => source.id === id));
  async function save(consult: boolean) {
    if (!goal.trim() || localBusy) return;
    setLocalBusy(true);
    try {
      const id = await c.actions.createPlan({ subject: subject.trim(), goal: goal.trim(), difficulty: difficulty.trim() || '相談して決めたい', targetDate: targetDate || undefined, dailyQuestionTarget: daily, sourceIds: selection });
      if (!id) return;
      if (consult) await c.actions.sendPlanningMessage(id, 'この目標に向けて、期限までの学習の進め方と、最初に取り組む問題を提案してください。今のレベルがはっきりしない場合は、確認から始めたいです。');
      created(id);
    } finally { setLocalBusy(false); }
  }
  return <section className="panel planning-form-panel"><div className="planning-section-heading"><div><span className="planning-icon"><Target size={23} /></span><h2>どんな力を、いつまでに？</h2></div>{cancel && <button className="text-button" onClick={cancel}><ArrowLeft size={15} />相談に戻る</button>}</div>
    <p className="planning-intro">教材がなくても始められます。目標と現在の学習記録をもとに、AIが難易度や取り組む順番を提案します。</p>
    <form className="planning-form" onSubmit={event => { event.preventDefault(); void save(true); }}>
      <label>科目<input list="planning-subjects" value={subject} onChange={event => setSubject(event.target.value)} maxLength={40} required placeholder="英語・国語・社会・理科など" /><datalist id="planning-subjects">{subjectOptions.map(item => <option key={item} value={item} />)}</datalist></label>
      <label>目標・取り組みたい内容<textarea value={goal} onChange={event => setGoal(event.target.value)} required rows={3} maxLength={2000} placeholder="例：10か月後の受験に向けて、英単語を基礎から覚えたい" /></label>
      <label>今のレベル・苦手なこと <span className="optional">わかる範囲で</span><textarea value={difficulty} onChange={event => setDifficulty(event.target.value)} rows={2} maxLength={200} placeholder="例：中学の単語はわかる。長文で単語の意味が思い出せない" /></label>
      <div className="form-grid"><label>目標の日 <span className="optional">任意</span><input type="date" value={targetDate} onChange={event => setTargetDate(event.target.value)} /></label><label>1日の目安<select value={daily} onChange={event => setDaily(Number(event.target.value))}>{[5, 10, 15, 20, 30, 50].map(count => <option key={count} value={count}>{count}問</option>)}</select></label></div>
      <details className="planning-material-picker" open={selection.length > 0}><summary>使う教材 <span>{selection.length ? `${selection.length}件を選択` : 'なしでもOK'}</span></summary>{sources.length ? <SourceRows sources={sources} selected={selection} onChange={setSelected} disabled={c.busy || localBusy} /> : <p className="planning-empty">教材はまだありません。このまま相談するか、「教材ストック」で写真を保存できます。</p>}</details>
      {c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}
      <div className="planning-actions"><button type="button" className="button secondary" disabled={c.busy || localBusy || !goal.trim() || !subject.trim()} onClick={() => void save(false)}>目標だけ保存</button><button className="button primary" disabled={c.busy || localBusy || !goal.trim() || !subject.trim()}>{localBusy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}保存してAIに相談</button></div>
      <p className="under-note">AIへの相談・作問にはAPI利用料がかかります。目標や教材の保存だけではAIを使いません。</p>
    </form>
  </section>;
}

function PlanConversation({ c, plan, review, openTopic }: { c: StudyController; plan: LearningPlan; review: (topicId?: string, includePublished?: boolean) => void; openTopic: (id: string) => void }) {
  const [message, setMessage] = useState('');
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
    <section className="panel plan-summary"><div className="planning-section-heading"><div><span className="subject-badge">{plan.subject}</span><h2>{plan.title}</h2></div><span className="plan-owner">{owner?.name || '自分'}の目標</span></div><p>{plan.goal}</p><div className="plan-facts"><span><Target size={15} />{targetLabel(plan.targetDate)}</span><span>1日{plan.dailyQuestionTarget}問が目安</span><span>教材{plan.sourceIds.length}件{!plan.sourceIds.length && ' · 目標から相談'}</span></div><p className="plan-level"><strong>今のレベル・苦手：</strong>{plan.difficulty}</p>{plan.sourceIds.length > 0 && <details className="plan-source-details"><summary>使っている教材を見る</summary><ul>{plan.sourceIds.map(id => { const source = c.data.sources.find(item => item.id === id); return <li key={id}>{source?.previewUrl ? <a href={source.previewUrl} target="_blank" rel="noreferrer">{source.name}</a> : source?.name || '保存済みの教材'}</li>; })}</ul></details>}{!own && <div className="planning-readonly">{owner?.name || 'このアカウント'}さんの相談内容と作った問題を確認できます。返信・作問は本人のアカウントから行えます。</div>}</section>
    <section className="panel conversation-panel"><div className="planning-section-heading"><h2><MessageCircle size={19} />相談の履歴</h2><span>{turns.length}回の相談</span></div>
      {!turns.length && <p className="planning-empty">「最初の10問を提案して」「基礎から始めたい」など、相談したいことを送ってみましょう。</p>}
      <div className="conversation-turns">{turns.map(turn => <div className="conversation-turn" key={turn.id}><div className="chat-bubble user"><span>{owner?.name || '自分'} · {dateLabel(turn.createdAt)}</span><p>{turn.message}</p></div>{turn.status === 'complete' ? <div className="chat-bubble assistant"><span><Sparkles size={14} />AIからの提案{c.demo && '（サンプル）'}</span><p>{turn.reply}</p>{turn.id !== latest?.id && !!turn.proposals?.length && <small>この回答には{turn.proposals.length}件の作問案があります。下に最新の案を表示しています。</small>}</div> : turn.status === 'failed' ? <div className="flash error" role="alert"><CircleHelp size={17} /><span>{turn.error || '回答を完了できませんでした。内容を確認して、もう一度相談できます。'}</span></div> : <div className="chat-pending" role="status"><LoaderCircle className="spin" size={18} /><span>{turn.status === 'queued' ? '相談を受け付けました' : '目標と教材を読み、提案を考えています'}<small>回答は保存されます。この画面を閉じても大丈夫です。</small>{own && <button type="button" className="text-button planning-resume" disabled={c.busy} onClick={() => void c.actions.resumePlanningTurn(turn.id)}><RefreshCw size={14} />進まない場合は再開</button>}</span></div>}</div>)}</div>
      {own && <form className="chat-composer" onSubmit={send}><label htmlFor={`message-${plan.id}`}>相談を続ける</label><textarea id={`message-${plan.id}`} value={message} onChange={event => setMessage(event.target.value)} disabled={waiting} rows={3} maxLength={4000} placeholder="例：少し難しいので基礎から。最初は単語の意味を選ぶ10問にして" /><div className="chat-suggestions">{['まず最初の10問を提案して', 'もう少しやさしくして', '別の聞き方の問題もほしい'].map(text => <button key={text} type="button" disabled={waiting || c.busy} onClick={() => setMessage(text)}>{text}</button>)}</div>{c.error && <div className="flash error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}<div className="planning-actions"><small>AIへの相談・作問にはAPI利用料がかかります。</small><button className="button primary" disabled={c.busy || waiting || !message.trim()}>{c.busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}AIに相談</button></div></form>}
    </section>
    {latest?.proposals?.length ? <section className="planning-proposals"><div className="planning-section-heading"><div><h2>次に取り組む問題の案</h2><p>話し合って調整し、気に入った案から問題を作れます。</p></div></div>{latest.version !== plan.version && <p className="under-note">この案の後に相談内容が更新されています。最新の回答を待つか、改めて作問案を相談してください。</p>}{latest.proposals.map(proposal => <ProposalCard key={`${latest.id}:${proposal.id}`} c={c} plan={plan} turn={latest} proposal={proposal} canGenerate={own && !waiting && !generating && latest.version === plan.version} />)}{plan.ownerId === c.profile.id && <p className="under-note">{c.profile.role === 'student' ? '自分で作った問題は「自習用」としてすぐ練習できます。保護者も内容と記録を確認できます。' : '作成した問題は下書きになります。レビューで確認してから、お子さまへ公開してください。'}</p>}</section> : null}
    {!!jobs.length && <section className="panel planning-jobs"><h2>この相談から作った問題</h2>{jobs.map(job => { const topic = topics.find(item => item.id === job.topicId); const personal = !!job.audienceUserId || !!topic?.audienceUserId; const active = job.status === 'queued' || job.status === 'running'; return <article key={job.id}><div><strong>{topic?.title || '作成中の問題集'}</strong><p>{active ? '問題を作成しています' : job.status === 'failed' ? '作成が途中で止まりました' : personal ? '自習用' : '下書きの確認待ち'} · {job.generatedCount} / {job.targetCount}問</p>{job.error && <p className="planning-job-error">{job.error}</p>}</div>{active ? <LoaderCircle size={18} className="spin" /> : job.generatedCount > 0 && <button className="button secondary" onClick={() => personal && c.profile.role === 'student' ? openTopic(job.topicId) : review(job.topicId, personal)}>{personal && c.profile.role === 'student' ? '練習する' : '内容を確認'}<ArrowRight size={15} /></button>}{active && own && <div className="job-recovery"><span>画面を閉じても、処理は続きます。</span><button type="button" className="text-button" disabled={c.busy} onClick={() => void c.actions.resumeGeneration(job.id)}><RefreshCw size={14} />進まない場合は再開</button></div>}</article>; })}</section>}
  </>;
}

function ProposalCard({ c, plan, turn, proposal, canGenerate }: { c: StudyController; plan: LearningPlan; turn: PlanningTurn; proposal: PlanningProposal; canGenerate: boolean }) {
  const [count, setCount] = useState(proposal.targetCount);
  const [attempted, setAttempted] = useState(false);
  const options = [...new Set([10, 20, 30, 50, 100, 200, 300, proposal.targetCount])].sort((a, b) => a - b);
  return <article className="panel proposal-card"><div className="planning-section-heading"><span className="subject-badge">{proposal.subject}</span><span>{proposal.difficulty} · 四択</span></div><h3>{proposal.title}</h3><p>{proposal.description}</p><details><summary>出題内容・アレンジ</summary><p>{proposal.instructions}</p></details><div className="proposal-bottom"><label>今回作る問題数<select value={count} disabled={!canGenerate || c.busy} onChange={event => setCount(Number(event.target.value))}>{options.map(value => <option key={value} value={value}>{value}問</option>)}</select></label>{plan.ownerId === c.profile.id && <button className="button primary" disabled={!canGenerate || c.busy} onClick={async () => { setAttempted(true); if (await c.actions.generateProposal(plan.id, turn.id, proposal.id, count)) setAttempted(false); }}><Sparkles size={17} />{c.profile.role === 'student' ? '自習問題を作る' : '確認用の下書きを作る'}</button>}</div>{attempted && c.error && <div className="flash error proposal-error" role="alert"><CircleHelp size={17} /><span>{c.error}</span></div>}</article>;
}
