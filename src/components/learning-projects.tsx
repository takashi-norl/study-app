'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, FolderOpen, Pencil, Plus, Tag, X } from 'lucide-react';
import type { LearningPlan } from '@/lib/types';
import { learningProjects, parsePlanTags, planTagsError, type LearningPlanProgress, type ProjectProgress } from '@/lib/learning-projects';
import type { StudyController } from './controller';
import styles from './learning-projects.module.css';

function Progress({ progress, compact = false }: { progress: ProjectProgress; compact?: boolean }) {
  return <div className={compact ? styles.compactProgress : styles.progress}>
    <div className={styles.progressLabel}><span>回答済み <strong>{progress.answered} / {progress.total}問</strong></span><strong>{progress.percent === null ? '作成前' : `${progress.percent}%`}</strong></div>
    {progress.percent !== null && <div className={styles.progressTrack} role="progressbar" aria-label="異なる問題に回答した割合" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span style={{ width: `${progress.percent}%` }} /></div>}
    <div className={styles.metrics}><span>初回正答率 <strong>{progress.firstAccuracy === null ? '—' : `${Math.round(progress.firstAccuracy * 100)}%`}</strong></span><span>復習の時期 <strong>{progress.due}問</strong></span></div>
  </div>;
}

function PlanTags({ c, plan, tags }: { c: StudyController; plan: LearningPlan; tags: string[] }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const nextTags = parsePlanTags(input);
  const validation = planTagsError(nextTags);
  const dirty = JSON.stringify(nextTags) !== JSON.stringify(tags);
  function edit() { setInput(tags.join(', ')); setError(null); setSaved(false); setEditing(true); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || c.busy || validation || !dirty) return;
    setSaving(true); setError(null);
    try {
      if (await c.actions.updatePlanTags(plan.id, nextTags)) { setEditing(false); setSaved(true); }
      else setError('タグを保存できませんでした。画面のエラーを確認して、もう一度お試しください。');
    } catch { setError('タグを保存できませんでした。接続を確認して、もう一度お試しください。'); }
    finally { setSaving(false); }
  }
  return <div className={styles.tagSection}>
    <div className={styles.planTags}><Tag size={14} />{tags.length ? tags.map(tag => <span key={tag}>{tag}</span>) : <span className={styles.noTag}>未分類</span>}{!c.preview && !editing && <button type="button" onClick={edit} disabled={c.busy}><Pencil size={13} />タグを編集</button>}</div>
    {editing && !c.preview && <form className={styles.tagEditor} onSubmit={event => void save(event)}><label>まとめるタグ<input value={input} onChange={event => { setInput(event.target.value); setError(null); }} placeholder="例：中間テスト, 英語" disabled={saving} /></label><p>カンマで区切って複数つけられます。1つ40文字、8個まで。空にして保存すると未分類に戻ります。</p>{(validation || error) && <p className={styles.error} role="alert">{validation || error}</p>}<div><button type="submit" className="button primary" disabled={c.busy || saving || !!validation || !dirty}><Check size={15} />{saving ? '保存しています' : 'タグを保存'}</button><button type="button" className="text-button" disabled={saving} onClick={() => setEditing(false)}><X size={15} />キャンセル</button></div></form>}
    {saved && !editing && <p className={styles.saved} role="status"><Check size={13} />タグを保存しました</p>}
  </div>;
}

function PlanCard({ c, entry, onOpenPlan, onPractice }: {
  c: StudyController; entry: LearningPlanProgress; onOpenPlan?: (planId: string) => void; onPractice: (topicId: string) => void;
}) {
  const { plan, progress, topicIds, tags } = entry;
  const [requestedTopicId, setRequestedTopicId] = useState(topicIds[0] ?? '');
  const topicId = topicIds.includes(requestedTopicId) ? requestedTopicId : topicIds[0];
  const generating = c.data.jobs.some(job => job.planId === plan.id && ['queued', 'running'].includes(job.status));
  return <article className={styles.planCard}>
    <div className={styles.planMeta}><span>{plan.subject}</span><span>{plan.libraryTopicId ? 'ライブラリから追加' : generating ? '問題を作成中' : progress.total ? `${progress.total}問を保存済み` : '問題はこれから'}</span></div>
    <h3>{plan.title}</h3><p className={styles.goal}>{plan.goal}</p>
    <PlanTags c={c} plan={plan} tags={tags} />
    <Progress progress={progress} compact />
    {!progress.total && <p className={styles.emptyPlan}>{generating ? '保存が終わった問題から、このプランの進み具合を確認できます。' : '問題を作成すると、回答済みの割合がここに表示されます。'}</p>}
    <div className={styles.planActions}>{topicIds.length > 1 && <label>練習する問題集<select value={topicId} onChange={event => setRequestedTopicId(event.target.value)}>{topicIds.map(id => <option key={id} value={id}>{c.data.topics.find(topic => topic.id === id)?.title || '問題集'}</option>)}</select></label>}{!!progress.total && topicId && <button type="button" className="button primary" disabled={c.busy} onClick={() => onPractice(topicId)}>このプランを練習<ArrowRight size={16} /></button>}{onOpenPlan && !c.preview && <button type="button" className="text-button" disabled={c.busy} onClick={() => onOpenPlan(plan.id)}>{progress.total ? '相談・作成内容を見る' : '相談して問題を作る'}<ArrowRight size={15} /></button>}</div>
  </article>;
}

