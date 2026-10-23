'use client';

import { useEffect, useState, useCallback, useRef, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Eye, Bell, BookMarked, BookOpen, CalendarDays, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, FileImage, FileText, Flame, GraduationCap, LayoutDashboard, ListChecks, Menu, LoaderCircle, LogOut, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Sprout, Target, TrendingUp, Upload, X } from 'lucide-react';
import type { Attempt, Profile, Question, SourceDocument, StudyData, Subject } from '@/lib/types';
import { getDailyActivity, getQuestionProgress, getTopicStats } from '@/lib/learning';
import type { StudyController } from './controller';
import Planning, { SourceBank } from './planning';
import { EnglishAudio } from './english-audio';
import { StudyGuide } from './study-guide';
import { ReleaseNotesCard } from './release-history';
import { ReleaseNotice } from './release-notice';
import { CURRENT_RELEASE } from '@/lib/releases';
import { QuestionLibrary } from './question-library';
import { QuestionReview } from './question-review';
import { LearnerPreview } from './learner-preview';
import { LearningProjects } from './learning-projects';
import { AdminWorkspaceGuide } from './admin-workspace-guide';
import { asPracticeQuestion, isPracticeReadyQuestion, topicOwnerId } from '@/lib/library-policy';
import { learnerQuestions } from '@/lib/learner-library';
import { PersonalProfileProvider, usePersonalProfile } from './personal-profile-context';
import { PersonalProfilePanel, PersonalEncouragement } from './personal-profile';
import { AiUsagePanel } from './ai-usage';
import { PlanningWorkNotice } from './planning-work-notice';

type View = 'home' | 'topics' | 'history' | 'library' | 'review' | 'settings' | 'planning' | 'catalog' | 'menu' | 'preview' | 'projects';
type SettingsSection = 'index' | 'profile' | 'usage' | 'releases' | 'guide' | 'account' | 'notifications' | 'data';
const SETTINGS_TITLES: Record<SettingsSection, string> = {index: '設定', profile: 'プロフィール', usage: 'AIの利用状況', releases: '更新履歴', guide: '使い方', account: 'アカウント', notifications: '通知・ホーム画面', data: '学習データ'};
const VIEW_TITLES: Record<View, string> = {home: 'ホーム', topics: 'ライブラリ', catalog: 'ライブラリ', library: 'ライブラリ', projects: '学習プラン', preview: 'ユーザー表示プレビュー', review: '一覧レビュー', history: '学習の記録', planning: '問題を作る', settings: '設定', menu: 'メニュー'};
const dayKey = (value: string | Date = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(value));
const dateTime = (value?: string | null) => value ? new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' }).format(new Date(value)) : 'まだ解いていません';
const percent = (correct: number, total: number) => total ? `${Math.round(correct / total * 100)}%` : '—';
const accountLabel = (profile: Profile) => profile.accessLevel === 'superuser' ? 'Super User' : profile.role === 'parent' ? 'Manager' : '学習者';
const subjectClass = (subject: Subject) => subject === '英語' ? 'english' : subject === '漢文' ? 'chinese' : 'classical';

function orderedAttempts(data: StudyData, studentId: string) { return data.attempts.filter(a => a.userId === studentId).sort((a, b) => a.answeredAt.localeCompare(b.answeredAt)); }
function questionHistory(attempts: Attempt[], questionId: string) {
  const rows = attempts.filter(a => a.questionId === questionId);
  const progress = getQuestionProgress(questionId, attempts, attempts[0]?.userId ?? '');
  return { rows, wrong: progress.wrongCount, correct: progress.correctCount, last: rows.at(-1), nextReviewAt: progress.nextReviewAt, stage: progress.stage, streak: progress.streak };
}
function learningStats(data: StudyData, studentId: string, topicId?: string) {
  const eligible = learnerQuestions(data, studentId).filter(question => isPracticeReadyQuestion(question)).map(asPracticeQuestion);
  const questions = eligible.filter(q => q.status === 'published' && (!q.publishedAt || Date.parse(q.publishedAt) <= Date.now()) && (!topicId || q.topicId === topicId));
  const ids = new Set(questions.map(q => q.id));
  const attempts = orderedAttempts(data, studentId).filter(a => ids.has(a.questionId));
  const stats = getTopicStats(topicId ?? 'all', topicId ? eligible : eligible.map(q => ({ ...q, topicId: 'all' })), data.attempts, data.exposures, studentId);
  const review = questions.reduce((count, q) => count + Math.max(0, new Set(attempts.filter(a => a.questionId === q.id).map(a => dayKey(a.answeredAt))).size - 1), 0);
  return { total: stats.total, attempts, answered: stats.answered, exposed: stats.exposed, coverage: Math.round(stats.coverageRate * 100), first: stats.answered, firstCorrect: (stats.firstAccuracy ?? 0) * stats.answered, review, reviewCorrect: (stats.reviewAccuracy ?? 0) * review, weak: stats.weakCount, due: stats.dueCount, wrongHistory: questions.filter(q => questionHistory(attempts, q.id).wrong > 0).length };
}

