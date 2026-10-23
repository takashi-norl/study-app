'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, FolderOpen, Pencil, Plus, Sparkles, Tag, X } from 'lucide-react';
import type { LearningPlan } from '@/lib/types';
import { learningProjects, parsePlanTags, planGoalSummary, planTagsError, type LearningPlanProgress, type ProjectProgress } from '@/lib/learning-projects';
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
      else setError('所属を保存できませんでした。画面のエラーを確認して、もう一度お試しください。');
    } catch { setError('所属を保存できませんでした。接続を確認して、もう一度お試しください。'); }
    finally { setSaving(false); }
  }
  return <div className={styles.tagSection}>
    <div className={styles.planTags}><Tag size={14} />{tags.length ? tags.map(tag => <span key={tag}>{tag}</span>) : <span className={styles.noTag}>未分類</span>}{!c.preview && !editing && <button type="button" onClick={edit} disabled={c.busy}><Pencil size={13} />所属を編集</button>}</div>
    {editing && !c.preview && <form className={styles.tagEditor} onSubmit={event => void save(event)}><label>所属するプロジェクト<input value={input} onChange={event => { setInput(event.target.value); setError(null); }} placeholder="例：2学期中間テスト" disabled={saving} /></label><p>プロジェクト名をタグとして保存します。複数ある場合はカンマ区切りで、1つ40文字・8個まで。空にして保存すると未分類に戻ります。</p>{(validation || error) && <p className={styles.error} role="alert">{validation || error}</p>}<div><button type="submit" className="button primary" disabled={c.busy || saving || !!validation || !dirty}><Check size={15} />{saving ? '保存しています' : '所属を保存'}</button><button type="button" className="text-button" disabled={saving} onClick={() => setEditing(false)}><X size={15} />キャンセル</button></div></form>}
    {saved && !editing && <p className={styles.saved} role="status"><Check size={13} />所属を保存しました</p>}
  </div>;
}

