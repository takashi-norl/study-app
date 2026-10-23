'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleDollarSign, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Profile } from '@/lib/types';
import type { AiFeature, AiUsageSummary } from '@/lib/ai-usage';
import styles from './ai-usage.module.css';

const featureLabels: Record<AiFeature, string> = {
  'source-analysis': '教材の読み取り', 'question-generation': '問題の作成', planning: '学習相談', profile: 'プロフィールの会話',
};
const money = (value: number) => `$${value.toFixed(4)}`;
const number = (value: number) => value.toLocaleString('ja-JP');

export function AiUsagePanel({ profile, demo }: { profile: Profile; demo: boolean }) {
  // This visibility check is only presentation; the endpoint independently authorizes the current account.
  if (profile.accessLevel !== 'superuser' || demo) return null;
  return <UsageContent key={profile.id} />;
}

function UsageContent() {
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function refresh() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    setOpen(true); setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/ai-usage', { cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '利用状況を取得できませんでした。');
      if (!controller.signal.aborted) setSummary(result.summary);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '利用状況を取得できませんでした。');
      else if (pending.current === controller) setError('取得に時間がかかっています。もう一度お試しください。');
    } finally { clearTimeout(timeout); if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <section className={`panel ${styles.panel}`} aria-label="AI利用料">
    <div className={styles.heading}><CircleDollarSign size={24} /><div><h2>アプリ全体のAI利用状況</h2><p>運営者専用・全体の集計のみ。個人別の明細や学習内容は含みません。</p></div>
      <button className="button secondary" disabled={busy} onClick={() => void refresh()}>{busy ? <LoaderCircle className="spin" size={16} /> : open ? <RefreshCw size={16} /> : null}{open ? '更新する' : '利用状況を見る'}</button>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {busy && !summary && <p role="status">利用記録を読み込んでいます。</p>}
    {open && summary && <div className={styles.content}>
      <div className={styles.totals}><div><span>{summary.month.replace('-', '年')}月のClaude概算</span><strong>{money(summary.monthly.estimatedUsd)}</strong><small>金額を計算できた利用分・米ドル</small></div><div><span>記録開始からのClaude概算</span><strong>{money(summary.allTime.estimatedUsd)}</strong><small>{number(summary.allTime.requests)}回の依頼を記録</small></div></div>
      <p className={styles.note}>請求額そのものではありません。記録開始前の利用、税・割引・為替換算は含みません。</p>
      {summary.allTime.unknownCostRequests > 0 && <p className={styles.unknown}>金額未確定：今月{number(summary.monthly.unknownCostRequests)}件・全期間{number(summary.allTime.unknownCostRequests)}件。上の概算には含めていません。</p>}
      <h3>今月の内訳</h3><ul className={styles.breakdown}>{summary.byFeature.map(row => <li key={row.feature}><span>{featureLabels[row.feature]}<small>{number(row.usage.requests)}回{row.usage.unknownCostRequests ? `・金額未確定 ${number(row.usage.unknownCostRequests)}件` : ''}</small></span><b>{money(row.usage.estimatedUsd)}</b></li>)}</ul>
      <details><summary>利用量と計算について</summary><p>今月の入力：{number(summary.monthly.inputTokens)}トークン／出力：{number(summary.monthly.outputTokens)}トークン。キャッシュ読込：{number(summary.monthly.cacheReadTokens)}、書込：{number(summary.monthly.cacheWriteTokens)}。</p>
        <p>ElevenLabs：{number(summary.elevenLabs.requests)}回・{number(summary.elevenLabs.characters)}文字。契約プランにより料金が異なるため、音声の金額は計算していません。</p>
        <p>Claude記録開始：{summary.trackingSince ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(new Date(summary.trackingSince)) : 'まだ利用記録がありません'}。</p>
        {summary.notes.map(note => <p key={note}>{note}</p>)}<p>単価確認日：{summary.pricingAsOf} · <a href={summary.pricingUrl} target="_blank" rel="noreferrer">公式の料金表</a></p>
      </details>
    </div>}
  </section>;
}
