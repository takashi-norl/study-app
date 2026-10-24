'use client';

import { useState } from 'react';
import { ArrowRight, BookOpen, LockKeyhole, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { isPracticeReadyQuestion, mayPracticeLibraryTopic, topicOwnerId } from '@/lib/library-policy';
import type { StudyController } from './controller';
import styles from './question-library.module.css';

export function ArrangeTopicButton({c,topicId,onCreated}:{c:StudyController;topicId:string;onCreated:(planId:string)=>void}) {
  const [pending,setPending]=useState(false);
  const [attempted,setAttempted]=useState(false);
  async function arrange(){if(pending||c.busy)return;setPending(true);setAttempted(true);try{const id=await c.actions.arrangeTopic(topicId);if(id){setAttempted(false);onCreated(id);}}finally{setPending(false);}}
  return <span className={styles.arrange}><button type="button" className="text-button" disabled={c.busy||pending} onClick={()=>void arrange()}><Sparkles size={15}/>{pending?'相談を用意しています':'AIと相談してアレンジ'}</button>{attempted&&c.error&&<span className={styles.error} role="alert">{c.error}</span>}</span>;
}

export function QuestionLibrary({ c, onEdit, onCreate, onOpenPlan }: {
  c: StudyController;
  onEdit: (topicId: string) => void;
  onCreate: () => void;
  onOpenPlan?: (planId: string) => void;
}) {
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<string | null>(null);
  async function retry(jobId: string) { if (retryingJob) return; setRetryingJob(jobId); setRetryAttempt(jobId); try { await c.actions.retryGeneration(jobId); } finally { setRetryingJob(null); } }
  const generating = c.data.jobs.some(job => job.requestedBy === c.profile.id && (job.status === 'queued' || job.status === 'running'));
  const topics = c.data.topics.filter(topic => !topic.libraryPublished && topicOwnerId(c.data, topic) === c.profile.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return <section className={styles.library} aria-label="自分の問題集">
    <p className={styles.intro}>自分で作った問題は、そのまま練習・編集できます。問題・教材・相談履歴はほかの利用者に公開されません。</p>
      {!topics.length ? <div className={styles.empty}><BookOpen size={28}/><h2>最初の問題集を作ろう。</h2><p>教材を使っても、AIへの相談だけでも始められます。</p>{!c.preview && <button type="button" className="button primary" onClick={onCreate}>問題を作る<ArrowRight size={16}/></button>}</div> : <div className={styles.grid}>{topics.map(topic=>{
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
          <div className={styles.meta}><span className="subject-badge">{topic.subject}</span><span>自分の問題集{topic.testOnly&&' · テスト用'}</span></div>
          <p className={styles.visibility}><LockKeyhole size={14}/>自分だけの問題集</p>
          <h2>{topic.title}</h2><p className={styles.description}>{topic.description || '1回10問ずつ、自分のペースで練習できます。'}</p>
          <p className={styles.count}><strong>{count}</strong>問を保存済み{active&&<span> · 作成中</span>}</p>
          <div className={styles.actions}>{practice && <button type="button" className="button primary" disabled={c.busy} onClick={()=>void c.actions.startPractice('daily',topic.id)}>10問練習する<ArrowRight size={16}/></button>}{!c.preview&&count>0&&<button type="button" className="text-button" onClick={()=>onEdit(topic.id)}><Pencil size={15}/>一覧でレビュー・編集</button>}{!c.preview&&count>0&&onOpenPlan&&<ArrangeTopicButton c={c} topicId={topic.id} onCreated={onOpenPlan}/>}{!c.preview&&(active||failed)&&topic.planId&&onOpenPlan&&<button type="button" className="text-button" onClick={()=>onOpenPlan(topic.planId!)}>作成状況を見る<ArrowRight size={15}/></button>}</div>
          {!count&&<p className={styles.small}>問題が保存されると、ここから練習できます。</p>}
          {!c.preview&&activeJob&&<div className={styles.work}><p>{canStart ? '作成の開始状況を確認できます。' : '10問ずつ保存しています。保存した問題から練習できます。'}</p><button type="button" className="text-button" disabled={c.busy||c.sync.checking} onClick={()=>void(canStart ? c.actions.resumeGeneration(activeJob.id) : c.actions.refreshStatus())}><RefreshCw size={14}/>{c.busy||c.sync.checking ? '状況を確認しています' : canStart ? '開始を確認する' : '最新の状況を確認'}</button></div>}
          {!c.preview&&canRetry&&failedJob&&<div className={styles.work}><p>{generating ? 'ほかの問題の作成が終わると、続きを依頼できます。' : '作成が途中で止まりました。保存した問題を残して、同じ条件で続きを作れます。'}</p><button type="button" className="button secondary" disabled={c.busy||generating||!!retryingJob} onClick={()=>void retry(failedJob.id)}><RefreshCw size={15}/>{retryingJob===failedJob.id ? '依頼を確認しています' : '同じ条件で続きを作る'}</button>{retryAttempt===failedJob.id&&c.error&&<p className={styles.error} role="alert">{c.error}</p>}</div>}
        </article>;
      })}</div>}
  </section>;
}
