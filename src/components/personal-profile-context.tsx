'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Profile } from '@/lib/types';
import { defaultPersonalPreferences, type PersonalPreferences, type PersonalProfileState, type PersonalProfileTurn } from '@/lib/personal-profile';

type PersonalContextValue = {
  identity: Profile;
  demo: boolean;
  state: PersonalProfileState;
  loading: boolean;
  busy: 'chat' | 'save' | null;
  error: string | null;
  refresh(): Promise<void>;
  sendMessage(message: string): Promise<PersonalProfileTurn | null>;
  savePreferences(preferences: PersonalPreferences): Promise<boolean>;
};
const PersonalContext = createContext<PersonalContextValue | null>(null);
const emptyState = (): PersonalProfileState => ({ profile: null, version: 0, turns: [], aiEnabled: false });
const demoKey = (id: string) => `hibi-personal-profile-demo-v1:${encodeURIComponent(id)}`;

function isPreferences(value: unknown): value is PersonalPreferences {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['nickname', 'schoolYear', 'goals', 'interests'].every(key => typeof item[key] === 'string')
    && ['gentle', 'direct', 'energetic'].includes(item.encouragementStyle as string)
    && typeof item.dailyMinutes === 'number' && item.dailyMinutes >= 1 && item.dailyMinutes <= 120
    && typeof item.enabled === 'boolean' && Array.isArray(item.personalizedMessages)
    && item.personalizedMessages.length <= 6 && item.personalizedMessages.every(text => typeof text === 'string' && text.length <= 100);
}

function isProfileState(value: unknown, ownerId: string): value is PersonalProfileState {
  if (!value || typeof value !== 'object') return false;
  const item = value as PersonalProfileState;
  return Number.isSafeInteger(item.version) && item.version >= 0 && typeof item.aiEnabled === 'boolean'
    && (item.profile === null || (isPreferences(item.profile) && item.profile.ownerId === ownerId))
    && Array.isArray(item.turns) && item.turns.length <= 8 && item.turns.every(turn => typeof turn.id === 'string'
      && typeof turn.message === 'string' && ['pending', 'complete', 'failed'].includes(turn.status)
      && (!turn.reply || typeof turn.reply === 'string') && (!turn.draft || isPreferences(turn.draft)));
}

function demoTurn(message: string, state: PersonalProfileState): PersonalProfileTurn {
  const previous = [...state.turns].reverse().find(turn => turn.draft)?.draft ?? state.profile ?? defaultPersonalPreferences();
  const draft: PersonalPreferences = { ...previous, personalizedMessages: [...previous.personalizedMessages], enabled: true };
  const minutes = message.match(/(\d{1,3})\s*分/);
  if (minutes) draft.dailyMinutes = Math.max(1, Math.min(120, Number(minutes[1])));
  if (/はっきり|端的|ストレート/.test(message)) draft.encouragementStyle = 'direct';
  else if (/元気|明る|盛り上/.test(message)) draft.encouragementStyle = 'energetic';
  else if (/優し|やさし|穏やか|落ち着/.test(message)) draft.encouragementStyle = 'gentle';
  if (/英検|試験|テスト|合格|マスター|覚え|伸ば|目指/.test(message)) draft.goals = message.slice(0, 400);
  if (/好き|趣味|興味/.test(message) && !/声のかけ方|話すところ/.test(message)) draft.interests = message.slice(0, 240);
  draft.personalizedMessages = draft.encouragementStyle === 'energetic'
    ? ['まず1問から！ 小さな「できた」を集めよう。', '今日の一歩を、明日の自信に。無理のないペースで。']
    : draft.encouragementStyle === 'direct'
      ? [`今日は${draft.dailyMinutes}分を目安に。1問ずつ、理解を確かめよう。`, '間違えたところが、次に伸ばせるところ。まず1問。']
      : ['今日は、できるところから少しずつ。', 'ひとつの「わかった」を、自分の力に。'];
  return { id: crypto.randomUUID(), version: state.version + 1, status: 'complete', message,
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), draft,
    reply: 'これはデモの返信例です。いただいた言葉をもとに、下の「プロフィール案」に目安と声のかけ方を入れました。好きな表現に直して保存してみてください。本番ではAIが会話に合わせて相談に乗ります。' };
}

