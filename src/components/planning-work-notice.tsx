'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CircleCheck, CircleHelp, Clock3, X } from 'lucide-react';
import type { LearningPlan, PlanningTurn } from '@/lib/types';
import type { StudyController } from './controller';
import styles from './planning-work-notice.module.css';

const MAX_TRACKED = 100;
const isPending = (turn: PlanningTurn) => turn.status === 'queued' || turn.status === 'running';

/** Keep only request IDs in browser storage, never conversation or material content. */
export function parsePlanningNoticeIds(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(-MAX_TRACKED);
  } catch { return []; }
}

/** Finished requests remain visible only if this browser first observed them pending. */
export function planningWorkNoticeState(previous: readonly string[], turns: PlanningTurn[], plans: LearningPlan[], ownerId: string) {
  const planIds = new Set(plans.map(plan => plan.id));
  const known = new Map(turns.map(turn => [turn.id, turn]));
  const own = turns.filter(turn => turn.requestedBy === ownerId && planIds.has(turn.planId));
  const allowed = new Set(own.map(turn => turn.id));
  // An absent record can be a transient incomplete refresh; do not discard its receipt.
  const ids = [...new Set([...previous.filter(id => !known.has(id) || allowed.has(id)), ...own.filter(isPending).map(turn => turn.id)])].slice(-MAX_TRACKED);
  const tracked = new Set(ids);
  const notices = own.filter(turn => tracked.has(turn.id)).sort((a, b) => {
    const status = Number(isPending(a)) - Number(isPending(b));
    return status || (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt);
  });
  return { ids, notices };
}

function readIds(key: string) {
  try { return parsePlanningNoticeIds(localStorage.getItem(key)); } catch { return []; }
}

function saveIds(key: string, ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(key, JSON.stringify(ids));
    else localStorage.removeItem(key);
  } catch { /* The current page still retains its notice when browser storage is unavailable. */ }
}

function receiptLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
  }).format(date);
}

function pendingDetail(turn: PlanningTurn, connectionError: boolean) {
  if (connectionError) return '最新の状況を確認できていません';
  const progress = turn.progress;
  if (!progress) return '相談画面で進み具合を確認できます';
  const phase = {
    queued: '開始を待っています', preparing: '準備中', reading_sources: '教材を確認中',
    thinking: turn.samplePreview ? 'サンプル3問を作成中' : '案を作成中', saving: '回答を保存中', complete: '完了', failed: '結果をご確認ください',
  }[progress.phase];
  if (progress.sourcesTotal > 0) {
    const completed = Math.max(0, Math.min(progress.sourcesTotal, progress.sourcesCompleted));
    return `教材 ${completed}/${progress.sourcesTotal}件確認 · ${phase}`;
  }
  return phase;
}

export function PlanningWorkNotice({ c, onOpenPlan, hidden = false }: {
  c: StudyController;
  onOpenPlan: (planId: string) => void;
  hidden?: boolean;
}) {
  if (!c.ready || c.profile.id === 'guest') return null;
  const scope = `hibi-planning-notice-v1:${c.demo ? 'demo' : 'live'}:${encodeURIComponent(c.profile.id)}`;
  // Remount before a different account can render the previous account's local state.
  return <ScopedPlanningWorkNotice key={scope} c={c} storageKey={scope} onOpenPlan={onOpenPlan} hidden={hidden} />;
}

function ScopedPlanningWorkNotice({ c, storageKey, onOpenPlan, hidden }: {
  c: StudyController;
  storageKey: string;
  onOpenPlan: (planId: string) => void;
  hidden: boolean;
}) {
  const [trackedIds, setTrackedIds] = useState<string[] | null>(null);
  const { planningTurns, plans } = c.data;
  const ownerId = c.profile.id;

  useEffect(() => {
    const previous = trackedIds ?? readIds(storageKey);
    const next = planningWorkNoticeState(previous, planningTurns, plans, ownerId).ids;
    saveIds(storageKey, next);
    if (trackedIds === null || next.length !== trackedIds.length || next.some((id, index) => id !== trackedIds[index])) setTrackedIds(next);
  }, [trackedIds, planningTurns, plans, ownerId, storageKey]);

  if (trackedIds === null) return null;
  const { ids, notices } = planningWorkNoticeState(trackedIds, planningTurns, plans, ownerId);
  const turn = notices[0];
  // Tracking continues while practice or the relevant conversation hides the card.
  if (hidden || !turn) return null;
  const pending = isPending(turn);
  const failed = turn.status === 'failed';
  const hasProposals = !!turn.proposals?.length;
  const hasSamples = turn.proposals?.some(proposal => proposal.samples?.length === 3);
  const title = pending ? 'AIの依頼を受け付けました' : failed ? '回答を完了できませんでした' : hasSamples ? 'サンプル3問が届きました' : hasProposals ? '提案が届きました' : 'AIから回答が届きました';
  const action = pending ? '状況を見る' : failed ? '実行結果を確認' : hasSamples ? 'サンプルを見る' : hasProposals ? '提案を見る' : '回答を見る';
  const plan = plans.find(item => item.id === turn.planId)!;
  const Icon = pending ? Clock3 : failed ? CircleHelp : CircleCheck;

  function acknowledge() {
    if (pending) return;
    const next = ids.filter(id => id !== turn.id);
    saveIds(storageKey, next);
    setTrackedIds(next);
  }

  return <aside className={`${styles.card} ${failed ? styles.failed : ''}`} aria-label="依頼したAI相談のお知らせ">
    <Icon className={styles.icon} size={20} aria-hidden="true" />
    <div className={styles.content}>
      <strong role="status">{title}</strong>
      <p className={styles.context}>{plan.subject} · {receiptLabel(turn.createdAt)}の依頼{c.demo && '（サンプル）'}</p>
      {pending && <p className={styles.detail}>{pendingDetail(turn, !!c.sync.error)}</p>}
    </div>
    {!pending && <button type="button" className={styles.close} aria-label="このAI相談のお知らせを閉じる" onClick={acknowledge}><X size={17} aria-hidden="true" /></button>}
    <div className={styles.actions}>
      {notices.length > 1 && <span>ほか{notices.length - 1}件</span>}
      <button type="button" className={styles.open} onClick={() => { acknowledge(); onOpenPlan(turn.planId); }}>{action}<ArrowRight size={16} aria-hidden="true" /></button>
    </div>
  </aside>;
}