function IconBadge({ children, className = '' }: { children: ReactNode; className?: string }) { return <span className={`icon-badge ${className}`}>{children}</span>; }
function Empty({ icon = <BookOpen size={28} />, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) { return <div className="empty-state">{icon}<h3>{title}</h3><p>{children}</p></div>; }
function SubjectBadge({ subject }: { subject: Subject }) { return <span className={`subject-badge ${subjectClass(subject)}`}>{subject}</span>; }
function ProgressBar({ value, label }: { value: number; label: string }) { return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>; }
function AppReleaseNotice({ busy }: { busy: boolean }) { const personal = usePersonalProfile(); return <ReleaseNotice busy={busy || !!personal.busy} />; }
function Flash({ c }: { c: StudyController }) { return <>{c.error && <div className="flash error" role="alert"><CircleHelp size={18} /><span>{c.error}</span></div>}{c.notice && <div className="flash notice" role="status"><CheckCircle2 size={18} /><span>{c.notice}</span></div>}</>; }

export default function StudyApp({ controller: c }: { controller: StudyController }) {
  const [view, updateView] = useState<View>('home');
  const [planningLocation, setPlanningLocation] = useState('問題を作る');
  const [profileLocation, setProfileLocation] = useState('プロフィール');
  const [visited, setVisited] = useState<View[]>([]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('index');
  const reviewDirty = useRef(false);
  const onReviewDirtyChange = useCallback((dirty: boolean) => { reviewDirty.current = dirty; }, []);
  const uploading = !!c.uploadStatus && !['complete', 'failed'].includes(c.uploadStatus.phase);
  function setView(next: View) {
    if (uploading || c.session && c.busy || view === 'review' && c.busy) return;
    if (next !== view && view === 'review' && reviewDirty.current && !window.confirm('未保存の変更があります。保存せずに移動しますか？')) return;
    if (next !== view) reviewDirty.current = false;
    if (c.session) void c.actions.finishSession();
    updateView(next);
    setVisited(items => items.includes(next) ? items : [...items, next]);
  }
  function openSettings(section: SettingsSection = 'index') { if (uploading || c.session && c.busy) return; setSettingsSection(section); setView('settings'); }

  const [reviewTopic, setReviewTopic] = useState('all');
  const [reviewSubject, setReviewSubject] = useState('all');
  const [previewLearnerId, setPreviewLearnerId] = useState<string>();
  function openReview(topicId = 'all', _includePublished = false) {
    if (uploading || c.busy) return;
    if (view === 'review' && (topicId !== reviewTopic || reviewSubject !== 'all') && reviewDirty.current && !window.confirm('未保存の変更があります。保存せずに移動しますか？')) return;
    setReviewSubject('all'); setReviewTopic(topicId); setView('review');
  }
  function openKobunReview() { if (uploading || c.busy) return; setReviewTopic('all'); setReviewSubject('古文'); setView('review'); }
  function openPreview(learnerId?: string) { setPreviewLearnerId(learnerId); setView('preview'); }
  const [planningSources, setPlanningSources] = useState<string[] | undefined>();
  const [planningPreset, setPlanningPreset] = useState<'kobun-material' | undefined>();
  const [planningRequest, setPlanningRequest] = useState(0);
  const [requestedPlanId, setRequestedPlanId] = useState<string>();
  const [planningScreen, setPlanningScreen] = useState<'list'|'new'|'plan'|'sources'>('list');
  function openPlanById(id: string) { if (uploading || c.session && c.busy) return; setPlanningPreset(undefined); setPlanningSources(undefined); setRequestedPlanId(id); setPlanningRequest(value => value + 1); setView('planning'); }
  function consult(sourceIds: string[]) { if (uploading || c.session && c.busy) return; setPlanningPreset(undefined); setRequestedPlanId(undefined); setPlanningSources(sourceIds); setPlanningRequest(value => value + 1); setView('planning'); }
  function createKobun() { if (uploading || c.busy) return; setPlanningPreset('kobun-material'); setRequestedPlanId(undefined); setPlanningSources([]); setPlanningRequest(value => value + 1); setView('planning'); }
  const parent = c.profile.role === 'parent';
  const student = parent ? c.data.profiles.find(p => p.role === 'student') : c.profile;
  const studentId = student?.id ?? '';
  useEffect(() => { updateView('home'); setVisited([]); setSettingsSection('index'); setPlanningPreset(undefined); setPlanningSources(undefined); setRequestedPlanId(undefined); setReviewTopic('all'); setReviewSubject('all'); }, [c.profile.id, c.profile.role]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }); }, [view, c.profile.role, c.currentQuestion?.id, c.session?.completedAt]);
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);
  const locationLabel = c.session ? c.currentQuestion ? '練習中' : '練習の結果' : view === 'planning' ? planningLocation : view === 'settings' ? settingsSection === 'profile' ? profileLocation : SETTINGS_TITLES[settingsSection] : VIEW_TITLES[view];
  const pending = c.data.topics.filter(topic => topic.publicationRequest?.revision && topic.publicationRequest.revision === topic.currentSourceRevision && topic.publishedSourceRevision !== topic.currentSourceRevision).length;
  const nav: { id: View; title: string; icon: ReactNode; badge?: number }[] = parent ? [
    { id: 'home', title: '学習のようす', icon: <LayoutDashboard size={19} /> },
    { id: 'projects', title: '学習プラン', icon: <Target size={19} /> },
    { id: 'library', title: 'ライブラリ', icon: <BookOpen size={19} />, badge: pending },
    { id: 'review', title: '一覧レビュー', icon: <ListChecks size={19} /> },
    { id: 'preview', title: 'ユーザーとして見る', icon: <Eye size={19} /> },
    { id: 'history', title: '学習の記録', icon: <CalendarDays size={19} /> },
    { id: 'planning', title: '問題を作る', icon: <Sparkles size={19} /> },
  ] : [
    { id: 'home', title: '今日の学習', icon: <Sprout size={20} /> },
    { id: 'projects', title: '学習プラン', icon: <Target size={19} /> },
    { id: 'topics', title: 'ライブラリ', icon: <BookOpen size={19} /> },
    { id: 'catalog', title: 'パブリック', icon: <BookMarked size={19} /> },
    { id: 'history', title: '学習の記録', icon: <CalendarDays size={19} /> },
    { id: 'planning', title: '問題を作る', icon: <Sparkles size={19} /> },
  ];
  if (!c.ready || c.authStatus === 'checking') return <main className="loading-screen"><span className="brand-mark"><Sprout size={24} /></span><h1>ひび学習</h1><LoaderCircle className="spin" size={22} /><p>学習の準備をしています</p></main>;
  if (!c.demo && c.authStatus === 'unavailable') return <main className="loading-screen"><span className="brand-mark"><Sprout size={24}/></span><h1>学習データを確認できませんでした</h1><p>{c.authError || '通信状況を確認して、もう一度お試しください。'}</p><button type="button" className="button primary" disabled={c.busy} onClick={() => void c.actions.retryAuth()}><RefreshCw size={17}/>もう一度確認する</button><p>ログインが切れたとは限りません。保存済みの学習記録はそのままです。</p></main>;
  if (!c.demo && c.authStatus === 'unauthenticated') return <Login c={c} />;
  if (parent && view === 'preview') return <div className="learner-preview-shell"><LearnerPreview c={c} initialLearnerId={previewLearnerId} onExit={() => setView('library')} renderPractice={preview => <Practice c={preview} />} /></div>;
  return <PersonalProfileProvider key={`${c.demo ? 'demo' : 'live'}:${c.profile.id}`} profile={c.profile} demo={c.demo}><div className="app-shell">
    <aside className="sidebar">
      <a href={c.demo ? '/?demo=1' : '/'} className="brand"><span className="brand-mark"><Sprout size={23} /></span><span>ひび学習<small>ひとつずつ、自分の力に。</small></span></a>
      <div className="workspace-label">{parent ? '管理者モード' : 'MY STUDY ROOM'}</div>
      <nav aria-label="メインメニュー">{nav.map(item => <button key={item.id} onClick={() => { setPlanningSources(undefined); if (item.id === 'review') openReview(); else setView(item.id); }} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined}>{item.icon}<span>{item.title}</span>{!!item.badge && <span className="nav-count">{item.badge}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="small-note"><span className="tiny-sprout">✦</span><p><PersonalEncouragement occasion="sidebar" fallback="毎日の「わかった」が、明日の自信になる。" /></p></div><button onClick={() => openSettings()} className={`nav-item ${view === 'settings' ? 'active' : ''}`}><Settings2 size={18} /><span>設定</span></button><div className="profile-line"><span className="avatar">{parent ? '保' : (c.profile.name?.slice(0, 1) || '学')}</span><span>{c.profile.name || (parent ? '保護者' : '学習者')}<small>{accountLabel(c.profile)}</small><span className="online-dot" /></span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="mobile-location">{c.session ? <button disabled={c.busy} className="text-button" onClick={() => c.actions.finishSession()}><ArrowLeft size={18} />{c.session.completedAt ? '戻る' : '中断して戻る'}</button> : view !== 'home' ? <button disabled={uploading} className="text-button" onClick={() => setView('home')}><ArrowLeft size={18} />ホーム</button> : <span><Sprout size={20} />ひび学習</span>}<strong>{locationLabel}</strong></div><span className="breadcrumb">{parent ? '管理者モード' : '学習ルーム'}<ChevronRight size={14} />{locationLabel}</span><div className="topbar-right"><span className="topbar-date">{new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Tokyo' }).format(new Date())}</span><button className="text-button" onClick={() => openSettings('guide')}><CircleHelp size={17} />使い方</button><button className="icon-button" aria-label="通知の設定" onClick={() => openSettings('notifications')}><Bell size={20} /></button></div></header>
      {c.demo && <div className="demo-strip"><span><span className="demo-dot" />デモ体験中 <span className="demo-detail">— サンプルの問題と学習記録です。データはこのブラウザに保存されます。</span></span><div className="role-switch" aria-label="デモの表示を切り替え"><button className={!parent ? 'selected' : ''} onClick={() => c.actions.switchRole('student')}>生徒</button><button className={parent ? 'selected' : ''} onClick={() => c.actions.switchRole('parent')}>保護者</button></div></div>}
      {uploading && <div className="app-upload-notice" role="status"><Upload size={17} /><span>教材を保存しています（{c.uploadStatus?.completed} / {c.uploadStatus?.total}件）。完了するまでこの画面でお待ちください。</span></div>}
      <main className="main-content"><AppReleaseNotice busy={c.busy || !!(c.session && !c.session.completedAt) || !!(c.uploadStatus && !['complete', 'failed'].includes(c.uploadStatus.phase))} /><Flash c={c} /><PlanningWorkNotice c={c} onOpenPlan={openPlanById} hidden={!!c.session || (view === 'planning' && planningScreen !== 'list') || uploading} />
        {c.session ? <Practice c={c} /> : <>
          {view === 'home' && (parent ? <ParentHome c={c} student={student} studentId={studentId} navigate={setView} onKobunCreate={createKobun} onKobunReview={openKobunReview} openProfile={() => openSettings('profile')} /> : <StudentHome c={c} studentId={studentId} navigate={setView} openProfile={() => openSettings('profile')} />)}
          {(view === 'topics' || view === 'catalog') && <><PageHeading eyebrow="YOUR LIBRARY" title="ライブラリ" description="自分で作った問題も、共有された問題も、ここから。"><button className="button primary" onClick={() => consult([])}><Sparkles size={17} />問題を作る</button></PageHeading><QuestionLibrary key={view} c={c} initialTab={view === 'catalog' ? 'public' : 'private'} onCreate={() => consult([])} onEdit={id=>openReview(id,true)} onOpenPlan={openPlanById}/></>}
          {view === 'projects' && <LearningProjects c={c} onOpenPlan={openPlanById} onCreate={() => consult([])}/>}
          {view === 'history' && <History c={c} studentId={studentId} student={student} navigate={setView} />}
          {view === 'library' && parent && <Materials c={c} onCreate={() => consult([])} review={openReview} consult={consult} onOpenPlan={openPlanById} />}


          {view === 'menu' && <AppMenu c={c} navigate={setView} openSettings={openSettings} />}
        </>}
        {view === 'review' && !c.session && parent && <div><QuestionReview c={c} initialTopic={reviewTopic} initialSubject={reviewSubject} onOpenPlan={openPlanById} onBack={()=>setView('library')} onPreview={openPreview} onDirtyChange={onReviewDirtyChange} renderEditor={(question, onDirtyChange) => <QuestionEditor key={question.id + ':' + question.version} c={c} question={question} onDirtyChange={onDirtyChange} />} /></div>}
        {visited.includes('planning') && <div hidden={!!c.session || view !== 'planning'}><Planning active={view === 'planning' && !c.session} requestedPlanId={requestedPlanId} onScreenChange={setPlanningScreen} onLocationChange={setPlanningLocation} c={c} initialSourceIds={planningSources} initialPreset={planningPreset} initialRequest={planningRequest} review={openReview} onBack={() => setView('home')} openTopic={id => { void c.actions.startPractice('daily', id); }} /></div>}
        {visited.includes('settings') && <div hidden={!!c.session || view !== 'settings'}><Settings onLocationChange={setProfileLocation} active={view === 'settings' && !c.session} c={c} section={settingsSection} setSection={setSettingsSection} onCreate={() => consult([])} onHome={() => setView('home')} /></div>}
      </main><footer className="page-footer">ひび学習 v{CURRENT_RELEASE.version} <span>小さな積み重ねを、大きな自信に。</span></footer>
    </div>
    {!c.session && <nav className="mobile-nav" aria-label="モバイルメニュー">{([
      { id: 'home', title: 'ホーム', icon: <Sprout size={21} /> },
      { id: 'planning', title: '問題を作る', icon: <Sparkles size={21} /> },
      { id: parent ? 'library' : 'topics', title: 'ライブラリ', icon: <BookOpen size={21} /> },
      { id: 'menu', title: 'メニュー', icon: <Menu size={21} /> },
    ] as {id: View; title: string; icon: ReactNode}[]).map(item => <button key={item.id} disabled={uploading} aria-current={view === item.id || item.id === 'menu' && ['settings', 'history', 'review', 'catalog', 'projects'].includes(view) ? 'page' : undefined} onClick={() => setView(item.id)} className={view === item.id || item.id === 'menu' && ['settings', 'history', 'review', 'catalog', 'projects'].includes(view) ? 'active' : ''}>{item.icon}<span>{item.title}</span>{item.id === 'menu' && !!pending && <i />}</button>)}</nav>}

  </div></PersonalProfileProvider>;
}

function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: ReactNode; children?: ReactNode }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>{children}</div>; }

