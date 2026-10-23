'use client';

import { useState, type FormEvent } from 'react';
import { Check, Send, X } from 'lucide-react';
import type { Topic } from '@/lib/types';
import type { StudyController } from './controller';
import styles from './learner-delivery.module.css';

export function LearnerDelivery({ c, topic }: { c: StudyController; topic: Topic }) {
  const learners = c.data.profiles.filter(profile => profile.role === 'student' && profile.familyId === c.profile.familyId);
  const sourcePlan = c.data.plans.find(plan => plan.id === topic.planId && plan.ownerId === c.profile.id);
  const [open, setOpen] = useState(false);
  const [learnerId, setLearnerId] = useState(learners.length === 1 ? learners[0].id : '');
  const [project, setProject] = useState(sourcePlan?.tags?.[0] ?? '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [error, setError] = useState('');
  const questions = c.data.questions.filter(question => question.topicId === topic.id && question.status !== 'archived');
  const generating = c.data.jobs.some(job => job.topicId === topic.id && ['queued', 'running'].includes(job.status));
  const selected = learners.find(profile => profile.id === learnerId);
  if (c.preview || c.profile.role !== 'parent' || topic.testOnly) return null;
  async function deliver(event: FormEvent) {
    event.preventDefault();
    if (!selected || sending || c.busy || generating || !questions.length || sent) return;
    setSending(true); setError('');
    try {
      if (await c.actions.deliverToLearner(topic.id, selected.id, project.trim())) {
        setSent(`${selected.name}さんの${project.trim() ? `「${project.trim()} → ${topic.subject}」` : '学習プラン'}に${questions.length}問を届けました。本人のホーム・学習プランから練習できます。`);
      } else setError('保存結果を確認できませんでした。画面のエラーを確認して、同じ内容でもう一度お試しください。');
    } catch { setError('届けた結果を確認できませんでした。接続を確認して、同じ内容でもう一度お試しください。'); }
    finally { setSending(false); }
  }
  return <section className={styles.delivery} aria-label="学習者へ問題セットを届ける">
    {!open && <button type="button" className="button secondary" disabled={c.busy || generating || !questions.length || !learners.length} onClick={() => setOpen(true)}><Send size={16}/>学習者に届ける</button>}
    {!open && <p>{!learners.length ? '学習者の登録後に、本人の学習プランへ届けられます。' : generating ? '問題の作成が終わると、学習者へ届けられます。' : '本人用の問題セットをコピーして届けます。ほかの学習者には公開しません。'}</p>}
    {open && <form onSubmit={event => void deliver(event)}>
      <h3>この問題セットを、本人の学習プランへ</h3>
      <label>届ける学習者<select value={learnerId} onChange={event => setLearnerId(event.target.value)} disabled={sending || !!sent}><option value="">学習者を選ぶ</option>{learners.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <label>プロジェクト名 <span>任意</span><input value={project} maxLength={40} disabled={sending || !!sent} onChange={event => setProject(event.target.value)} placeholder="例：2学期中間テスト"/></label>
      <p><strong>{project.trim() ? `${project.trim()} → ${topic.subject}` : topic.subject}</strong> に {questions.length}問。問題と解説だけを本人用にコピーします。原本の写真・相談履歴は渡しません。元の問題や成績はそのまま残ります。</p>
      <p>本人は、届いたセットを練習したり、AIと相談して別の聞き方のセットを作ったりできます。</p>
      {questions.some(question => question.needsReview) && <p className={styles.warning}>要確認の問題があります。原本と答えの根拠を確認してから届けてください。</p>}
      {error && <p className={styles.warning} role="alert">{error}</p>}
      {sent ? <p className={styles.success} role="status"><Check size={17}/>{sent}</p> : <div className={styles.actions}><button type="submit" className="button primary" disabled={sending || c.busy || generating || !selected || !questions.length}><Send size={16}/>{sending ? '届けています' : `${selected?.name ?? '学習者'}さんに${questions.length}問を届ける`}</button><button type="button" className="text-button" disabled={sending} onClick={() => setOpen(false)}><X size={15}/>閉じる</button></div>}
    </form>}
  </section>;
}
