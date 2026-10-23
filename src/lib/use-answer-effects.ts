'use client';

import { useCallback, useSyncExternalStore } from 'react';

const values = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const serverDefault = () => true;

/** Preview settings stay in memory; learner preferences belong to this browser and user. */
export function answerEffectsKey(profileId: string, demo: boolean, preview = false) {
  return `hibi:answer-effects:v1:${preview ? 'preview' : demo ? 'demo' : 'live'}:${profileId}`;
}

function read(key: string) {
  if (!values.has(key)) {
    let enabled = true;
    if (!key.includes(':preview:')) {
      try { enabled = window.localStorage.getItem(key) !== 'off'; } catch { /* Private browsers can deny storage. */ }
    }
    values.set(key, enabled);
  }
  return values.get(key)!;
}

export function useAnswerEffects(key: string) {
  const snapshot = useCallback(() => read(key), [key]);
  const enabled = useSyncExternalStore(subscribe, snapshot, serverDefault);
  const setEnabled = useCallback((value: boolean) => {
    values.set(key, value);
    if (!key.includes(':preview:')) {
      try { window.localStorage.setItem(key, value ? 'on' : 'off'); } catch { /* Keep this session usable. */ }
    }
    for (const listener of listeners) listener();
  }, [key]);
  return [enabled, setEnabled] as const;
}
