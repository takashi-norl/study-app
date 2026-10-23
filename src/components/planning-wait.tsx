'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleHelp, Clock3, RefreshCw } from 'lucide-react';
import type { PlanningTurn } from '@/lib/types';
import { durationLabel, elapsedSeconds, planningWaitState, readingTimeEstimate } from '@/lib/planning-progress';
import type { StudyController } from './controller';
import styles from './planning-wait.module.css';

export function PlanningWait({ c, turn, own, onLeave, active = true }: { c: StudyController; turn: PlanningTurn; own: boolean; onLeave: () => void; active?: boolean }) {
  const card = useRef<HTMLElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, [turn.id]);
  useEffect(() => { if (active) { const frame = requestAnimationFrame(() => card.current?.scrollIntoView({ block: 'start', behavior: 'auto' })); return () => cancelAnimationFrame(frame); } }, [active, turn.id]);
  const { elapsed, idle, estimate, needsCheck, overEstimate } = planningWaitState(turn, c.data.planningTurns, now);
  const readingEstimate = readingTimeEstimate(turn);
  const progress = turn.progress;
  const phase = progress?.phase || (turn.status === 'queued' ? 'queued' : 'unknown');
  const sourceTotal = progress?.sourcesTotal || 0;
  const phaseLabel = {
    queued: '依頼を受け付けました', preparing: '準備をしています', reading_sources: '教材を読み取っています',
    thinking: turn.samplePreview ? 'サンプル3問を作っています' : '問題づくりの案をまとめています', saving: turn.samplePreview ? 'サンプルを保存しています' : '提案を保存しています', complete: turn.samplePreview ? 'サンプルを保存しました' : '提案を保存しました',
    failed: '作成状況をご確認ください', unknown: '処理の状況を確認しています',
  }[phase];
  const stage = phase === 'reading_sources' ? 1 : phase === 'thinking' ? 2 : phase === 'saving' ? 3 : 0;
  const heading = c.sync.error ? '最新の状況を確認できていません' : needsCheck ? '完了をまだ確認できていません' : phaseLabel;
  const range = estimate && (estimate.lower === estimate.upper ? durationLabel(estimate.upper) : `${durationLabel(estimate.lower)}〜${durationLabel(estimate.upper)}`);
  return <section ref={card} className={styles.card} aria-label="AI相談の進み具合">
    <div className={styles.heading}><span className={styles.icon}>{needsCheck || c.sync.error ? <CircleHelp size={23} /> : <Clock3 size={23} />}</span><div><span className={styles.receipt}><Check size={13} />依頼は保存済みです</span><h2 role="status">{heading}</h2></div></div>
    <div className={styles.time}><strong>受付から {durationLabel(elapsed)}</strong>{readingEstimate ? <span>残り{readingEstimate.remaining}件のAI読み取り：約{durationLabel(readingEstimate.lower)}〜{durationLabel(readingEstimate.upper)}<small>この依頼で読み取った{readingEstimate.count}件の実測から。保存・サンプルの作成には別に時間がかかります。</small></span> : estimate ? <span>受付から完了までの目安：{range}<small>同じ教材件数・読み取り条件の直近{estimate.count}件。内容によって変わります。</small></span> : <span>時間の目安は計測中です<small>{phase==='reading_sources' ? 'まず数件を読み取り、残りの読み取り時間を見積もります。' : '完了までの時間はまだ見積もれません。実績が集まると目安を表示します。'}</small></span>}</div>
    {progress && <ol className={styles.steps} aria-label="完了までの手順">
      <li className={styles.done}><span><Check size={14} /></span><div>受付・保存<strong>完了</strong></div></li>
      {sourceTotal > 0 && <li className={stage > 1 ? styles.done : stage === 1 ? styles.current : ''} aria-current={stage === 1 ? 'step' : undefined}><span>{stage > 1 ? <Check size={14} /> : '2'}</span><div>教材の読み取り<strong>{progress.sourcesCompleted} / {sourceTotal}件 確認済み</strong></div></li>}
      <li className={stage > 2 ? styles.done : stage === 2 ? styles.current : ''} aria-current={stage === 2 ? 'step' : undefined}><span>{stage > 2 ? <Check size={14} /> : sourceTotal ? '3' : '2'}</span><div>{turn.samplePreview ? '提案とサンプル3問を作成' : '問題づくりの案を作成'}<strong>{stage > 2 ? '完了' : stage === 2 ? '作成中' : 'これから'}</strong></div></li>
      <li className={stage === 3 ? styles.current : ''} aria-current={stage === 3 ? 'step' : undefined}><span>{sourceTotal ? '4' : '3'}</span><div>{turn.samplePreview ? 'サンプルを保存' : '提案を保存'}<strong>{stage === 3 ? '保存中' : 'これから'}</strong></div></li>
    </ol>}
    {turn.samplePreview && <p className={styles.delay}>まず3問で形式を確認します。総問題数を決めて作成を押すまで、まとめて作問しません。</p>}
    {(needsCheck || overEstimate || c.sync.error) && <p className={styles.delay} role="status">{c.sync.error ? '通信の状態を確認してください。画面で確認できなくても、AIの処理が続いている場合があります。' : needsCheck ? `${durationLabel(idle)}、処理段階の更新を確認できていません。「実行状況を確認」で調べられます。` : 'これまでの目安より時間がかかっています。完了時刻はまだ確定できません。'}</p>}
    <div className={styles.leave}><strong>この画面で待ち続けなくて大丈夫です。</strong><p>ほかの学習を進められます。戻ったときは「問題を作る」から、このプランの回答を確認できます。</p><button type="button" className="button primary" onClick={onLeave}><ArrowLeft size={16} />学習プラン一覧に戻る</button></div>
    <div className={styles.check}><span>{c.sync.checking ? '最新の状態を確認中…' : c.sync.lastSyncedAt ? now-c.sync.lastSyncedAt<10000 ? '最終確認：たった今' : `最終確認：${durationLabel(elapsedSeconds(new Date(c.sync.lastSyncedAt).toISOString(), now))}前` : '状態を確認しています'}</span><button type="button" className="text-button" disabled={c.busy || c.sync.checking} onClick={() => void (needsCheck && own && !c.sync.error ? c.actions.resumePlanningTurn(turn.id) : c.actions.refreshStatus())}><RefreshCw size={14} />{needsCheck && own && !c.sync.error ? '実行状況を確認' : '最新の状態を確認'}</button></div>
  </section>;
}
