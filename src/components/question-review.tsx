'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, FileText, ListChecks, LockKeyhole, Pencil, Search, ShieldCheck } from 'lucide-react';
import type { Question, Topic } from '@/lib/types';
import { topicOwnerId } from '@/lib/library-policy';
import { filterReviewRows, reviewDistribution, reviewRows, reviewStateLabel, reviewSummary, reviewSubject, type ReviewGrouping, type ReviewRow } from '@/lib/question-review';
import type { StudyController } from './controller';
import { SourceMaterialPanel } from './source-material-panel';
import { ArrangeTopicButton } from './question-library';
import styles from './question-review.module.css';

interface QuestionReviewProps {
  c: StudyController;
  initialTopic?: string;
  initialSubject?: string;
  onBack: () => void;
  onOpenPlan: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  renderEditor: (question: Question, onDirtyChange: (dirty: boolean) => void) => ReactNode;
}

function TopicScope({ c, topic, onOpenPlan }: { c: StudyController; topic: Topic; onOpenPlan: (id: string) => void }) {
  const count = c.data.questions.filter(question => question.topicId === topic.id && question.status !== 'archived').length;
  return <section className={styles.scope} aria-label="自分の問題集">
    <div className={styles.scopeHeading}><div><LockKeyhole size={18}/><h2>{topic.title}</h2></div><span className={styles.badge}>自分だけの問題集</span></div>
    <p>問題と原本を見比べて、必要なところを編集できます。保存した問題は自分の練習に使えます。</p>
    {count > 0 && <div className={styles.scopeActions}><button type="button" className="button secondary" disabled={c.busy} onClick={() => void c.actions.startPractice('daily', topic.id)}><BookOpen size={16}/>この問題集を練習する</button><ArrangeTopicButton c={c} topicId={topic.id} onCreated={onOpenPlan}/></div>}
  </section>;
}

function QuestionRow({ row, showTopic, showChoices, showExplanation, onEdit, onTopic }: {
  row: ReviewRow; showTopic: boolean; showChoices: boolean; showExplanation: boolean;
  onEdit: () => void; onTopic: () => void;
}) {
  const { question: q, topic, number, sources } = row;
  const answer = q.choices[q.correctIndex];
  return <li className={`${styles.questionRow} ${!showChoices && !showExplanation ? styles.compact : ''} ${q.status === 'archived' ? styles.archived : ''}`}>
    <div className={styles.number} aria-label={`問題集内の第${number}問`}>{String(number).padStart(2, '0')}</div>
    <article className={styles.questionBody}>
      <div className={styles.rowMeta}>{showTopic && <button type="button" onClick={onTopic}>{topic?.title || '問題集未設定'}<ChevronRight size={13} /></button>}<span>{topic?.subject || '科目未設定'}</span>{q.needsReview && <strong className={styles.warning}>要確認</strong>}<span className={styles.state}>問題の状態：{reviewStateLabel(q.status)}</span></div>
      <h3>{q.prompt}</h3>
      {showChoices ? <ol className={styles.choices}>{q.choices.map((choice, i) => <li key={i} className={i === q.correctIndex ? styles.correct : ''}><span>{String.fromCharCode(65 + i)}</span><p>{choice}</p>{i === q.correctIndex && <strong><Check size={13} />正解</strong>}</li>)}</ol>
        : <p className={styles.answer}><Check size={15} /><strong>正解 {String.fromCharCode(65 + q.correctIndex)}</strong>{answer ?? '正解が設定されていません'}</p>}
      <div className={styles.evidence}><p><strong>覚えるポイント</strong>{q.learningPoint || '未設定'}</p><p><strong><FileText size={13} />元の教材</strong>{sources.length ? sources.map(source => source.name).join(' ／ ') : q.sourceIds.length ? '教材ストックで確認' : '教材なし・相談から作成'}</p></div>
      <details className={styles.explanation} open={showExplanation || undefined} key={String(showExplanation)}><summary>解説・作問の根拠</summary><p>{q.explanation || '解説の記載はありません。'}</p><p><strong>作問の根拠：</strong>{q.sourceNote || '出典の記載はありません。'}</p>{q.needsReview && <p className={styles.reviewNote}>読み取りや答えに確認が必要な点があります。原本や解説と見比べて確認してください。</p>}</details>
    </article>
    <div className={styles.rowActions}><button type="button" className="button secondary" onClick={onEdit} aria-label={`第${number}問を確認・編集`}><Pencil size={15} />確認・編集</button></div>
  </li>;
}