export function PersonalProfileProvider({ profile, demo, children }: { profile: Profile; demo: boolean; children: ReactNode }) {
  // Remount before rendering another account so its predecessor's preferences never flash.
  return <PersonalProfileSession key={`${demo ? 'demo' : 'live'}:${profile.id}`} identity={profile} demo={demo}>{children}</PersonalProfileSession>;
}

function PersonalProfileSession({ identity, demo, children }: { identity: Profile; demo: boolean; children: ReactNode }) {
  const [state, setState] = useState<PersonalProfileState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'chat' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const alive = useRef(false);
  const pending = useRef(false);
  const loadSequence = useRef(0);
  const activeRequests = useRef(new Set<AbortController>());
  function remember(next: PersonalProfileState) {
    if (!alive.current) return;
    stateRef.current = next;
    setState(next);
    if (demo) { try { localStorage.setItem(demoKey(identity.id), JSON.stringify(next)); } catch { /* This session still works when browser storage is unavailable. */ } }
  }
  async function request(path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown) {
    const controller = new AbortController();
    activeRequests.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), method === 'POST' ? 110_000 : 20_000);
    try {
      const response = await fetch(path, { method, cache: 'no-store', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const value: unknown = await response.json();
      if (!response.ok) {
        const text = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : '接続を確認して、もう一度お試しください。';
        throw Object.assign(new Error(text), { status: response.status });
      }
      if (!isProfileState(value, identity.id)) throw new Error('プロフィールを確認できませんでした。もう一度読み込んでください。');
      return value;
    } finally { window.clearTimeout(timeout); activeRequests.current.delete(controller); }
  }
  async function refresh() {
    if (pending.current || identity.id === 'guest') return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      if (demo) {
        let saved: unknown;
        try { saved = JSON.parse(localStorage.getItem(demoKey(identity.id)) ?? 'null'); } catch { /* Ignore damaged demo data. */ }
        remember(isProfileState(saved, identity.id) ? { ...saved, aiEnabled: true } : { ...emptyState(), aiEnabled: true });
      } else {
        const next = await request('/api/profile', 'GET');
        if (sequence === loadSequence.current) remember(next);
      }
    } catch (cause) {
      if (alive.current && sequence === loadSequence.current) setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '読み込みを確認できませんでした。入力した内容はそのまま編集できます。');
    } finally { if (alive.current && sequence === loadSequence.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const controllers = activeRequests.current;
    return () => { alive.current = false; loadSequence.current += 1; for (const controller of controllers) controller.abort(); controllers.clear(); };
    // The keyed session owns one identity for its entire lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutate(kind: 'chat' | 'save', payload: { message: string } | { preferences: PersonalPreferences }) {
    if (pending.current || loading || identity.id === 'guest') return null;
    pending.current = true;
    setBusy(kind);
    setError(null);
    try {
      const current = stateRef.current;
      let next: PersonalProfileState;
      if (demo) {
        if ('message' in payload) next = { ...current, version: current.version + 1, turns: [...current.turns, demoTurn(payload.message, current)].slice(-8) };
        else next = { ...current, version: current.version + 1, profile: { ...payload.preferences, ownerId: identity.id, version: current.version + 1, updatedAt: new Date().toISOString() } };
      } else next = await request(kind === 'chat' ? '/api/profile/chat' : '/api/profile', kind === 'chat' ? 'POST' : 'PATCH', {
        requestId: crypto.randomUUID(), expectedVersion: current.version, ...payload,
      });
      if (!alive.current) return null;
      remember(next);
      return next;
    } catch (cause) {
      if (!alive.current) return null;
      if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 409) {
        try { remember(await request('/api/profile', 'GET')); } catch { /* Keep the original conflict message and user's draft. */ }
        if (alive.current) setError('別の画面で更新されました。入力内容は残っています。最新の状態を確認して、もう一度保存・送信してください。');
      } else setError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : '通信の完了を確認できませんでした。「保存状況を確認」で結果を読み込めます。');
      return null;
    } finally { pending.current = false; if (alive.current) setBusy(null); }
  }
  const value: PersonalContextValue = {
    identity, demo, state, loading, busy, error, refresh,
    async sendMessage(message) {
      const next = await mutate('chat', { message });
      return next?.turns.at(-1) ?? null;
    },
    async savePreferences(preferences) { return !!(await mutate('save', { preferences })); },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

export function usePersonalProfile() {
  const value = useContext(PersonalContext);
  if (!value) throw new Error('PersonalProfileProvider is required.');
  return value;
}
