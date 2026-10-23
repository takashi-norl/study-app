'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react';
import type { StudyController } from './controller';
import styles from './practice-start.module.css';

export function PracticeStart({ c }: { c: StudyController }) {
  const [requireConfirmation, setRequireConfirmation] = useState(false);
  const request = c.practiceStart!;
  const topic = c.data.topics.find(item => item.id === request.topicId);
  return <section className={styles.setup} aria-labelledby="practice-start-title">
    <button type="button" className="text-button" disabled={c.busy} onClick={c.actions.cancelPracticeStart}><ArrowLeft size={17}/>戻る</button>
    <p className={styles.eyebrow}>{c.preview ? '学習者の解き方を試す' : '練習をはじめる前に'}</p>
    <h1 id="practice-start-title">{request.mode === 'weak' ? '苦手な問題を復習しよう' : request.mode === 'extra' ? 'もうひとセット、やってみよう' : '一問ずつ、進めよう'}</h1>
    <p>{topic?.title || '自分の問題集から、新しい問題と復習を選びます。'}</p>
    <label className={styles.option}>
      <span><strong>答え合わせボタンを使う</strong><span id="answer-mode-description">{requireConfirmation ? 'オン：選び直してから答え合わせ' : 'オフ：選ぶとすぐに正解と解説を表示'}</span></span>
      <input type="checkbox" role="switch" checked={requireConfirmation} disabled={c.busy} onChange={event => setRequireConfirmation(event.target.checked)} aria-describedby="answer-mode-description"/>
      <span className={styles.switch} aria-hidden="true"/>
    </label>
    <p className={styles.note}>この練習の間は、選んだ解き方で進みます。{c.preview && '試し解きの回答は本人の記録に保存されません。'}</p>
    <button type="button" className="button primary" disabled={c.busy} onClick={() => void c.actions.beginPractice(requireConfirmation)}>{c.busy ? <LoaderCircle size={17} className="spin"/> : <ArrowRight size={17}/>} {c.busy ? '問題を準備しています' : 'この設定ではじめる'}</button>
  </section>;
}
