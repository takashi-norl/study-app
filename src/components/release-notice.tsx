'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { CURRENT_RELEASE } from '@/lib/releases';
import { compareVersions, RELEASE_SEEN_KEY, releaseNoticeState } from '@/lib/release-notice';
import styles from './release-notes.module.css';

type NoticeRelease = Pick<typeof CURRENT_RELEASE, 'version' | 'date' | 'title' | 'announcement'>;
let memorySeen: string | null = null;
// Capture before this visit's service-worker registration, not after login finishes.
const returningInstall = typeof window !== 'undefined' && (() => {
  try { return !!localStorage.getItem('hibi-study-demo-v1') || ('serviceWorker' in navigator && !!navigator.serviceWorker.controller); } catch { return false; }
})();

function readSeen() { try { return localStorage.getItem(RELEASE_SEEN_KEY) ?? memorySeen; } catch { return memorySeen; } }
function saveSeen(version: string) { memorySeen = version; try { localStorage.setItem(RELEASE_SEEN_KEY, version); } catch { /* A private browser can retain the notice state for this page only. */ } }

export function ReleaseNotice({ busy }: { busy: boolean }) {
  const [notice, setNotice] = useState<NoticeRelease | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let lastCheck = 0;
    let activeRequest: AbortController | undefined;
    function observe(release: NoticeRelease) {
      const state = releaseNoticeState({ runningVersion: CURRENT_RELEASE.version, availableVersion: release.version, seenVersion: readSeen(), returningInstall });
      if (state.show) setNotice(release);
      saveSeen(state.nextSeen);
    }
    function observeCurrentWhenVisible() {
      if (!initialized.current && document.visibilityState === 'visible') { initialized.current = true; observe(CURRENT_RELEASE); }
    }
    observeCurrentWhenVisible();
    async function check() {
      observeCurrentWhenVisible();
      if (document.visibilityState !== 'visible' || pending || Date.now() - lastCheck < 30_000) return;
      pending = true;
      lastCheck = Date.now();
      const request = new AbortController();
      activeRequest = request;
      const timeout = window.setTimeout(() => request.abort(), 8_000);
      try {
        const response = await fetch('/api/releases', { cache: 'no-store', signal: request.signal });
        if (!response.ok) return;
        const release: unknown = await response.json();
        if (cancelled || document.visibilityState !== 'visible' || !release || typeof release !== 'object') return;
        const value = release as Record<string, unknown>;
        if (typeof value.version !== 'string' || compareVersions(value.version, CURRENT_RELEASE.version) !== 1
          || typeof value.announcement !== 'string' || value.announcement.length > 300
          || typeof value.title !== 'string' || typeof value.date !== 'string') return;
        observe(value as NoticeRelease);
      } catch { /* Updates are optional: offline use and current work continue. */ }
      finally { window.clearTimeout(timeout); pending = false; activeRequest = undefined; }
    }
    void check();
    const onReturn = () => { void check(); };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => { cancelled = true; activeRequest?.abort(); document.removeEventListener('visibilitychange', onReturn); window.removeEventListener('focus', onReturn); };
  }, []);
  if (!notice) return null;
  const updateReady = compareVersions(notice.version, CURRENT_RELEASE.version) === 1;
  return <aside className={styles.notice} aria-label="アプリの更新のお知らせ" aria-live="polite">
    <Sparkles size={19} aria-hidden="true" />
    <div><p><strong>{updateReady ? '新しいバージョンがあります' : 'ひび学習が新しくなりました'}</strong><span>v{notice.version}</span></p><p>{notice.announcement}</p>
      <div className={styles.actions}><a href="/releases" target="_blank" rel="noreferrer">詳細を見る</a>{updateReady && <button type="button" disabled={busy} onClick={() => window.location.reload()}>最新版を開く</button>}</div>
      {updateReady && <small>{busy ? '練習や保存が終わってから、最新版を開けます。' : '入力中の内容があれば、保存してから開いてください。'}</small>}
    </div>
    <button type="button" className={styles.close} aria-label="更新のお知らせを閉じる" onClick={() => { saveSeen(notice.version); setNotice(null); }}><X size={19} /></button>
  </aside>;
}