export function LearningProjects({ c, onOpenPlan, onPractice, onCreate }: {
  c: StudyController; onOpenPlan?: (planId: string) => void; onPractice?: (topicId: string) => void; onCreate?: () => void;
}) {
  const [requestedGroup, setRequestedGroup] = useState('all');
  const summaryRef = useRef<HTMLElement>(null);
  function selectGroup(id: string) { setRequestedGroup(id); requestAnimationFrame(() => summaryRef.current?.scrollIntoView({block:'start'})); }
  const { plans, groups } = learningProjects(c.data, c.profile.id);
  const selected = groups.find(group => group.id === requestedGroup) ?? groups[0];
  const projects = groups.filter(group => group.id !== 'all' && group.id !== 'untagged');
  const practice = onPractice ?? ((id: string) => { void c.actions.startPractice('daily', id); });
  return <section className={styles.projects} data-preview={c.preview || undefined} aria-label="タグでまとめた学習プラン">
    <div className="page-heading"><div><p className="eyebrow">MY LEARNING PLANS</p><h1>学習プラン</h1><p className="page-description">「中間テスト」などのタグでプランをまとめて、目的ごとの進み具合を確認できます。</p></div>{onCreate && !c.preview && <button type="button" className="button primary" onClick={onCreate}><Plus size={17} />プランを作る</button>}</div>
    {!plans.length ? <div className={styles.empty}><FolderOpen size={32} /><h2>自分の学習プランをまとめよう</h2><p>問題を作るときのプランや、ライブラリから追加したプランが並びます。タグをつけると、同じ目的の学習をまとめて見られます。</p>{onCreate && !c.preview && <button type="button" className="button primary" onClick={onCreate}>最初のプランを作る<ArrowRight size={16} /></button>}</div> : <>
      {projects.length > 0 ? <div className={styles.projectGrid} aria-label="目的ごとの進み具合">{projects.map(project => <button type="button" key={project.id} className={`${styles.projectCard} ${selected.id === project.id ? styles.selected : ''}`} onClick={() => selectGroup(project.id)} aria-pressed={selected.id === project.id}><div><FolderOpen size={19} /><h2>{project.label}</h2><span>{project.plans.length}プラン</span></div><Progress progress={project.progress} compact /><span className={styles.projectLink}>このまとまりを見る<ArrowRight size={14} /></span></button>)}</div> : <div className={styles.hint}><Tag size={20} /><p>{c.preview ? '現在、タグがついたプランはありません。学習者がタグをつけると、同じ目的のプランの進み具合をまとめて確認できます。' : <>プランの「タグを編集」から、例として <strong>中間テスト</strong> と <strong>英語</strong> をつけられます。同じタグのプランが1つのまとまりになります。</>}</p></div>}
      <div className={styles.groupChips} aria-label="表示するタグ">{groups.map(group => <button type="button" key={group.id} aria-pressed={selected.id === group.id} onClick={() => selectGroup(group.id)}>{group.id.startsWith('tag:') && <Tag size={13} />}<span>{group.label}</span><small>{group.plans.length}</small></button>)}</div>
      <section ref={summaryRef} className={styles.groupSummary} aria-label={`${selected.label}の進捗`}><div className={styles.summaryHeading}><div><h2>{selected.id === 'all' ? '自分のプラン全体' : selected.label}</h2><p>{selected.plans.length}プラン · 練習できる問題 {selected.progress.total}問</p></div><BookOpen size={24} /></div><Progress progress={selected.progress} /><p className={styles.note}>進捗は「一度以上回答した問題の割合」です。解き直しても1問として数え、習得度とは区別しています。同じ問題を含むプランがあっても、このまとまりでは重複して数えません。</p></section>
      <div className={styles.listHeading}><h2>{selected.id === 'all' ? 'プラン一覧' : `${selected.label}のプラン`}</h2><span>{selected.plans.length}件</span></div>
      {selected.plans.length ? <div className={styles.planGrid}>{selected.plans.map(entry => <PlanCard key={entry.plan.id} c={c} entry={entry} onOpenPlan={onOpenPlan} onPractice={practice} />)}</div> : <div className={styles.empty}><Tag size={28} /><h2>未分類のプランはありません</h2><p>プランのタグを空にして保存すると、ここに表示されます。</p></div>}
      <p className={styles.footnote}>タグは自分のプランを整理するためのものです。問題集の公開範囲は変わりません。複数のタグがあるプランは、それぞれのまとまりに表示されます。</p>
    </>}
  </section>;
}
