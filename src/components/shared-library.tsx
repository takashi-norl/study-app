'use client';

import { ArrowRight, BookOpen, Check, Plus } from 'lucide-react';
import type { StudyController } from './controller';
import styles from './shared-library.module.css';

export function SharedLibrary({ c, onAdded, onOpen }: { c: StudyController; onAdded: () => void; onOpen: (topicId: string) => void }) {
  const topics = c.data.topics.filter(topic => topic.libraryPublished && !topic.testOnly);
  const parent = c.profile.role === 'parent';
  return <section className={styles.library} aria-label="公開ライブラリ">
    <p className={styles.intro}>{parent ? '公開した問題集です。学習者はここから選んで、自分の学習プランに追加できます。' : '気になる問題集を選んで、自分の学習プランへ。追加すると、毎日の10問にも取り入れます。'}</p>
    {!topics.length ? <div className="panel empty-state"><BookOpen size={28} /><h3>公開された問題集はまだありません</h3><p>{parent ? 'テスト用の問題を試してから、「ライブラリに公開」で追加できます。' : '問題集が公開されると、ここから選べます。自分で作るときは、画面下の「問題を作る」へ。'}</p></div> : <div className={styles.grid}>{topics.map(topic => {
      const added = c.data.plans.some(plan => plan.ownerId === c.profile.id && plan.libraryTopicId === topic.id);
      return <article className={`panel ${styles.card}`} key={topic.id}>
        <span className="subject-badge">{topic.subject}</span><h2>{topic.title}</h2><p>{topic.description || '10問ずつ、自分のペースで練習できます。'}</p>
        <div className={styles.bottom}><small>{topic.targetCount}問 · 1回10問</small>{parent ? <button className="button secondary" onClick={() => onOpen(topic.id)}>内容を見る<ArrowRight size={16} /></button> : added ? <button className="button secondary" disabled={c.busy} onClick={() => onOpen(topic.id)}><Check size={16} />追加済み・練習する</button> : <button className="button primary" disabled={c.busy} onClick={async () => { if (await c.actions.addLibraryPlan(topic.id)) onAdded(); }}><Plus size={16} />学習プランに追加</button>}</div>
      </article>;
    })}</div>}
  </section>;
}