export function QuestionReview({ c, initialTopic = 'all', initialSubject = 'all', onBack, onOpenPlan, onDirtyChange, renderEditor }: QuestionReviewProps) {
  const [topicId, setTopicId] = useState(initialTopic);
  const [subject, setSubject] = useState(initialSubject);
  const [sourceId, setSourceId] = useState('all');
  const [samePromptOnly, setSamePromptOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [grouping, setGrouping] = useState<ReviewGrouping>('learningPoint');
  const [selectedId, setSelectedId] = useState('');
  const [dirty, setDirty] = useState(false);
  const listScroll = useRef(0);
  const editorTop = useRef<HTMLDivElement>(null);
  const updateDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange?.(value); }, [onDirtyChange]);

  useEffect(() => { setTopicId(initialTopic); setSubject(initialSubject); setSourceId('all'); setSamePromptOnly(false); setSelectedId(''); setQuery(''); setNeedsReviewOnly(false); updateDirty(false); }, [initialTopic, initialSubject, updateDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => { if (selectedId) editorTop.current?.scrollIntoView({ block: 'start' }); }, [selectedId]);

  const ownTopics = c.data.topics.filter(topic => !topic.libraryPublished && topicOwnerId(c.data, topic) === c.profile.id);
  const ownTopicIds = new Set(ownTopics.map(topic => topic.id));
  const rows = reviewRows({ ...c.data, topics: ownTopics, questions: c.data.questions.filter(question => ownTopicIds.has(question.topicId)) });
  const subjectRows = rows.filter(row => subject === 'all' || reviewSubject(row.topic?.subject) === subject);
  const topicRows = subjectRows.filter(row => topicId === 'all' || row.question.topicId === topicId);
  const topicIds = new Set(ownTopics.filter(item => (subject === 'all' || reviewSubject(item.subject) === subject) && (topicId === 'all' || item.id === topicId)).map(item => item.id));
  if (topicId !== 'all') topicIds.add(topicId);
  const planIds = new Set(ownTopics.filter(item => topicIds.has(item.id)).map(item => item.planId));
  const referencedSources = new Set([...topicRows.flatMap(row => row.question.sourceIds), ...c.data.plans.filter(plan => planIds.has(plan.id)).flatMap(plan => plan.sourceIds)]);
  const materials = c.data.sources.filter(source => referencedSources.has(source.id) || !!source.topicId && topicIds.has(source.topicId));
  const currentSourceId = materials.some(source => source.id === sourceId) ? sourceId : 'all';
  const shownMaterials = currentSourceId === 'all' ? materials : materials.filter(source => source.id === currentSourceId);
  const summary = reviewSummary(topicRows);
  const visible = filterReviewRows(rows, { topicId, subject, sourceId: currentSourceId, query, needsReviewOnly, showArchived, samePromptOnly });
  const selected = rows.find(row => row.question.id === selectedId);
  const selectedOrder = rows.findIndex(row => row.question.id === selectedId);
  // A reviewed/hidden question can leave the current filter after saving. Keep its place in the flow.
  const previousRow = visible.filter(row => rows.indexOf(row) < selectedOrder).at(-1);
  const nextRow = visible.find(row => rows.indexOf(row) > selectedOrder);
  const topic = ownTopics.find(item => item.id === (selected?.question.topicId ?? topicId));
  const distribution = reviewDistribution(topicRows, grouping, materials);
  const maxCount = distribution[0]?.count ?? 1;

  function mayLeave() { return !c.busy && (!dirty || window.confirm('未保存の変更があります。変更を破棄して移動しますか？')); }
  function leave(action: () => void) { if (!mayLeave()) return; updateDirty(false); action(); }
  function openEditor(id: string) { if (!selectedId) listScroll.current = window.scrollY; leave(() => setSelectedId(id)); }
  function returnToList() { leave(() => { setSelectedId(''); requestAnimationFrame(() => window.scrollTo({ top: listScroll.current, behavior: 'auto' })); }); }
  function resetFilters() { setQuery(''); setNeedsReviewOnly(false); setShowArchived(false); setSourceId('all'); setSamePromptOnly(false); }
  function focusTopic(id: string) { setTopicId(id); resetFilters(); window.scrollTo({ top: 0, behavior: 'auto' }); }

  return <section className={styles.review} aria-label="問題の一覧レビュー">
    <button type="button" className="text-button editor-back" disabled={c.busy} onClick={() => leave(onBack)}><ArrowLeft size={17} />ライブラリへ戻る</button>
    <div className="page-heading"><div><p className="eyebrow">QUESTION REVIEW</p><h1>問題の一覧・レビュー</h1><p className="page-description">全体の傾向と並びを見て、気になる問題を確認・編集できます。</p></div></div>
    <ol className={styles.flow} aria-label="問題づくりから学習まで"><li><span>1</span>写真・相談から作成</li><li aria-current="step"><span>2</span>一覧で確認・編集</li><li><span>3</span>自分の問題を解く</li><li><span>4</span>記録を見て復習</li></ol>
    <p className={styles.flowNote}><ShieldCheck size={15} />自分の問題と教材を確認する画面です。ほかの利用者には公開されません。</p>

    {selected ? <>
      <div ref={editorTop} className={styles.editorNav}>
        <button type="button" className="text-button" disabled={c.busy} onClick={returnToList}><ListChecks size={17} />一覧に戻る（{visible.length}問）</button>
        <span>{selected.topic?.title} · 第{selected.number}問</span>
        <div><button type="button" className="button secondary" disabled={c.busy || !previousRow} onClick={() => previousRow && openEditor(previousRow.question.id)}><ArrowLeft size={15} />前の問題</button><button type="button" className="button secondary" disabled={c.busy || !nextRow} onClick={() => nextRow && openEditor(nextRow.question.id)}>次の問題<ArrowRight size={15} /></button></div>
      </div>
      {selected.question.needsReview && <p className={styles.selectedWarning}>要確認：原本の読み取りや答えの根拠を確認してください。気になる点を直してから練習できます。</p>}
      {renderEditor(selected.question, updateDirty)}
      <div className={styles.editorFooter}><button type="button" className="button secondary" disabled={c.busy} onClick={returnToList}><ListChecks size={17} />一覧へ戻って全体を見る</button><p>前後の問題へ移動しても、絞り込みと元の問題番号は変わりません。</p></div>
    </> : <>
      <div className={styles.filters}><label>科目<select value={subject} onChange={event => { setSubject(event.target.value); setTopicId('all'); resetFilters(); }}><option value="all">すべての科目</option>{[...new Set(ownTopics.map(item => reviewSubject(item.subject)!))].map(item => <option key={item} value={item}>{item}</option>)}</select></label><label className={styles.topicFilter}>確認する問題集<select value={topicId} onChange={event => { setTopicId(event.target.value); resetFilters(); }}><option value="all">すべての問題集</option>{ownTopics.filter(item => subject === 'all' || reviewSubject(item.subject) === subject).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>元の教材<select value={currentSourceId} onChange={event => setSourceId(event.target.value)}><option value="all">すべての教材</option>{materials.map((source, index) => <option key={source.id} value={source.id}>{index + 1}. {source.name} · {topicRows.filter(row => row.question.sourceIds.includes(source.id) && row.question.status !== 'archived').length}問</option>)}</select></label><label className={styles.search}>問題文・ポイント・教材を検索<div><Search size={17} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="例：助動詞、古語、教材の名前" /></div></label></div>
      {topic ? <TopicScope c={c} topic={topic} onOpenPlan={onOpenPlan} /> : <div className={styles.scopeHint}><LockKeyhole size={17} /><p>自分の問題集を選ぶと、原本・出題の傾向・正解をまとめて確認できます。</p></div>}
      <div className={styles.summary} aria-label="選択した問題集全体の件数"><div><span>練習対象</span><strong>{summary.active}<small>問</small></strong></div><div><span>要確認</span><strong>{summary.needsReview}<small>問</small></strong></div><div><span>覚えるポイント</span><strong>{summary.learningPoints}<small>種類</small></strong></div><div><span>非表示</span><strong>{summary.archived}<small>問</small></strong></div></div>
      {!!summary.active && <section className={styles.trends} aria-label="問題の傾向"><div className={styles.trendHeading}><div><h2>問題の傾向</h2><p>選んだ科目・問題集の練習対象 {summary.active}問。教材・検索・確認状態で絞り込む前の内訳です。</p></div><label><span className="sr-only">集計する項目</span><select value={grouping} onChange={event => setGrouping(event.target.value as ReviewGrouping)}><option value="learningPoint">覚えるポイント別</option><option value="source">元の教材別</option><option value="subject">科目別</option></select></label></div><ul className={styles.distribution}>{distribution.slice(0, 6).map(item => <li key={item.label}><span>{item.label}</span><div><i style={{ width: `${item.count / maxCount * 100}%` }} /></div><strong>{item.count}問</strong></li>)}</ul>{distribution.length > 6 && <details className={styles.moreDistribution}><summary>残り {distribution.length - 6}種類の内訳を見る</summary><ul>{distribution.slice(6).map(item => <li key={item.label}><span>{item.label}</span><strong>{item.count}問</strong></li>)}</ul></details>}{grouping === 'source' && <p className={styles.smallNote}>複数の教材を参照する問題は、それぞれの教材に数えています。</p>}</section>}
      {materials.length > 0 && <p className={styles.smallNote}>教材名の横は、その教材を参照する問題数です。0問の教材も表示します。教材の全範囲を出題できたことを保証する数ではありません。</p>}
      {(subject === '古文' || reviewSubject(topic?.subject) === '古文') && <div className={styles.qualityGuide}><strong>古文の確認ポイント</strong><p>判断に必要な本文があるか → 正解が一つに決まるか → 訳や答えを先に見せていないか → 原本と解説の根拠が合うか。</p><span>下の「同じ問題文」で、同じ問題集内の重なりを確認できます。意味が似た問題の自動判定はしていません。</span></div>}
      <div className={styles.reviewLayout}><div className={styles.reviewQuestions}>
      <div className={styles.listToolbar}><div><h2>問題の流れ <span>{visible.length}問を表示</span></h2><p>問題集内の元の並びと番号を保っています。実際の練習では学習履歴に応じて順番が変わります。</p></div><div className={styles.checks}><label><input type="checkbox" checked={samePromptOnly} onChange={event => setSamePromptOnly(event.target.checked)} />同じ問題文だけ</label><label><input type="checkbox" checked={needsReviewOnly} onChange={event => setNeedsReviewOnly(event.target.checked)} />要確認だけ</label><label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />非表示も含める</label><label><input type="checkbox" checked={showChoices} onChange={event => setShowChoices(event.target.checked)} />選択肢を表示</label><label><input type="checkbox" checked={showExplanation} onChange={event => setShowExplanation(event.target.checked)} />解説・根拠を展開</label></div></div>
      <p className={styles.statusNote}>「下書き」「確認済み」は内容を確認したかのメモです。非表示にした問題は、自分の新しい練習から外れます。</p>
      {visible.length ? <ol className={styles.questionList} aria-label="問題一覧">{visible.map(row => <QuestionRow key={row.question.id} row={row} showTopic={topicId === 'all'} showChoices={showChoices} showExplanation={showExplanation} onEdit={() => openEditor(row.question.id)} onTopic={() => focusTopic(row.question.topicId)} />)}</ol> : <div className={styles.empty}><BookOpen size={30} /><h2>{summary.total ? '表示条件に合う問題がありません' : 'この範囲には問題がありません'}</h2><p>{summary.total ? '検索語や「要確認だけ」の条件を変えると、ほかの問題を確認できます。' : '問題を作成すると、この一覧で全体を確認できます。'}</p>{summary.total > 0 && <button type="button" className="button secondary" onClick={() => { resetFilters(); if (!summary.active) setShowArchived(true); }}>表示条件をリセット</button>}</div>}
      </div>{shownMaterials.length > 0 && <aside className={styles.materialAside}><SourceMaterialPanel demo={c.demo} key={currentSourceId + ':' + topicId} sources={shownMaterials} defaultOpen={currentSourceId !== 'all'}/></aside>}</div>
    </>}
  </section>;
}
