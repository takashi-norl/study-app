'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Globe2, LockKeyhole, Pencil, RefreshCw, Send, Upload } from 'lucide-react';
import type { Topic } from '@/lib/types';
import { isPracticeReadyQuestion, mayPracticeLibraryTopic, topicOwnerId } from '@/lib/library-policy';
import type { StudyController } from './controller';
import { SharedLibrary } from './shared-library';
import styles from './question-library.module.css';

export function SetSharingActions({ c, topic }: { c: StudyController; topic: Topic }) {
  const [attempted, setAttempted] = useState(false);
  if (topic.libraryPublished) return null;
  const parent = c.profile.role === 'parent';
  const ownerId = topicOwnerId(c.data, topic);
  const owner = c.data.profiles.find(profile => profile.id === ownerId);
  const own = ownerId === c.profile.id;
  const questions = c.data.questions.filter(question => question.topicId === topic.id && question.status !== 'archived');
  const active = c.data.jobs.some(job => job.topicId === topic.id && (job.status === 'queued' || job.status === 'running'));
  const request = topic.publicationRequest;
  const requested = !!request && request.revision === topic.currentSourceRevision;
  const publicCurrent = !!topic.publishedSourceRevision && topic.publishedSourceRevision === topic.currentSourceRevision;
  const hasPublicVersion = !!topic.publishedSourceRevision || c.data.topics.some(item => item.librarySourceTopicId === topic.id);
  const mayPublish = parent && (owner?.role === 'parent' || !!topic.testOnly || requested);
  const mayRequest = !parent && own;
  if (!parent && !own) return null;
  const disabled = c.busy || active || !questions.length;
  async function share() {
    setAttempted(true);
    const result = parent ? await c.actions.publishLibrary(topic.id) : await c.actions.requestLibraryPublication(topic.id);
    if (result) setAttempted(false);
  }
  return <div className={styles.sharing}>
    <div className={styles.shareState}><span>{publicCurrent ? <><Globe2 size={14}/>パブリックに公開済み</> : requested ? <><Send size={14}/>{parent ? '公開依頼が届いています' : '公開を依頼済み'}</> : hasPublicVersion ? '編集した内容はまだ公開していません' : <><LockKeyhole size={14}/>プライベート</>}</span></div>
    {publicCurrent ? <p>登録ユーザーはパブリックから学習に追加できます。元の問題集はここに残ります。</p>
      : active ? <p>保存した問題は練習できます。問題集の公開・公開依頼は、作成が終わるとできます。</p>
      : !questions.length ? <p>問題が保存されると、問題集単位で公開できます。</p>
      : parent && !mayPublish ? <p>本人から公開依頼が届くと、登録ユーザー向けに公開できます。</p>
      : requested && !parent ? <p>管理者が問題集単位で公開します。待つ間も自分の練習に使えます。</p>
      : <p>{parent ? '問題・解説を登録ユーザーに共有します。原本の写真や相談履歴は共有しません。' : '共有したいときは管理者に公開を依頼できます。自分の練習には依頼不要です。'}</p>}
    {!publicCurrent && (mayPublish || mayRequest) && <button type="button" className={styles.shareButton} disabled={disabled || !parent && requested} onClick={()=>void share()}>{!parent && requested ? <Check size={16}/> : parent ? <Upload size={16}/> : <Send size={16}/>}<span>{parent ? hasPublicVersion ? '公開版を更新する' : '登録ユーザーに公開する' : requested ? '公開を依頼済み' : '公開を依頼する'}</span></button>}
    {attempted && c.error && <p className={styles.error} role="alert">{c.error}</p>}
  </div>;
}