function StudentHome({ c, studentId, navigate, openProfile }: { c: StudyController; studentId: string; navigate: (v: View) => void; openProfile: () => void }) {
  const stats = learningStats(c.data, studentId);
  const today = stats.attempts.filter(a => dayKey(a.answeredAt) === dayKey());
  const activeDays = new Set(stats.attempts.map(a => dayKey(a.answeredAt)));
  const recent = getDailyActivity(stats.attempts, studentId, 7).map(d => ({ day: d.date, label: new Intl.DateTimeFormat('ja-JP', { weekday: 'short', timeZone: 'Asia/Tokyo' }).format(new Date(`${d.date}T12:00:00+09:00`)) }));
  return <>
    <PageHeading eyebrow="A LITTLE EVERY DAY" title="今日も、少しずつ。" description={<PersonalEncouragement occasion="home" answeredToday={today.length} fallback={`${c.profile.name || 'あなた'}さん、おかえりなさい。今日の「わかった」を増やそう。`} />}><div className="streak-chip"><Flame size={18} />今週 {recent.filter(d => activeDays.has(d.day)).length}日 学習</div></PageHeading>
    <section className="daily-grid">
      <div className="daily-card"><div className="daily-card-top"><span className="card-label"><span className="live-dot" />TODAY’S PRACTICE</span><span className="daily-pill">1セット 10問</span></div><div className="daily-card-body"><div><h2>{!stats.total ? 'まず、練習する問題を選ぼう。' : today.length >= 10 ? '今日の10問、おつかれさま。' : 'まずは、今日の10問。'}</h2><p>{!stats.total ? '今はまだ、練習できる問題がありません。ライブラリから追加するか、自分の目標に合わせて作れます。' : today.length >= 10 ? '今日の目安は達成しました。ここで終えても、余裕があれば続けても大丈夫。' : <>新しい問題と、覚えておきたい復習を。<br />一問ずつ、自分のペースで進めよう。</>}</p></div><div className="book-illustration" aria-hidden="true"><div className="book-cover"><Sprout size={37} strokeWidth={1.5} /><span>ONE<br />STEP<br />A DAY.</span></div><span className="book-spark one">✦</span><span className="book-spark two">✧</span><span className="book-line" /></div></div>{!stats.total ? <button className="daily-start" onClick={() => navigate('catalog')}>ライブラリから問題を選ぶ<ArrowRight size={18} /></button> : today.length >= 10 ? <><button className="daily-start" onClick={() => navigate('history')}>今日の記録を見る<ArrowRight size={18} /></button><button className="daily-extra" disabled={c.busy} onClick={() => c.actions.startPractice('extra')}>余裕があれば、もう10問</button></> : <button className="daily-start" disabled={c.busy} onClick={() => c.actions.startPractice('daily')}>{c.busy ? '練習を準備しています' : '今日の10問をはじめる'}<ArrowRight size={18} /></button>}<p className="daily-footnote"><Clock3 size={13} />途中まででも、回答は記録されます</p></div>
      <div className="today-panel"><div className="section-label"><Target size={18} /><h2>今日の積み重ね</h2></div><div className="today-number">{today.length}<span>/ 10問</span><span className="today-check">{today.length >= 10 ? <CheckCircle2 size={25} /> : <Sprout size={25} />}</span></div><ProgressBar value={Math.min(100, today.length * 10)} label="今日の10問の達成率" /><p className="muted small">{today.length >= 10 ? '今日の目標達成。いい積み重ね！' : today.length ? `あと${10 - today.length}問で、今日の目標達成。` : '一問目から、今日の一歩。'}</p><div className="week-days">{recent.map(d => <div key={d.day}><span>{d.label}</span><i className={`${activeDays.has(d.day) ? 'done' : ''} ${d.day === dayKey() ? 'today' : ''}`}>{activeDays.has(d.day) ? <Check size={14} strokeWidth={3} /> : '·'}</i></div>)}</div></div>
    </section>
    <button className="review-banner" onClick={() => navigate('projects')}><span className="review-banner-icon"><Target size={23}/></span><span><strong>学習プランごとの進み具合</strong><small>「中間テスト」などのタグで計画をまとめて確認</small></span><span className="review-banner-link">開く<ArrowRight size={17}/></span></button>
    <div className="home-shortcuts"><button onClick={() => navigate('planning')}><Sparkles size={20} /><span><strong>問題を作る</strong><small>目的を選んでAIに提案してもらう</small></span><ArrowRight size={18} /></button><button onClick={() => navigate(c.profile.role === 'parent' ? 'library' : 'catalog')}><BookOpen size={20} /><span><strong>ライブラリを開く</strong><small>問題集と教材ストックを管理</small></span><ArrowRight size={18} /></button></div><button className="optional-profile text-button" onClick={openProfile}><Settings2 size={15} />自分に合う声かけを設定する<ChevronRight size={15} /></button>
    <div className="quick-actions"><button onClick={() => c.actions.startPractice('weak')} disabled={!stats.weak || c.busy}><span className="quick-icon"><RefreshCw size={20} /></span><span><strong>苦手を、得意に。</strong><small>{stats.weak ? '間違えた問題をもう一度' : '今は苦手な問題がありません'}</small></span><span className="quick-count">{stats.weak}問</span><ArrowRight size={17} /></button><button onClick={() => navigate('history')}><span className="quick-icon peach"><TrendingUp size={20} /></span><span><strong>ここまでの成長</strong><small>自分の積み重ねを振り返る</small></span><ArrowRight size={17} /></button></div>
    <div className="section-heading"><div><h2>取り組んでいる問題集</h2><p>気になるテーマから、はじめよう。</p></div><button className="text-button" onClick={() => navigate('topics')}>すべて見る<ArrowRight size={16} /></button></div>
    <TopicGrid c={c} studentId={studentId} limit={3} />
    <div className="gentle-note"><span><Sprout size={19} /></span><p>一度できた問題も、日を空けてもう一度。<br className="mobile-only" />少しずつ、しっかり覚えていこう。</p></div>
  </>;
}

