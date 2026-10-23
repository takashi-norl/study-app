'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { englishChoiceSpeechText, englishSpeechText, speechChunks } from '@/lib/speech';
import styles from './english-audio.module.css';

// Speech synthesis has one queue per page. A previous component must not stop a newer owner.
let activePlayback: { owner: symbol; stop: () => void } | null = null;

export function EnglishAudio({ questionId, sessionId, prompt, choices, enabled = true, deviceOnly = false }: {
  questionId: string;
  sessionId?: string;
  prompt: string;
  choices: string[];
  enabled?: boolean;
  deviceOnly?: boolean;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<'device' | 'elevenlabs'>('device');
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');
  const owner = useRef(Symbol('english-audio'));
  const utterances = useRef<SpeechSynthesisUtterance[]>([]);
  const player = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const playbackId = useRef(0);
  const cache = useRef(new Map<string, { text: string; url: string }>());
  const chosenProvider = useRef(false);
  const passage = useMemo(() => englishSpeechText(prompt), [prompt]);
  const spokenChoices = useMemo(() => choices.map(englishChoiceSpeechText), [choices]);

  const stop = useCallback(() => {
    playbackId.current += 1;
    request.current?.abort();
    request.current = null;
    if (activePlayback?.owner === owner.current) {
      activePlayback = null;
      utterances.current.forEach(utterance => { utterance.onend = null; utterance.onerror = null; });
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
    if (player.current) {
      player.current.onended = null;
      player.current.onerror = null;
      player.current.pause();
      player.current.removeAttribute('src');
      player.current.load();
    }
    utterances.current = [];
    setPlaying(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    setSupported('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
  }, []);

  useEffect(() => {
    if (!enabled || deviceOnly) return;
    const controller = new AbortController();
    void fetch('/api/audio', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => response.ok ? response.json() as Promise<{ configured?: boolean }> : { configured: false })
      .then(result => {
        if (controller.signal.aborted) return;
        setConfigured(result.configured === true);
        if (result.configured && !chosenProvider.current) setProvider('elevenlabs');
      }).catch(() => {});
    return () => controller.abort();
  }, [enabled, deviceOnly]);

  useEffect(() => {
    stop();
    setError('');
    const onVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      cache.current.forEach(item => URL.revokeObjectURL(item.url));
      cache.current.clear();
    };
  }, [questionId, sessionId, enabled, stop]);

  const playDevice = (key: string, text: string) => {
    if (!supported || !text) return;
    const synth = window.speechSynthesis;
    const voices = synth.getVoices();
    const english = voices.filter(voice => /^en(?:-|_)/i.test(voice.lang) || voice.lang === 'en');
    const voice = english.find(item => /^en[-_]US$/i.test(item.lang) && item.localService)
      ?? english.find(item => /^en[-_]US$/i.test(item.lang))
      ?? english.find(item => item.localService) ?? english[0];
    setError('');
    setPlaying(key);
    activePlayback = { owner: owner.current, stop };
    const segments = speechChunks(text);
    utterances.current = segments.map((segment, index) => {
      const utterance = new SpeechSynthesisUtterance(segment);
      utterance.lang = voice?.lang ?? 'en-US';
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = () => {
        if (index === segments.length - 1 && activePlayback?.owner === owner.current) {
          activePlayback = null;
          utterances.current = [];
          setPlaying(null);
        }
      };
      utterance.onerror = event => {
        if (activePlayback?.owner !== owner.current) return;
        stop();
        if (event.error !== 'interrupted' && event.error !== 'canceled') setError('音声を再生できませんでした。もう一度お試しください。');
      };
      return utterance;
    });
    // Queue directly in the tap handler, preserving the user gesture on iPhone.
    try {
      synth.cancel();
      if (synth.paused) synth.resume();
      utterances.current.forEach(utterance => synth.speak(utterance));
    } catch {
      stop();
      setError('音声を再生できませんでした。もう一度お試しください。');
    }
  };

  const fallback = () => {
    stop();
    chosenProvider.current = true;
    setProvider(supported ? 'device' : 'elevenlabs');
    setError(supported ? 'ElevenLabsを利用できなかったため、端末の音声に切り替えました。もう一度「聞く」を押してください。' : '音声を再生できませんでした。時間をおいて、もう一度お試しください。');
  };

  const playCloud = (key: string, text: string, choiceIndex?: number) => {
    const id = ++playbackId.current;
    const isCurrent = () => playbackId.current === id && activePlayback?.owner === owner.current;
    activePlayback = { owner: owner.current, stop };
    setPlaying(key);
    setError('');
    const playUrl = (url: string) => {
      if (!isCurrent()) return;
      setLoading(false);
      const audio = player.current ?? new Audio();
      player.current = audio;
      audio.src = url;
      audio.playbackRate = rate;
      audio.onended = () => { if (isCurrent()) stop(); };
      audio.onerror = () => { if (isCurrent()) fallback(); };
      void audio.play().catch(error => {
        if (!isCurrent()) return;
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          stop();
          setError('音声の準備ができました。もう一度「聞く」を押すと再生します。');
        } else fallback();
      });
    };
    const cached = cache.current.get(key);
    if (cached?.text === text) { playUrl(cached.url); return; }
    if (cached) { URL.revokeObjectURL(cached.url); cache.current.delete(key); }
    setLoading(true);
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => { if (isCurrent()) fallback(); }, 65_000);
    void fetch('/api/audio', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, sessionId, part: choiceIndex === undefined ? 'prompt' : 'choice', ...(choiceIndex === undefined ? {} : { choiceIndex }) }),
    }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) throw new Error('Audio unavailable');
      const blob = await response.blob();
      if (!blob.size || blob.size > 12 * 1024 * 1024) throw new Error('Invalid audio');
      if (!isCurrent()) return;
      const url = URL.createObjectURL(blob);
      cache.current.set(key, { text, url });
      playUrl(url);
    }).catch(() => { if (isCurrent()) fallback(); }).finally(() => window.clearTimeout(timeout));
  };

  const play = (key: string, text: string, choiceIndex?: number) => {
    if (playing === key) { stop(); return; }
    if (!text) return;
    chosenProvider.current = true;
    activePlayback?.stop();
    if (!deviceOnly && provider === 'elevenlabs' && configured) playCloud(key, text, choiceIndex);
    else playDevice(key, text);
  };

  if (!enabled || (!passage && !spokenChoices.some(Boolean)) || supported === null) return null;
  if (!supported && !configured) return <p className={styles.unavailable}>このブラウザでは英語の音声を再生できません。</p>;

  return <div className={styles.audio} aria-label="英語の音声">
    <div className={styles.controls}>
      {passage && <button type="button" className={styles.listen} disabled={loading && playing !== 'prompt'} aria-pressed={playing === 'prompt'} onClick={() => play('prompt', passage)}>
        {playing === 'prompt' ? <Square size={15} /> : <Volume2 size={17} />}{playing === 'prompt' ? loading ? '準備中・停止' : '停止' : '英文を聞く'}
      </button>}
      {spokenChoices.some(Boolean) && <div className={styles.choices} aria-label="選択肢の発音"><span>選択肢</span>{spokenChoices.map((text, index) => text && <button key={index} type="button" disabled={loading && playing !== `choice-${index}`} aria-label={`選択肢${String.fromCharCode(65 + index)}の英語を${playing === `choice-${index}` ? '停止' : '聞く'}`} aria-pressed={playing === `choice-${index}`} title={choices[index]} onClick={() => play(`choice-${index}`, text, index)}>
        {playing === `choice-${index}` ? <Square size={12} /> : <Volume2 size={13} />}{String.fromCharCode(65 + index)}
      </button>)}</div>}
      <div className={styles.speed} role="group" aria-label="読み上げ速度">{[1, 0.8].map(value => <button key={value} type="button" aria-pressed={rate === value} onClick={() => { stop(); setRate(value); }}>{value}倍</button>)}</div>
    </div>
    <div className={styles.providerRow}>{configured && <div className={styles.provider} role="group" aria-label="音声の種類">{(['elevenlabs', 'device'] as const).map(value => <button key={value} type="button" disabled={value === 'device' && !supported} aria-pressed={provider === value} onClick={() => { stop(); chosenProvider.current = true; setProvider(value); setError(''); }}>{value === 'elevenlabs' ? 'ElevenLabs' : '端末の音声'}</button>)}</div>}
      <p className={styles.note} role={loading ? 'status' : undefined}>{loading ? 'ElevenLabsで音声を準備しています…' : provider === 'elevenlabs' ? '初回は音声を生成。同じ音声は再利用します。' : '端末の音声で読み上げます'}</p>
    </div>
    {error && <p className={styles.error} role="status">{error}</p>}
  </div>;
}