function ProjectOrganizer({ c, entries, projectNames, onSaved }: {
  c: StudyController; entries: LearningPlanProgress[]; projectNames: string[]; onSaved: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const latest = useRef(c); latest.current = c;
  const suggestionsId = useId();
  const trimmedName = name.trim();
  const nameError = planTagsError([trimmedName]) || (/[,、，\n]/.test(trimmedName) ? 'ここではプロジェクト名を1つ入力してください。' : null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (c.preview || c.busy || saving || !trimmedName || nameError || !selectedIds.length) return;
    setSaving(true); setErrors({}); setNotice('');
    const failures: Record<string, string> = {};
    const saved: string[] = [];
    try {
      for (const id of selectedIds) {
        const controller = latest.current;
        const plan = controller.data.plans.find(item => item.id === id && item.ownerId === controller.profile.id && !item.testOnly);
        if (!plan) { failures[id] = '自分のプランを確認できません。画面を更新して確認してください。'; continue; }
        const tags = [...new Set((plan.tags ?? []).map(tag => tag.trim()).filter(Boolean))];
        if (tags.includes(trimmedName)) { saved.push(id); continue; }
        const next = [...tags, trimmedName];
        const validation = planTagsError(next);
        if (validation) { failures[id] = 'すでに8つの所属があります。カードの「所属を編集」で整理してから再試行してください。'; continue; }
        try {
          if (await controller.actions.updatePlanTags(id, next)) saved.push(id);
          else failures[id] = '保存できませんでした。選択を残しているので、もう一度保存できます。';
        } catch { failures[id] = '通信中に保存できませんでした。選択を残しているので、もう一度保存できます。'; }
      }
      setSelectedIds(ids => ids.filter(id => !saved.includes(id)));
      setErrors(failures);
      const failed = Object.keys(failures).length;
      setNotice(failed ? `${saved.length}件を保存し、${failed}件は保存できませんでした。未保存のプランは選択したまま残しています。` : `「${trimmedName}」に${saved.length}件のプランをまとめました。`);
      if (!failed) onSaved(trimmedName);
    } finally { setSaving(false); }
  }
  if (c.preview) return null;
  return <section className={styles.organizer} aria-label="プロジェクトにプランをまとめる">
    <button type="button" className="button secondary" aria-expanded={open} onClick={() => setOpen(value => !value)} disabled={saving}><FolderOpen size={17} />プロジェクトにまとめる</button>
    {open && <form onSubmit={event => void save(event)}>
      <div className={styles.organizerHeading}><h2>目的とプランを選ぶ</h2><p>例：2学期中間テスト → 古文。科目はプランに設定されている内容で分かれます。</p></div>
      <label>プロジェクト名<input list={suggestionsId} value={name} onChange={event => { setName(event.target.value); setNotice(''); setErrors({}); }} disabled={saving} placeholder="例：2学期中間テスト" maxLength={40} /><datalist id={suggestionsId}>{projectNames.map(project => <option key={project} value={project} />)}</datalist></label>
      <p className={styles.organizerHelp}>新しい名前を入力するか、登録済みの名前を選べます。今の所属を残したまま追加します。</p>
      {nameError && <p className={styles.organizerError} role="alert">{nameError}</p>}
      <fieldset disabled={saving}><legend>まとめる自分のプラン（{selectedIds.length}件選択）</legend><div className={styles.planPicker}>{entries.map(({ plan, tags }) => <label key={plan.id}><input type="checkbox" checked={selectedIds.includes(plan.id)} onChange={event => { setSelectedIds(ids => event.target.checked ? [...ids, plan.id] : ids.filter(id => id !== plan.id)); setNotice(''); }} /><span><strong>{plan.title}</strong><small>{plan.subject} · {tags.length ? tags.join(' ／ ') : '未分類'}</small>{errors[plan.id] && <span className={styles.organizerError}>{errors[plan.id]}</span>}</span></label>)}</div></fieldset>
      <p className={styles.organizerHelp}>公開問題集は、ライブラリで「学習に追加」すると選べます。問題の内容や公開範囲は変わりません。</p>
      {notice && <p className={Object.keys(errors).length ? styles.organizerError : styles.organizerNotice} role="status">{notice}</p>}
      <div className={styles.organizerActions}><button type="submit" className="button primary" disabled={c.busy || saving || !trimmedName || !!nameError || !selectedIds.length}><Check size={16} />{saving ? '順に保存しています' : Object.keys(errors).length ? '未保存のプランを再試行' : '選んだプランをまとめる'}</button><button type="button" className="text-button" disabled={saving} onClick={() => setOpen(false)}><X size={15} />閉じる</button></div>
    </form>}
  </section>;
}

function PlanCard({ c, entry, onOpenPlan, onPractice }: {
  c: StudyController; entry: LearningPlanProgress; onOpenPlan?: (planId: string) => void; onPractice: (topicId: string) => void;
}) {
  const { plan, progress, topicIds, tags } = entry;
  const [requestedTopicId, setRequestedTopicId] = useState(topicIds[0] ?? '');
  const [arranging, setArranging] = useState(false);
  const [arrangeError, setArrangeError] = useState('');
  const topicId = topicIds.includes(requestedTopicId) ? requestedTopicId : topicIds[0];
  const generating = c.data.jobs.some(job => job.planId === plan.id && ['queued', 'running'].includes(job.status));
  const baseTopic = c.data.topics.find(topic => topic.id === plan.arrangedFromTopicId);
  async function arrange() {
    if (c.preview || c.busy || arranging || generating || !topicId || !onOpenPlan) return;
    setArranging(true); setArrangeError('');
    try {
      const created = await c.actions.arrangeTopic(topicId);
      if (created) onOpenPlan(created);
      else setArrangeError('別セットの相談を作れませんでした。画面のエラーを確認して、もう一度お試しください。');
    } catch { setArrangeError('別セットの相談を作れませんでした。接続を確認して、もう一度お試しください。'); }
    finally { setArranging(false); }
  }
  return <article className={styles.planCard}>
    <div className={styles.planMeta}><span>{plan.subject}</span><span>{plan.libraryTopicId ? 'ライブラリから追加' : generating ? '問題を作成中' : progress.total ? `${progress.total}問を保存済み` : '問題はこれから'}</span></div>
    <h3>{plan.title}</h3><p className={styles.relation}>{plan.arrangedFromTopicId ? <>派生セット · 元：{baseTopic?.title || '元の問題集'}</> : progress.total ? 'ベースの問題集' : '作成前のプラン'}</p><p className={styles.goal}>{planGoalSummary(plan.goal)}</p>
    <PlanTags c={c} plan={plan} tags={tags} />
    <Progress progress={progress} compact />
    {!progress.total && <p className={styles.emptyPlan}>{generating ? '保存が終わった問題から、このプランの進み具合を確認できます。' : '問題を作成すると、回答済みの割合がここに表示されます。'}</p>}
    <div className={styles.planActions}>{topicIds.length > 1 && <label>練習・相談の元にする問題集<select value={topicId} onChange={event => setRequestedTopicId(event.target.value)} disabled={arranging}>{topicIds.map(id => <option key={id} value={id}>{c.data.topics.find(topic => topic.id === id)?.title || '問題集'}</option>)}</select></label>}{!!progress.total && topicId && <button type="button" className="button primary" disabled={c.busy || arranging} onClick={() => onPractice(topicId)}>このプランを練習<ArrowRight size={16} /></button>}{onOpenPlan && !c.preview && <button type="button" className="text-button" disabled={c.busy || arranging} onClick={() => onOpenPlan(plan.id)}>{progress.total ? '相談・作成内容を見る' : '相談して問題を作る'}<ArrowRight size={15} /></button>}</div>
    {!!progress.total && topicId && onOpenPlan && !c.preview && <div className={styles.deriveAction}><p>{plan.sourceIds.length ? '元の教材と問題を参考に、別の聞き方や難しさを相談できます。' : '元の問題を参考に、別の聞き方や難しさを相談できます。'}</p><button type="button" className="button secondary" disabled={c.busy || arranging || generating} onClick={() => void arrange()}><Sparkles size={15} />{arranging ? '相談を用意しています' : 'AIと相談して別セットを作る'}</button>{generating && <p>今の問題作成が終わると相談できます。</p>}{arrangeError && <p className={styles.organizerError} role="alert">{arrangeError}</p>}</div>}
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
  const subjects = [...new Set(selected.plans.map(entry => entry.plan.subject))];
  const practice = onPractice ?? ((id: string) => { void c.actions.startPractice('daily', id); });
  return <section className={styles.projects} data-preview={c.preview || undefined} aria-label="プロジェクトと科目でまとめた学習プラン">
    <div className="page-heading"><div><p className="eyebrow">MY LEARNING PLANS</p><h1>学習プラン</h1><p className="page-description">「2学期中間テスト → 古文」のようにまとめて、元の問題集とAIとの相談から作った別セットを一緒に確認できます。</p></div>{onCreate && !c.preview && <button type="button" className="button primary" onClick={onCreate}><Plus size={17} />プランを作る</button>}</div>
    {!plans.length ? <div className={styles.empty}><FolderOpen size={32} /><h2>自分の学習プランをまとめよう</h2><p>問題を作るときのプランや、ライブラリから追加したプランが並びます。プランを作るか問題集を追加したら、同じ目的のプロジェクトにまとめられます。</p>{onCreate && !c.preview && <button type="button" className="button primary" onClick={onCreate}>最初のプランを作る<ArrowRight size={16} /></button>}</div> : <>
      <ProjectOrganizer c={c} entries={plans} projectNames={projects.map(project => project.label)} onSaved={name => setRequestedGroup(`tag:${name}`)} />
      {projects.length > 0 ? <div className={styles.projectGrid} aria-label="目的ごとの進み具合">{projects.map(project => <button type="button" key={project.id} className={`${styles.projectCard} ${selected.id === project.id ? styles.selected : ''}`} onClick={() => selectGroup(project.id)} aria-pressed={selected.id === project.id}><div><FolderOpen size={19} /><h2>{project.label}</h2><span>{project.plans.length}プラン</span></div><p className={styles.projectSubjects}>{[...new Set(project.plans.map(entry => entry.plan.subject))].join(' ／ ')}</p><Progress progress={project.progress} compact /><span className={styles.projectLink}>このプロジェクトを見る<ArrowRight size={14} /></span></button>)}</div> : <div className={styles.hint}><Tag size={20} /><p>{c.preview ? '現在、プロジェクトにまとまったプランはありません。学習者が所属を設定すると、目的・科目ごとの進み具合を確認できます。' : <>「プロジェクトにまとめる」で <strong>2学期中間テスト</strong> を作り、<strong>古文</strong> のプランを選べます。プランの科目が、その下の見出しになります。</>}</p></div>}
      <div className={styles.groupChips} aria-label="表示するプロジェクト">{groups.map(group => <button type="button" key={group.id} aria-pressed={selected.id === group.id} onClick={() => selectGroup(group.id)}>{group.id.startsWith('tag:') && <Tag size={13} />}<span>{group.label}</span><small>{group.plans.length}</small></button>)}</div>
      <section ref={summaryRef} className={styles.groupSummary} aria-label={`${selected.label}の進捗`}><div className={styles.summaryHeading}><div><h2>{selected.id === 'all' ? '自分のプラン全体' : selected.label}</h2><p>{selected.plans.length}プラン · 練習できる問題 {selected.progress.total}問</p></div><BookOpen size={24} /></div><Progress progress={selected.progress} /><p className={styles.note}>進捗は「一度以上回答した問題の割合」です。解き直しても1問として数え、習得度とは区別しています。同じ問題を含むプランがあっても、このまとまりでは重複して数えません。</p></section>
      <div className={styles.listHeading}><h2>{selected.id === 'all' ? 'プラン一覧' : `${selected.label}のプラン`}</h2><span>{selected.plans.length}件</span></div>
      {selected.plans.length ? <div className={styles.subjectGroups}>{subjects.map(subject => <section className={styles.subjectGroup} key={subject} aria-label={`${selected.id === 'all' ? '' : `${selected.label} → `}${subject}`}><h3>{selected.id !== 'all' && <><span>{selected.label}</span><ChevronRight size={16} /></>}<strong>{subject}</strong><small>{selected.plans.filter(entry => entry.plan.subject === subject).length}プラン</small></h3><div className={styles.planGrid}>{selected.plans.filter(entry => entry.plan.subject === subject).map(entry => <PlanCard key={entry.plan.id} c={c} entry={entry} onOpenPlan={onOpenPlan} onPractice={practice} />)}</div></section>)}</div> : <div className={styles.empty}><Tag size={28} /><h2>未分類のプランはありません</h2><p>カードの「所属を編集」でプロジェクト名を空にして保存すると、ここに表示されます。</p></div>}
      <p className={styles.footnote}>プロジェクトは自分のプランを整理するためのまとまりです。問題集の公開範囲は変わりません。複数のプロジェクトに入れたプランは、それぞれに表示されます。</p>
    </>}
  </section>;
}