function TopicGrid({ c, studentId, limit }: { c: StudyController; studentId: string; limit?: number }) {
  const topics = c.data.topics.filter(t => learningStats(c.data, studentId, t.id).total > 0).slice(0, limit);
  if (!topics.length) return <Empty title="自分に合う問題を作ろう">「学習相談」で科目や内容を選ぶと、AIが問題の案を提案します。</Empty>;
  return <div className="topic-grid">{topics.map(topic => { const s = learningStats(c.data, studentId, topic.id); return <article className="topic-card" key={topic.id}><div className="topic-card-top"><IconBadge className={subjectClass(topic.subject)}>{topic.subject === '英語' ? <span className="alphabet">Aa</span> : <BookMarked size={23} />}</IconBadge><SubjectBadge subject={topic.subject} /></div><h3>{topic.title}</h3><p className="topic-description">{topic.audienceUserId && <span className="self-study-label">自習用 </span>}{topic.description || '一問ずつ、理解を深めよう。'}</p><div className="topic-progress-label"><span>取り組んだ問題</span><strong>{s.answered}<span> / {s.total}問</span></strong></div><ProgressBar value={s.total ? s.answered / s.total * 100 : 0} label={`${topic.title}の回答済み割合`} /><div className="topic-card-bottom"><span>初回正答率 <b>{percent(s.firstCorrect, s.first)}</b></span><button className="round-arrow" aria-label={`${topic.title}を練習する`} disabled={c.busy} onClick={() => c.actions.startPractice('daily', topic.id)}><ArrowRight size={18} /></button></div></article>; })}</div>;
}

function Practice({ c }: { c: StudyController }) {
  const [selected, setSelected] = useState<number | null>(null);
  const q = c.currentQuestion;
  useEffect(() => { setSelected(null); }, [q?.id, c.session?.id]);
  const session = c.session!;
  const attempts = c.data.attempts.filter(a => a.sessionId === session.id);
  const completed = new Set(attempts.map(a => a.questionId)).size;
  const index = q ? session.questionIds.indexOf(q.id) : session.questionIds.length;
  const topic = c.data.topics.find(t => t.id === q?.topicId);
  const testTopic = c.profile.role === 'parent' ? c.data.topics.find(t => t.testOnly && c.data.questions.some(item => item.topicId === t.id && session.questionIds.includes(item.id))) : undefined;
  if (!q) return <div className="session-complete"><div className="complete-emblem"><Sprout size={44} strokeWidth={1.5} /></div><p className="eyebrow">ONE STEP FORWARD</p><h1>今日の一歩、おつかれさま。</h1><p>{c.preview ? 'プレビューの結果です。本人の学習記録には保存していません。' : testTopic ? '管理者のテスト記録です。学習者の成績には入りません。' : '取り組んだ記録は、ちゃんと残っています。'}</p><div className="result-numbers"><div><strong>{completed}</strong><span>取り組んだ問題</span></div><div><strong>{attempts.filter(a => a.correct).length}<small> / {attempts.length}</small></strong><span>正解した問題</span></div><div><strong>{percent(attempts.filter(a => a.correct).length, attempts.length)}</strong><span>今回の正答率</span></div></div><div className="result-note"><RefreshCw size={20} /><p>{c.preview ? '通常の学習では、間違えた問題を次の復習へ回します。この試し解きでは本人の復習予定も変わりません。' : <>間違えた問題は、次の復習へ。<br />一度正解した後も、間隔を空けて練習します。</>}</p></div><div className="result-actions"><button className="button primary" disabled={c.busy} onClick={() => c.actions.finishSession()}>今日はここまで・戻る</button><button className="button secondary" disabled={c.busy} onClick={() => c.actions.startPractice('extra', testTopic?.id)}>もう10問やってみる<ArrowRight size={17} /></button></div></div>;
  return <div className="practice-wrap"><div className="practice-top"><button className="text-button" disabled={c.busy} onClick={() => c.actions.finishSession()}><ArrowLeft size={17} />中断して戻る</button><span>{testTopic ? '管理者だけのテスト' : session.mode === 'weak' ? '苦手な問題の復習' : '今日の練習'}<b>{index + 1} / {session.questionIds.length}</b></span></div><ProgressBar value={completed / session.questionIds.length * 100} label="練習の進み具合" /><div className="question-card"><div className="question-meta">{topic && <SubjectBadge subject={topic.subject} />}<span>{topic?.title}</span><span className="question-number">QUESTION {String(index + 1).padStart(2, '0')}</span></div>{q.testOnly ? <div className="self-study-notice">管理者のテスト用です。学習者には表示されず、学習成績にも入りません。</div> : q.audienceUserId && <div className="self-study-notice">学習相談から作成した自習問題です。</div>}<h1 className="question-prompt">{q.prompt}</h1><EnglishAudio questionId={q.id} sessionId={session.id} prompt={q.prompt} choices={q.choices} enabled={topic?.subject === '英語'} deviceOnly={c.preview} /><div className="choices">{q.choices.map((choice, i) => { const correct = !!c.feedback && i === c.feedback.correctIndex; const wrong = !!c.feedback && selected === i && !correct; return <button key={i} className={`choice ${selected === i ? 'chosen' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`} disabled={!!c.feedback || c.busy} onClick={() => setSelected(i)} aria-pressed={selected === i}><span className="choice-label">{String.fromCharCode(65 + i)}</span><span>{choice}</span>{correct ? <CheckCircle2 size={20} /> : wrong ? <X size={20} /> : selected === i ? <Check size={20} /> : null}</button>; })}</div>{!c.feedback ? <div className="answer-row"><span>答えをひとつ選んでください</span><button className="button primary" disabled={selected === null || c.busy} onClick={() => selected !== null && c.actions.answer(selected)}>{c.busy ? <LoaderCircle className="spin" size={17} /> : null}答え合わせ<ArrowRight size={17} /></button></div> : <div className={`answer-feedback ${c.feedback.correct ? 'is-correct' : 'is-wrong'}`} role="status"><div className="feedback-title">{c.feedback.correct ? <CheckCircle2 size={24} /> : <RefreshCw size={23} />}<h2>{c.feedback.correct ? '正解！ その調子。' : '次の「わかった」につなげよう。'}</h2></div>{!c.feedback.correct && <p className="correct-answer">正解：{String.fromCharCode(65 + c.feedback.correctIndex)}. {q.choices[c.feedback.correctIndex]}</p>}<p>{c.feedback.explanation}</p>{q.learningPoint && <div className="learning-point"><span>覚えるポイント</span>{q.learningPoint}</div>}<div className="feedback-bottom"><small>{c.preview ? '試し解きです。本人の成績や復習予定は変わりません。' : c.feedback.correct ? '日を空けた復習で、しっかり定着。' : 'この問題は、後日の復習に追加されます。'}</small><button className="button primary" disabled={c.busy} onClick={() => c.actions.nextQuestion()}>{index + 1 === session.questionIds.length ? '今回の結果を見る' : '次の問題へ'}<ArrowRight size={17} /></button></div></div>}</div></div>;
}