export function QuestionLibrary({ c, initialTab = 'private', onEdit, onCreate, onOpenPlan }: {
  c: StudyController;
  initialTab?: 'private' | 'public';
  onEdit: (topicId: string) => void;
  onCreate: () => void;
  onOpenPlan?: (planId: string) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<string | null>(null);
  async function retry(jobId: string) { if (retryingJob) return; setRetryingJob(jobId); setRetryAttempt(jobId); try { await c.actions.retryGeneration(jobId); } finally { setRetryingJob(null); } }
  const generating = c.data.jobs.some(job => job.requestedBy === c.profile.id && (job.status === 'queued' || job.status === 'running'));
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const parent = c.profile.role === 'parent';
  const topics = c.data.topics.filter(topic => !topic.libraryPublished).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const requested = parent ? topics.filter(topic=>!!topic.publicationRequest && topic.publicationRequest.revision===topic.currentSourceRevision && topic.publishedSourceRevision!==topic.currentSourceRevision).length : 0;
  return <section className={styles.library} aria-label="問題集ライブラリ">
    <div className={styles.tabs} role="tablist" aria-label="問題集の公開範囲">
      <button type="button" role="tab" aria-selected={tab==='private'} onClick={()=>setTab('private')}><LockKeyhole size={16}/><span>プライベート{requested>0&&<small>公開依頼 {requested}</small>}</span></button>
      <button type="button" role="tab" aria-selected={tab==='public'} onClick={()=>setTab('public')}><Globe2 size={16}/><span>パブリック</span></button>
    </div>
    {tab==='public' ? <><p className={styles.intro}>登録ユーザー向けの問題集です。インターネット全体には公開されません。</p><SharedLibrary c={c} onAdded={()=>{}} onOpen={id=>void c.actions.startPractice('daily',id)} onInspect={parent ? onEdit : undefined}/></> : <>
      <p className={styles.intro}>{parent ? '作った問題はそのまま練習できます。管理者は学習者の内容も確認し、届いた公開依頼をここで扱えます。' : '自分で作った問題はここに保存され、そのまま練習できます。管理者は内容と学習履歴を確認できます。'}</p>
      {!topics.length ? <div className={styles.empty}><BookOpen size={28}/><h2>最初の問題集を作ろう。</h2><p>教材を使っても、AIへの相談だけでも始められます。</p><button type="button" className="button primary" onClick={onCreate}>問題を作る<ArrowRight size={16}/></button></div> : <div className={styles.grid}>{topics.map(topic=>{
        const ownerId=topicOwnerId(c.data,topic);
        const owner=c.data.profiles.find(profile=>profile.id===ownerId);
        const questions=c.data.questions.filter(question=>question.topicId===topic.id && question.status!=='archived');
        const count=new Set(questions.map(question=>question.id)).size;
        const activeJob=c.data.jobs.find(job=>job.topicId===topic.id&&(job.status==='queued'||job.status==='running'));
        const active=!!activeJob;
        const failedJob=c.data.jobs.find(job=>job.topicId===topic.id&&job.status==='failed'&&!c.data.jobs.some(next=>next.retryOfJobId===job.id));
        const failed=!!failedJob;
        const canRetry=!!failedJob && failedJob.requestedBy===c.profile.id && count<failedJob.targetCount;
        const canStart=activeJob?.status==='queued' && activeJob.requestedBy===c.profile.id;
        const practice=mayPracticeLibraryTopic(c.data,c.profile,topic)&&questions.some(question=>isPracticeReadyQuestion(question));
        return <article className={styles.card} key={topic.id}>
          <div className={styles.meta}><span className="subject-badge">{topic.subject}</span><span>{owner?.name || '自分'}の問題集{topic.testOnly&&' · テスト用'}</span></div>
          <h2>{topic.title}</h2><p className={styles.description}>{topic.description || '1回10問ずつ、自分のペースで練習できます。'}</p>
          <p className={styles.count}><strong>{count}</strong>問を保存済み{active&&<span> · 作成中</span>}</p>
          <div className={styles.actions}>{practice && <button type="button" className="button primary" disabled={c.busy} onClick={()=>void c.actions.startPractice('daily',topic.id)}>10問練習する<ArrowRight size={16}/></button>}{parent&&count>0&&<button type="button" className="text-button" onClick={()=>onEdit(topic.id)}><Pencil size={15}/>内容を見る・編集</button>}{(active||failed)&&topic.planId&&onOpenPlan&&<button type="button" className="text-button" onClick={()=>onOpenPlan(topic.planId!)}>作成状況を見る<ArrowRight size={15}/></button>}</div>
          {!count&&<p className={styles.small}>問題が保存されると、ここから練習できます。</p>}
          {count>0&&!practice&&parent&&<p className={styles.small}>学習者本人の練習用です。管理者は内容を確認・編集できます。</p>}
          {activeJob&&<div className={styles.work}><p>{canStart ? '作成の開始状況を確認できます。' : '10問ずつ保存しています。保存した問題から練習できます。'}</p><button type="button" className="text-button" disabled={c.busy||c.sync.checking} onClick={()=>void(canStart ? c.actions.resumeGeneration(activeJob.id) : c.actions.refreshStatus())}><RefreshCw size={14}/>{c.busy||c.sync.checking ? '状況を確認しています' : canStart ? '開始を確認する' : '最新の状況を確認'}</button></div>}
          {canRetry&&failedJob&&<div className={styles.work}><p>{generating ? 'ほかの問題の作成が終わると、続きを依頼できます。' : '作成が途中で止まりました。保存した問題を残して、同じ条件で続きを作れます。'}</p><button type="button" className="button secondary" disabled={c.busy||generating||!!retryingJob} onClick={()=>void retry(failedJob.id)}><RefreshCw size={15}/>{retryingJob===failedJob.id ? '依頼を確認しています' : '同じ条件で続きを作る'}</button>{retryAttempt===failedJob.id&&c.error&&<p className={styles.error} role="alert">{c.error}</p>}</div>}
          <SetSharingActions c={c} topic={topic}/>
        </article>;
      })}</div>}
    </>}
  </section>;
}
