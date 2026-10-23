'use client';

import { ArrowRight, BookOpen, Check, Plus, Sparkles } from 'lucide-react';
import type { StudyController } from './controller';
import styles from './shared-library.module.css';

export function SharedLibrary({ c, onAdded, onOpen, onInspect, onArrange }: { c: StudyController; onAdded: () => void; onOpen: (topicId: string) => void; onInspect?: (topicId: string) => void; onArrange?: (topicId:string)=>Promise<void> }) {
  const topics = c.data.topics.filter(topic => topic.libraryPublished && !topic.testOnly);
  return <section className={styles.library} aria-label="パブリックの問題集">
    <p className={styles.intro}>気になる問題集を自分の学習プランへ追加すると、毎日の10問にも取り入れます。</p>
    {!topics.length ? <div className="panel empty-state"><BookOpen size={28} /><h3>公開された問題集はまだありません</h3><p>{c.profile.role==='parent' ? 'プライベートの問題集から、登録ユーザー向けに公開できます。' : '管理者が公開した問題集を、ここから選べます。自分の問題集はプライベートから使えます。'}</p></div> : <div className={styles.grid}>{topics.map(topic => {
      const added = c.data.plans.some(plan => plan.ownerId === c.profile.id && plan.libraryTopicId === topic.id);
      return <article className={`panel ${styles.card}`} key={topic.id}>
        <span className="subject-badge">{topic.subject}</span><h2>{topic.title}</h2><p>{topic.description || '10問ずつ、自分のペースで練習できます。'}</p>
        <div className={styles.bottom}><small>{topic.targetCount}問 · 1回10問</small>{added ? <button type="button" className="button secondary" disabled={c.busy} onClick={() => onOpen(topic.id)}><Check size={16} />追加済み・練習する</button> : c.preview ? <p className={styles.intro}>まだ学習に追加していません。本人が「学習プランに追加」を押すと練習できます。プレビューでは追加しません。</p> : <button type="button" className="button primary" disabled={c.busy} onClick={async () => { if (await c.actions.addLibraryPlan(topic.id)) onAdded(); }}><Plus size={16} />学習プランに追加</button>}{!c.preview&&onArrange&&<button type="button" className="text-button" disabled={c.busy} onClick={()=>void onArrange(topic.id)}><Sparkles size={15}/>AIと相談してアレンジ</button>}{!c.preview&&onInspect&&<button type="button" className="text-button" onClick={()=>onInspect(topic.id)}>内容を見る<ArrowRight size={15}/></button>}</div>
      </article>;
    })}</div>}
  </section>;
}