function ParentHome({ c, student, studentId, navigate, openProfile, onKobunCreate, onKobunReview }: { c: StudyController; student?: Profile; studentId: string; navigate: (v: View) => void; openProfile: () => void; onKobunCreate: () => void; onKobunReview: () => void }) {
  const s = learningStats(c.data, studentId);
  const today = s.attempts.filter(a => dayKey(a.answeredAt) === dayKey());
  const last = s.attempts.at(-1)?.answeredAt;
  const requests = c.data.topics.filter(topic => topic.publicationRequest?.revision && topic.publicationRequest.revision === topic.currentSourceRevision && topic.publishedSourceRevision !== topic.currentSourceRevision).length;
  return <><PageHeading eyebrow="GROWING, DAY BY DAY" title="学びの積み重ねを、見守る。" description={<PersonalEncouragement occasion="home" fallback={`${student?.name || 'お子さま'}さんの学習状況を確認できます。`} />}><button className="button primary" onClick={() => navigate('planning')}><Sparkles size={17} />問題を作る</button></PageHeading>
    <AdminWorkspaceGuide onKobunCreate={onKobunCreate} onKobunReview={onKobunReview} onCreate={() => navigate('planning')} onReview={() => navigate('review')} onLibrary={() => navigate('library')} onPreview={() => navigate('preview')} />
    <div className="home-shortcuts"><button onClick={() => navigate('planning')}><Sparkles size={20} /><span><strong>問題を作る</strong><small>目的を選んでAIに提案してもらう</small></span><ArrowRight size={18} /></button><button onClick={() => navigate(c.profile.role === 'parent' ? 'library' : 'catalog')}><BookOpen size={20} /><span><strong>ライブラリを開く</strong><small>問題集と教材ストックを管理</small></span><ArrowRight size={18} /></button></div><button className="optional-profile text-button" onClick={openProfile}><Settings2 size={15} />自分に合う声かけを設定する<ChevronRight size={15} /></button>
    {requests > 0 && <button className="review-banner" onClick={() => navigate('library')}><span className="review-banner-icon"><ListChecks size={23} /></span><span><strong>{requests}件の公開依頼が届いています</strong><small>ライブラリで内容を見て、問題集単位で公開できます。</small></span><span className="review-banner-link">確認する<ArrowRight size={17} /></span></button>}
    <div className="stat-grid"><Stat icon={<Sprout size={20} />} label="今日の回答数" value={String(today.length)} unit="問" note={today.length >= 10 ? '今日の目標を達成しました' : '毎日の目安は10問'} /><Stat icon={<Target size={20} />} label="初回の正答率" value={percent(s.firstCorrect, s.first)} note={`初めて回答した ${s.first} 問から集計`} /><Stat icon={<RefreshCw size={20} />} label="復習の正答率" value={percent(s.reviewCorrect, s.review)} note={`日を空けた復習 ${s.review} 回から集計`} /><Stat icon={<BookOpen size={20} />} label="出題率" value={`${s.coverage}%`} note={`全${s.total}問中 ${s.exposed}問を出題済み`} /></div>
    <div className="parent-middle"><section className="panel activity-panel"><div className="panel-heading"><div><h2>毎日の学習</h2><p>直近14日間の回答数</p></div><span className="chart-legend"><i />回答した問題</span></div><ActivityChart attempts={s.attempts} /></section><section className="panel child-summary"><div className="child-avatar"><GraduationCap size={29} /></div><h2>{student?.name || '学習者'}</h2><span className="student-label">学習者</span><dl><div><dt>最終学習</dt><dd>{last ? dateTime(last) : 'まだ学習していません'}</dd></div><div><dt>取り組んだ問題</dt><dd>{s.answered}<small> / {s.total}問</small></dd></div><div><dt>復習の時期になった問題</dt><dd>{s.due}<small> 問</small></dd></div><div><dt>まだ苦手な問題</dt><dd>{s.weak}<small> 問</small></dd></div></dl><button className="text-button" onClick={() => navigate('history')}>学習記録を詳しく見る<ArrowRight size={15} /></button></section></div>
    <div className="section-heading"><div><h2>テーマごとの学習状況</h2><p>初回と復習を分けて、理解の変化を見守ります。</p></div></div><TopicTable c={c} studentId={studentId} />
  </>;
}
function Stat({ icon, label, value, unit, note }: { icon: ReactNode; label: string; value: string; unit?: string; note: string }) { return <div className="stat-card"><div className="stat-label">{label}{icon}</div><div className="stat-number">{value}<span>{unit}</span></div><p>{note}</p></div>; }
function ActivityChart({ attempts }: { attempts: Attempt[] }) {
  const days = getDailyActivity(attempts, attempts[0]?.userId ?? '', 14).map(d => ({ key: d.date, day: Number(d.date.slice(-2)), count: d.answers }));
  const max = Math.max(10, ...days.map(d => d.count));
  return <div className="activity-chart"><div className="chart-scale"><span>{max}問</span><span>{Math.round(max / 2)}</span><span>0</span></div><div className="chart-plot"><div className="chart-grid-line top" /><div className="chart-grid-line middle" /><div className="chart-grid-line bottom" />{days.map(d => <div className={`chart-column ${d.key === dayKey() ? 'current' : ''}`} key={d.key}><div className="chart-bar-space"><div className="chart-bar" style={{ height: `${Math.max(d.count ? 3 : 0, d.count / max * 100)}%` }} title={`${d.key}：${d.count}問`}><span>{d.count > 0 ? d.count : ''}</span></div></div><span className="chart-day">{d.day}</span></div>)}</div></div>;
}
function TopicTable({ c, studentId }: { c: StudyController; studentId: string }) { return <div className="table-scroll panel"><table className="data-table"><thead><tr><th>問題集</th><th>出題済み</th><th>初回正答率</th><th>復習正答率</th><th>最終学習</th></tr></thead><tbody>{c.data.topics.filter(t => learningStats(c.data, studentId, t.id).total > 0).map(t => { const s = learningStats(c.data, studentId, t.id); return <tr key={t.id}><td><div className="table-topic"><SubjectBadge subject={t.subject} /><strong>{t.title}</strong></div></td><td><div className="table-coverage"><span>{s.exposed} / {s.total}問</span><ProgressBar value={s.coverage} label={`${t.title}の出題率`} /></div></td><td>{percent(s.firstCorrect, s.first)}</td><td>{percent(s.reviewCorrect, s.review)}</td><td className="muted">{dateTime(s.attempts.at(-1)?.answeredAt)}</td></tr>; })}</tbody></table>{!c.data.topics.length && <Empty title="まだ問題集がありません">教材を追加すると、ここに進み具合が表示されます。</Empty>}</div>; }

function History({ c, studentId, student, navigate }: { c: StudyController; studentId: string; student?: Profile; navigate: (view: View) => void }) {
  const [topicId, setTopicId] = useState('all');
  const [filter, setFilter] = useState('all');
  const s = learningStats(c.data, studentId, topicId === 'all' ? undefined : topicId);
  const qs = learnerQuestions(c.data, studentId).filter(q => isPracticeReadyQuestion(q) && (topicId === 'all' || q.topicId === topicId)).filter(q => { const h = questionHistory(s.attempts, q.id); return filter === 'all' || (filter === 'weak' && h.wrong > 0) || (filter === 'new' && !h.rows.length) || (filter === 'due' && !!h.nextReviewAt && Date.parse(h.nextReviewAt) <= Date.now()); });
  return <><PageHeading eyebrow="YOUR LEARNING STORY" title="学習の記録" description={`${c.profile.role === 'parent' ? `${student?.name || 'お子さま'}さんの` : ''}「できた」も「もう一度」も、大切な積み重ね。`} /><div className="stat-grid three"><Stat icon={<BookOpen size={20} />} label="回答した問題" value={String(s.answered)} unit={`/ ${s.total}問`} note="同じ問題は重複して数えません" /><Stat icon={<CheckCircle2 size={20} />} label="これまでの練習" value={String(s.attempts.length)} unit="回答" note="解き直しも含めた回答の数" /><Stat icon={<Clock3 size={20} />} label="最終学習" value={s.attempts.length ? dateTime(s.attempts.at(-1)!.answeredAt) : '—'} note="日時は日本時間で表示しています" /></div><section className="panel activity-panel"><div className="panel-heading"><div><h2>毎日の学習</h2><p>直近14日間の回答数</p></div></div><ActivityChart attempts={s.attempts} /></section><div className="section-heading"><div><h2>問題ごとの記録</h2><p>最後に解いた日時と、これまでの正誤がわかります。</p></div></div><div className="filter-bar"><label><span className="sr-only">問題集</span><select value={topicId} onChange={e => setTopicId(e.target.value)}><option value="all">すべての問題集</option>{c.data.topics.filter(t => learningStats(c.data, studentId, t.id).total > 0).map(t => <option value={t.id} key={t.id}>{t.title}</option>)}</select></label><div className="segmented">{[['all', 'すべて'], ['weak', '誤答あり'], ['due', '復習の時期'], ['new', '未挑戦']].map(([v, label]) => <button key={v} className={filter === v ? 'selected' : ''} onClick={() => setFilter(v)}>{label}</button>)}</div></div><div className="panel history-list">{qs.length ? qs.map(q => { const h = questionHistory(s.attempts, q.id); const t = c.data.topics.find(t => t.id === q.topicId); return <article key={q.id} className="history-row"><span className={`history-status ${!h.rows.length ? 'unseen' : h.last?.correct ? 'success' : 'retry'}`}>{!h.rows.length ? <BookOpen size={18} /> : h.last?.correct ? <Check size={18} /> : <RefreshCw size={18} />}</span><div className="history-question"><small>{t?.title}</small><h3>{q.prompt}</h3><p><Clock3 size={12} />最終回答：{dateTime(h.last?.answeredAt)}</p>{h.nextReviewAt && <p className="next-review"><span><RefreshCw size={12} />次回復習：{dayKey(h.nextReviewAt).replaceAll('-', '/')}</span>{h.streak > 0 && <span className="retention-chip">直近{h.streak}回正解</span>}</p>}</div><div className="history-numbers"><strong>{percent(h.correct, h.rows.length)}<small>正答率</small></strong><span className={`wrong-count ${h.wrong > 0 ? 'has-wrong' : ''}`}>{h.wrong}回<small>間違い</small></span><span className="answer-count">{h.rows.length}回<small>回答</small></span></div></article>; }) : <><Empty title={!s.total ? 'まだ学習する問題がありません' : filter === 'due' ? '今は復習の時期の問題がありません' : filter === 'weak' ? 'この範囲に誤答のある問題はありません' : filter === 'new' ? 'この範囲の問題にはすべて取り組みました' : 'まだ学習する問題がありません'}>{!s.total || filter === 'all' ? 'ライブラリから追加するか、「問題を作る」で準備すると記録を見られます。' : '表示条件を「すべて」に戻すと、ほかの問題と記録を確認できます。'}</Empty>{!s.total ? <div className="empty-action"><button className="button primary" onClick={() => navigate('planning')}>問題を作る<ArrowRight size={16} /></button></div> : filter !== 'all' && <div className="empty-action"><button className="button secondary" onClick={() => setFilter('all')}>すべての記録を見る<ArrowRight size={16} /></button></div>}</>}</div><p className="under-note">正解した後も復習は続きます。解説を見た直後の回答だけで、定着したとは判定しません。</p></>;
}

function Materials({ c, onCreate, review, consult, onOpenPlan }: { c: StudyController; onCreate: () => void; review: (topicId?: string, includePublished?: boolean) => void; consult: (ids: string[]) => void; onOpenPlan: (id: string) => void }) {
  const [tab, setTab] = useState<'banks' | 'stock'>('banks');
  return <><PageHeading eyebrow="YOUR LIBRARY" title="ライブラリ" description="問題集を使う・共有する。元の教材もここに保存できます。"><button className="button primary" onClick={onCreate}><Sparkles size={17} />問題を作る</button></PageHeading><div className="planning-tabs" role="tablist" aria-label="問題集と教材"><button type="button" role="tab" aria-selected={tab === 'banks'} className={tab === 'banks' ? 'active' : ''} onClick={() => setTab('banks')}>問題集</button><button type="button" role="tab" aria-selected={tab === 'stock'} className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>教材ストック</button></div>{tab === 'stock' ? <SourceBank c={c} onConsult={consult} /> : <QuestionLibrary c={c} onCreate={onCreate} onEdit={id=>review(id,true)} onOpenPlan={onOpenPlan}/>}</>;
}

function QuestionEditor({ c, question: q, onDirtyChange }: { c: StudyController; question: Question; onDirtyChange?: (dirty: boolean) => void }) {
  const [prompt, setPrompt] = useState(q.prompt); const [choices, setChoices] = useState(q.choices); const [correctIndex, setCorrectIndex] = useState(q.correctIndex); const [explanation, setExplanation] = useState(q.explanation); const [learningPoint, setLearningPoint] = useState(q.learningPoint); const [sourceId, setSourceId] = useState(q.sourceIds[0] ?? '');
  const [sourceNote, setSourceNote] = useState(q.sourceNote);
  const [reviewed, setReviewed] = useState(!q.needsReview);
  const [archived, setArchived] = useState(q.status === 'archived');
  const sources = c.data.sources.filter(s => q.sourceIds.includes(s.id));
  const source = sources.find(s => s.id === sourceId) ?? sources[0];
  const dirty = sourceNote !== q.sourceNote || reviewed !== !q.needsReview || archived !== (q.status === 'archived') || prompt !== q.prompt || choices.some((choice, i) => choice !== q.choices[i]) || correctIndex !== q.correctIndex || explanation !== q.explanation || learningPoint !== q.learningPoint;
  const dirtyCallback = useRef(onDirtyChange); dirtyCallback.current = onDirtyChange;
  useEffect(() => { dirtyCallback.current?.(dirty); return () => dirtyCallback.current?.(false); }, [dirty]);
  const valid = !!prompt.trim() && choices.length >= 2 && choices.every(choice => choice.trim()) && new Set(choices.map(choice => choice.trim())).size === choices.length && !!explanation.trim() && correctIndex >= 0 && correctIndex < choices.length;
  const hint = !valid ? '問題文・選択肢・正解・解説を入力すると保存できます。' : dirty ? '未保存の変更があります。' : '保存済みです。直したいところだけ変更できます。';
  async function save() { await c.actions.updateQuestion(q.id, { prompt, choices, correctIndex, explanation, learningPoint, sourceNote, needsReview: !reviewed, status: archived ? 'archived' : reviewed ? 'approved' : 'draft' }); }
  if (c.data.topics.find(topic => topic.id === q.topicId)?.libraryPublished) return <section className="panel question-editor"><div className="panel-heading"><h2>パブリックの公開版</h2><span className="status-badge published">登録ユーザー向け</span></div><h3>{q.prompt}</h3><ol type="A">{q.choices.map((choice, i) => <li key={i}>{choice}{i === q.correctIndex && ' ✓ 正解'}</li>)}</ol><p>{q.explanation}</p>{q.learningPoint && <p>{q.learningPoint}</p>}<p className="under-note">公開時の内容です。更新するときは、プライベートの元の問題集を編集してから、問題集単位で公開してください。</p></section>;
  return <div className="review-editor"><details className="source-preview panel" open={sources.length > 0 || undefined}><summary className="source-preview-toggle"><FileText size={18} />原本・作問の根拠を見る</summary><div className="panel-heading"><h2><FileText size={17} />元の資料</h2>{sources.length > 1 && <select value={sourceId} onChange={e => setSourceId(e.target.value)} aria-label="原本を選ぶ">{sources.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select>}</div>{source?.previewUrl ? <SourcePreview source={source} /> : <div className="source-placeholder"><FileText size={37} strokeWidth={1.2} /><h3>{source?.name || '元の資料'}</h3><p>{c.demo ? '操作確認用のサンプルです。' : q.sourceIds.length ? '教材ストックから原本を確認できます。' : '学習目標と相談内容から作成した問題です。'}</p></div>}<div className="source-evidence"><strong>作問の根拠</strong><p>{q.sourceNote || '出典の記載はありません。'}</p></div></details><div className="question-editor panel"><div className="panel-heading"><h2>問題と解説を編集</h2><span className="count-pill">プライベート</span></div><label>問題文<textarea disabled={c.busy} rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} /></label><fieldset className="edit-choices"><legend>選択肢 <span>正解を変える場合は選び直せます</span></legend>{choices.map((choice, i) => <div key={i}><label className={`answer-radio ${correctIndex === i ? 'checked' : ''}`}><input disabled={c.busy} type="radio" name={`correct-${q.id}`} checked={correctIndex === i} onChange={() => setCorrectIndex(i)} aria-label={`選択肢${String.fromCharCode(65 + i)}を正解にする`} /><span>{correctIndex === i ? <Check size={15} /> : String.fromCharCode(65 + i)}</span></label><input disabled={c.busy} value={choice} onChange={e => setChoices(choices.map((old, j) => j === i ? e.target.value : old))} aria-label={`選択肢${String.fromCharCode(65 + i)}`} /></div>)}</fieldset><label>解説<textarea disabled={c.busy} rows={4} value={explanation} onChange={e => setExplanation(e.target.value)} /></label><label>覚えるポイント<input disabled={c.busy} value={learningPoint} onChange={e => setLearningPoint(e.target.value)} /></label><label>作問の根拠・原本の場所 <span className="optional">任意</span><textarea disabled={c.busy} rows={3} maxLength={3000} value={sourceNote} onChange={e => setSourceNote(e.target.value)} placeholder="例：写真2の3行目。『む』は主語と文脈から意志と判断。読み取りを直した場合もここに記録。" /></label><fieldset className="review-status-options" disabled={c.busy}><legend>内容の確認と出題</legend>{!q.testOnly && <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>原本・正解・解説を確認済みにする</label>}<label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/>この問題を練習から外す（非表示）</label><p>確認済みは公開設定ではありません。非表示は本人の新しい練習と次回の公開対象から外れます。既存の公開版は変わりません。</p></fieldset><p className="action-hint" role="status">{hint}</p><div className="editor-actions"><button type="button" className="button primary" disabled={!valid || !dirty || c.busy} onClick={()=>void save()}>{c.busy ? '保存しています' : dirty ? '変更を保存' : '保存済み'}{!dirty && <Check size={16}/>}</button></div><p className="under-note">編集は任意です。ほかの登録ユーザーと共有するときは、ライブラリから問題集単位で公開できます。</p></div></div>;
}
function SourcePreview({ source }: { source: SourceDocument }) { return <div className="source-document">{source.mimeType === 'application/pdf' ? <><iframe src={source.previewUrl} title={source.name} /><a className="text-button" href={source.previewUrl} target="_blank" rel="noreferrer">PDFを別画面で開く<ArrowRight size={14} /></a></> : <a href={source.previewUrl} target="_blank" rel="noreferrer"><img src={source.previewUrl} alt={`教材の原本：${source.name}`} /><span>タップして拡大<ArrowRight size={14} /></span></a>}</div>; }

function MenuRow({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return <button className="menu-row" onClick={onClick}>{icon}<span><strong>{title}</strong><small>{description}</small></span><ChevronRight size={18} /></button>;
}

function AppMenu({ c, navigate, openSettings }: { c: StudyController; navigate: (view: View) => void; openSettings: (section?: SettingsSection) => void }) {
  return <><PageHeading eyebrow="MENU" title="何をしますか？" description="使いたい機能を選んでください。" /><div className="task-menu">
    {c.profile.role === 'parent' && <MenuRow icon={<ListChecks size={23} />} title="一覧レビュー" description="問題の傾向・順番・正解を見渡して編集" onClick={() => navigate('review')} />}
    {c.profile.role === 'parent' && <MenuRow icon={<Eye size={23} />} title="ユーザーとして見る" description="対象の学習者を選び、見える問題と解き方を確認" onClick={() => navigate('preview')} />}
    <MenuRow icon={<Target size={23} />} title="学習プラン" description="中間テストなどのタグでまとめ、進み具合を確認" onClick={() => navigate('projects')} />
    {c.profile.role === 'parent' && !c.demo && <Link className="menu-row" href="/admin/eiken-samples"><BookOpen size={23} /><span><strong>英検の問題・音声サンプル</strong><small>2級・準1級のReading / Listening / Writingを試す</small></span><ChevronRight size={18} /></Link>}
    {c.profile.role === 'parent' && !c.demo && <Link className="menu-row" href="/admin/vocabulary-samples"><BookMarked size={23} /><span><strong>ボキャブラリーマラソンの見本</strong><small>単語と例文3つを聞いて、使い方を練習</small></span><ChevronRight size={18} /></Link>}
    <MenuRow icon={<BookMarked size={23} />} title="パブリックライブラリ" description="登録ユーザーに共有された問題集を自分の学習に追加" onClick={() => navigate('catalog')} />
    <MenuRow icon={<CalendarDays size={23} />} title="学習の記録" description="正答率・苦手・取り組んだ日を確認" onClick={() => navigate('history')} />
    <MenuRow icon={<Settings2 size={23} />} title="設定" description="プロフィール・通知・アカウント" onClick={() => openSettings()} />
    <MenuRow icon={<CircleHelp size={23} />} title="使い方" description="問題の作り方・ホーム画面への追加" onClick={() => openSettings('guide')} />
  </div></>;
}

function Settings({ c, section, setSection, onCreate, onHome, active, onLocationChange }: { onLocationChange: (label: string) => void; active: boolean; c: StudyController; section: SettingsSection; setSection: (section: SettingsSection) => void; onCreate: () => void; onHome: () => void }) {
  const [reset, setReset] = useState(false);
  const [profileVisited, setProfileVisited] = useState(section === 'profile');
  useEffect(() => { if (section === 'profile') setProfileVisited(true); window.scrollTo({top: 0, behavior: 'auto'}); }, [section]);
  const titles: Record<SettingsSection, string> = {index: '設定', profile: '自分のプロフィール', usage: 'AIの利用状況', releases: 'バージョン・更新履歴', guide: '使い方', account: 'アカウント', notifications: '通知・ホーム画面', data: '学習データ'};
  const entries: { id: SettingsSection; title: string; description: string; icon: ReactNode }[] = [
    {id: 'profile', title: '自分のプロフィール', description: '目標・興味・好きな声かけ', icon: <GraduationCap size={23} />},
    {id: 'guide', title: '使い方', description: '問題を作るところから練習まで', icon: <CircleHelp size={23} />},
    {id: 'notifications', title: '通知・ホーム画面', description: 'iPhoneでアプリとして使う', icon: <Bell size={23} />},
    {id: 'account', title: 'アカウント', description: `${c.profile.name} · ${accountLabel(c.profile)}`, icon: <ShieldCheck size={23} />},
    {id: 'releases', title: 'バージョン・更新履歴', description: `現在 v${CURRENT_RELEASE.version}`, icon: <RefreshCw size={23} />},
    ...(c.profile.role === 'parent' ? [{id: 'data' as const, title: '学習データ', description: '問題・回答履歴の書き出し', icon: <ArrowDownToLine size={23} />}]: []),
    ...(c.profile.accessLevel === 'superuser' && !c.demo ? [{id: 'usage' as const, title: 'AIの利用状況', description: '利用量と概算料金 · Super User', icon: <TrendingUp size={23} />}]: []),
  ];
  return <>
    {section !== 'profile' && <><div className="section-back"><button className="text-button" onClick={() => section === 'index' ? onHome() : setSection('index')}><ArrowLeft size={17} />{section === 'index' ? 'ホームに戻る' : '設定一覧に戻る'}</button></div>
    <PageHeading eyebrow="YOUR PREFERENCES" title={titles[section]} description={section === 'index' ? '変更したい項目を選んでください。' : ''} /></>}
    {section === 'index' && <div className="task-menu">{entries.map(item => <MenuRow key={item.id} {...item} onClick={() => setSection(item.id)} />)}{c.profile.role === 'parent' && !c.demo && <><Link className="menu-row" href="/admin/eiken-samples"><BookOpen size={23}/><span><strong>英検の問題・音声サンプル</strong><small>読む・聞く・書くを試す</small></span><ChevronRight size={18}/></Link><Link className="menu-row" href="/admin/vocabulary-samples"><BookMarked size={23}/><span><strong>ボキャブラリーマラソンの見本</strong><small>単語と例文3つを音声で確認</small></span><ChevronRight size={18}/></Link></>}</div>}
    {(profileVisited || section === 'profile') && <div hidden={section !== 'profile'}><PersonalProfilePanel onLocationChange={onLocationChange} onDone={onCreate} doneLabel="問題を作るへ進む" onBack={() => setSection('index')} /></div>}
    <div className="settings-stack">
      {section === 'usage' && c.profile.accessLevel === 'superuser' && <AiUsagePanel profile={c.profile} demo={c.demo} />}
      {section === 'releases' && <ReleaseNotesCard />}
      {section === 'guide' && active && <><div className="flow-start-card"><h2>問題づくりは、4つのステップ</h2><p>科目と目的 → 教材と内容 → ペース → 確認。AIの案を見て、気に入ったら問題を作ります。</p><button className="button primary" onClick={onCreate}>問題を作るへ進む<ArrowRight size={17} /></button></div><StudyGuide /></>}
      {section === 'account' && <><section className="panel settings-panel"><IconBadge><GraduationCap size={23} /></IconBadge><div><h2>アカウント</h2><p>{c.profile.name} · {accountLabel(c.profile)}</p><small>{c.demo ? 'デモデータは、このブラウザだけに保存されています。' : '学習記録は家族のアカウントに保存されます。'}</small></div>{!c.demo && <button className="button secondary" onClick={() => c.actions.signOut()}><LogOut size={17} />ログアウト</button>}</section>{c.demo && <section className="panel demo-settings"><h2>デモ体験について</h2><p>生徒・保護者の画面と学習の流れを、サンプルデータでお試しいただけます。AIの読み取り・家族間の共有・本番のプッシュ通知には、本番アカウントとクラウドの設定が必要です。</p><div className="demo-settings-actions"><a href="/" className="button secondary">本番のログイン画面へ<ArrowRight size={15} /></a>{reset ? <><span className="small">デモの練習記録も消去されます。</span><button className="button danger" onClick={() => { void c.actions.resetDemo(); setReset(false); }}>初期化する</button><button className="text-button" onClick={() => setReset(false)}>戻る</button></> : <button className="text-button" onClick={() => setReset(true)}><RefreshCw size={15} />デモを最初から</button>}</div></section>}</>}
      {section === 'notifications' && <><section className="panel settings-panel"><IconBadge><Bell size={22} /></IconBadge><div><h2>新しい問題のお知らせ</h2><p>公開された問題をプッシュ通知でお知らせします。</p><small>iPhoneではSafariからホーム画面に追加した後に許可してください。</small></div><button className="button secondary" disabled={c.busy} onClick={() => c.actions.requestNotifications()}>通知を設定</button></section><section className="panel install-guide"><h2><BookMarked size={20} />iPhoneのホーム画面に追加</h2><ol><li>このページをSafariで開きます。</li><li>共有ボタンから「ホーム画面に追加」を選びます。</li><li>ホーム画面の「ひび学習」から、いつでも学習できます。</li></ol><p className="under-note">通知を許可しなくても、アプリを開けば新しい問題を確認できます。</p></section></>}
      {section === 'data' && <>{c.profile.role === 'parent' && <section className="panel settings-panel"><IconBadge><ArrowDownToLine size={22} /></IconBadge><div><h2>学習データの書き出し</h2><p>問題・回答履歴・教材情報を保存できます。</p><small>教材の写真・PDF本体は、この書き出しには含まれません。</small></div><button className="button secondary" onClick={() => c.actions.exportData()}>書き出す</button></section>}</>}
    </div>
  </>;
}

function Login({ c }: { c: StudyController }) {
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loginPending) return;
    setLoginPending(true); setLoginError('');
    try { await c.actions.signIn(); } catch { setLoginError('Googleのログイン画面を開けませんでした。接続を確認して、もう一度お試しください。'); } finally { setLoginPending(false); }
  }
  return <main className="login-screen"><a href="/" className="brand login-brand"><span className="brand-mark"><Sprout size={25} /></span><span>ひび学習<small>ひとつずつ、自分の力に。</small></span></a><div className="login-layout"><div className="login-intro"><p className="eyebrow">A LITTLE EVERY DAY</p><h1>今日の10問が、<br />明日の自信に。</h1><p>家族が届ける、自分だけの問題集。<br />小さな「わかった」を、毎日重ねよう。</p><div className="login-features"><span><CheckCircle2 size={18} />写真からつくる問題集</span><span><CheckCircle2 size={18} />忘れる前に、もう一度</span><span><CheckCircle2 size={18} />成長を家族で見守る</span></div><div className="login-art" aria-hidden="true"><div className="login-book"><Sprout size={45} strokeWidth={1.4} /><span>EVERY DAY,<br />A LITTLE<br />FURTHER.</span></div><span>✦</span><div className="login-note"><Check size={19} />今日も、ひとつ前へ。</div></div></div><section className="login-card"><IconBadge><BookOpen size={25} /></IconBadge><h2>おかえりなさい。</h2><p>家族のアカウントでログインしてください。</p><form onSubmit={submit}><Flash c={c} />{loginError && <p className="flash error" role="alert">{loginError}</p>}<button className="button primary full" disabled={loginPending || c.busy}>{loginPending ? <LoaderCircle className="spin" size={18} /> : <GoogleMark />}{loginPending ? 'Googleのログイン画面を開いています' : 'Googleアカウントでログイン'}<ArrowRight size={17} /></button></form><p className="login-account-note">登録したご家族のGoogleアカウントで利用できます。</p><div className="login-divider"><span>まずは使い心地を見てみる</span></div><a className="button secondary full" href="/?demo=1">サンプルで試す<ArrowRight size={17} /></a><p className="login-demo-note">サンプルデータで、生徒と保護者の画面を試せます。</p></section></div><footer className="login-footer"><span>ひび学習 · 家族のための、小さな学習室。</span><nav aria-label="アプリについて"><Link href="/privacy">プライバシーポリシー</Link><Link href="/terms">利用条件</Link></nav></footer></main>;
}

function GoogleMark() { return <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.1-1.4-.2-2.2H12v4.3h5.4a4.5 4.5 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.7ZM12 22c2.7 0 4.9-.9 6.6-2.4l-3.3-2.6c-.9.6-2 .9-3.3.9-2.6 0-4.8-1.7-5.6-4.1H3v2.7A10 10 0 0 0 12 22ZM6.4 13.8a6 6 0 0 1 0-3.6V7.5H3a10 10 0 0 0 0 9l3.4-2.7ZM12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.5 9.5 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.7A6 6 0 0 1 12 6.1Z" /></svg>; }
