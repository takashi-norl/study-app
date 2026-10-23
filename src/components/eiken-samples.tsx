'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, Headphones, PenLine } from 'lucide-react';
import type { EikenSample, SampleAudio } from '@/lib/eiken-sample-types';
import styles from './eiken-samples.module.css';

const levels: EikenSample['level'][] = ['2級', '準1級'];
const skills: EikenSample['skill'][] = ['Reading', 'Listening', 'Writing'];
const skillLabels = { Reading: '読む', Listening: '聞く', Writing: '書く' };
const skillIcons = { Reading: BookOpen, Listening: Headphones, Writing: PenLine };
type ResponseState = {
  selected?: number;
  answered?: boolean;
  writing?: string;
  showScript?: boolean;
  showModel?: boolean;
  checked?: number[];
};

function wordCount(text: string) {
  return text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

function AudioPreview({ clips, busy, onPrepare, onRefresh }: {
  clips: SampleAudio[];
  busy: boolean;
  onPrepare: (sampleId: string) => void;
  onRefresh: () => void;
}) {
  const players = useRef(new Map<string, HTMLAudioElement>());
  const playerRefs = useRef(new Map<string, (node: HTMLAudioElement | null) => void>());
  const rateRef = useRef(1);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState<string[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const stop = useCallback(() => {
    players.current.forEach(player => player.pause());
  }, []);

  useEffect(() => {
    const currentPlayers = players.current;
    const handleVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      currentPlayers.forEach(player => player.pause());
    };
  }, [stop]);

  const changeRate = (value: number) => {
    rateRef.current = value;
    setRate(value);
    players.current.forEach(player => { player.playbackRate = value; });
  };

  const playerRef = (key: string) => {
    let ref = playerRefs.current.get(key);
    if (!ref) {
      ref = node => {
        if (node) {
          players.current.set(key, node);
          node.playbackRate = rateRef.current;
        } else {
          players.current.get(key)?.pause();
          players.current.delete(key);
        }
      };
      playerRefs.current.set(key, ref);
    }
    return ref;
  };

  if (!clips.length) return null;
  return <section className={styles.audioBox} aria-label="音声の試聴">
    <div className={styles.audioHeading}>
      <h3><Headphones size={18} aria-hidden="true" />音声を聞く</h3>
      <div className={styles.speed} aria-label="再生速度">
        {[0.8, 1].map(value => <button type="button" key={value} aria-pressed={rate === value} onClick={() => changeRate(value)}>{value === 1 ? '通常' : 'ゆっくり'}</button>)}
      </div>
    </div>
    {clips.map((clip, index) => {
      const key = `${clip.url}-${index}`;
      const state = clip.state ?? 'ready';
      const duration = durations[key] ?? clip.durationSeconds;
      return <div key={key} className={styles.audioClip}>
        <p>{clip.voiceLabel}{duration > 0 && <span>約{Math.max(1, Math.round(duration))}秒</span>}</p>
        {state === 'ready' ? <audio
          controls
          preload="metadata"
          src={clip.url}
          aria-label={`${clip.voiceLabel}の音声`}
          ref={playerRef(key)}
          onPlay={() => players.current.forEach((player, playerKey) => { if (playerKey !== key) player.pause(); })}
          onLoadedMetadata={event => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setDurations(previous => ({ ...previous, [key]: value }));
          }}
          onError={() => setFailed(previous => previous.includes(key) ? previous : [...previous, key])}
          onCanPlay={() => setFailed(previous => previous.filter(item => item !== key))}
        /> : <div className={styles.audioStatus} aria-live="polite">
          {state === 'missing' && <><p>一度準備すると、繰り返し聞けます。</p><button type="button" className={styles.prepare} disabled={busy} onClick={() => onPrepare(clip.sampleId)}>この音声を準備する</button></>}
          {state === 'pending' && <><p>音声を準備しています。ほかの見本へ移動しても、ここで準備状況を確認できます。</p><button type="button" className={styles.prepare} disabled={busy} onClick={onRefresh}>{busy ? '準備しています…' : '準備状況を確認'}</button></>}
          {state === 'failed' && <><p>音声の準備が完了しませんでした。重複して作成されないよう、再生成を止めています。</p><button type="button" className={styles.prepare} disabled={busy} onClick={onRefresh}>準備状況を確認</button></>}
        </div>}
        {failed.includes(key) && <p className={styles.audioError} role="alert">音声を読み込めませんでした。接続を確認し、<button type="button" onClick={() => players.current.get(key)?.load()}>音声を読み直す</button></p>}
      </div>;
    })}
  </section>;
}

export default function EikenSamples({ samples, audio }: { samples: EikenSample[]; audio: SampleAudio[] }) {
  const [level, setLevel] = useState<EikenSample['level']>('2級');
  const [skill, setSkill] = useState<EikenSample['skill']>('Reading');
  const [responses, setResponses] = useState<Record<string, ResponseState>>({});
  const [availableAudio, setAvailableAudio] = useState(audio);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const sampleHeading = useRef<HTMLHeadingElement>(null);
  const sample = samples.find(item => item.level === level && item.skill === skill);
  const response = sample ? responses[sample.id] ?? {} : {};
  const step = skills.indexOf(skill);
  const position = levels.indexOf(level) * skills.length + step;
  const Icon = skillIcons[skill];

  const fetchAudioStatus = async () => {
    const result = await fetch('/api/admin/eiken-samples', { credentials: 'same-origin', cache: 'no-store' });
    if (!result.ok) throw new Error('音声の準備状況を確認できませんでした。もう一度確認してください。');
    const data: { audio?: SampleAudio[] } = await result.json();
    if (!Array.isArray(data.audio)) throw new Error('音声の準備状況を読み込めませんでした。');
    setAvailableAudio(data.audio);
  };

  const refreshAudio = async () => {
    if (audioBusy) return;
    setAudioBusy(true);
    setAudioError('');
    try { await fetchAudioStatus(); }
    catch (error) { setAudioError(error instanceof Error ? error.message : '音声の準備状況を確認できませんでした。'); }
    finally { setAudioBusy(false); }
  };

  const prepareAudio = async (sampleId: string) => {
    if (audioBusy) return;
    setAudioBusy(true);
    setAudioError('');
    setAvailableAudio(previous => previous.map(clip => clip.sampleId === sampleId ? { ...clip, state: 'pending' } : clip));
    try {
      const result = await fetch('/api/admin/eiken-samples/audio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ sampleId }), signal: AbortSignal.timeout(65_000),
      });
      if (!result.ok) {
        const data: { error?: string } = await result.json().catch(() => ({}));
        throw new Error(data.error || '音声の準備が完了しませんでした。準備状況を確認してください。');
      }
      await fetchAudioStatus();
    } catch (error) {
      setAudioError(error instanceof Error && error.name !== 'TimeoutError' ? error.message : '準備結果の確認に時間がかかっています。「準備状況を確認」で確かめてください。');
      try { await fetchAudioStatus(); } catch { /* Keep pending so this does not trigger a paid retry. */ }
    } finally { setAudioBusy(false); }
  };

  const update = (patch: Partial<ResponseState>) => {
    if (sample) setResponses(previous => ({ ...previous, [sample.id]: { ...previous[sample.id], ...patch } }));
  };

  const navigate = (nextLevel: EikenSample['level'], nextSkill: EikenSample['skill']) => {
    if (nextLevel === level && nextSkill === skill) return;
    setLevel(nextLevel);
    setSkill(nextSkill);
    requestAnimationFrame(() => {
      sampleHeading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  };

  const move = (direction: -1 | 1) => {
    const next = position + direction;
    if (next < 0 || next >= levels.length * skills.length) return;
    navigate(levels[Math.floor(next / skills.length)], skills[next % skills.length]);
  };

  const count = wordCount(response.writing ?? '');
  const withinRange = !!sample?.wordRange && count >= sample.wordRange[0] && count <= sample.wordRange[1];
  const hasAnswer = sample?.choices?.length && sample.correctIndex !== undefined;

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" className={styles.back}><ArrowLeft size={18} aria-hidden="true" />ホーム</Link>
      <span className={styles.adminLabel}>管理者用の見本</span>
    </header>

    <div className={styles.intro}>
      <p className={styles.eyebrow}>英検 2級・準1級</p>
      <h1>問題と声を、試してみる。</h1>
      <p>読む・聞く・書くを1問ずつ。問題の難しさと、声の聞きやすさを確認できます。</p>
    </div>

    <div className={styles.selectors}>
      <div className={styles.levels} aria-label="級を選ぶ">
        {levels.map(item => <button type="button" key={item} aria-pressed={level === item} onClick={() => navigate(item, skill)}>{item}</button>)}
      </div>
      <div className={styles.skills} aria-label="技能を選ぶ">
        {skills.map(item => {
          const ItemIcon = skillIcons[item];
          return <button type="button" key={item} aria-pressed={skill === item} onClick={() => navigate(level, item)}><ItemIcon size={18} aria-hidden="true" /><span>{item}<small>{skillLabels[item]}</small></span></button>;
        })}
      </div>
    </div>

    {sample ? <article className={styles.sample}>
      <div className={styles.sampleTop}><span><Icon size={16} aria-hidden="true" />{level}・{skill}</span><span>{step + 1} / 3</span></div>
      <h2 ref={sampleHeading} tabIndex={-1}>{sample.title}</h2>
      <p className={styles.instructions}>{sample.instructions}</p>
      <details className={styles.formatNote}><summary>問題の形式について<ChevronDown size={15} aria-hidden="true" /></summary><p>{sample.formatNote}</p></details>

      <AudioPreview key={sample.id} clips={availableAudio.filter(clip => clip.sampleId === sample.id)} busy={audioBusy} onPrepare={prepareAudio} onRefresh={refreshAudio} />
      {audioError && <p className={styles.audioRequestError} role="alert">{audioError}</p>}

      {skill === 'Listening' && !response.answered && <p className={styles.listenNote}>台本は回答後に確認できます。まず音声を聞いて、答えを選んでください。</p>}
      {sample.passage && <section className={styles.passage} aria-label="英文"><p lang="en">{sample.passage}</p></section>}
      <h3 className={styles.question} lang="en">{sample.question}</h3>

      {hasAnswer && <form onSubmit={event => { event.preventDefault(); if (response.selected !== undefined) update({ answered: true }); }}>
        <fieldset className={styles.choices} disabled={response.answered}>
          <legend className={styles.choiceLegend}>答えを1つ選んでください</legend>
          {sample.choices!.map((choice, index) => <label key={index} className={`${styles.choice} ${response.selected === index ? styles.choiceSelected : ''} ${response.answered && index === sample.correctIndex ? styles.correctChoice : ''}`}>
            <input type="radio" name={`choice-${sample.id}`} checked={response.selected === index} onChange={() => update({ selected: index })} />
            <span className={styles.choiceNumber}>{index + 1}</span><span lang="en">{choice}</span>
            {response.answered && index === sample.correctIndex && <Check size={18} className={styles.choiceCheck} aria-label="正解" />}
          </label>)}
        </fieldset>
        {!response.answered && <div className={styles.answerAction}><button type="submit" className={styles.primary} disabled={response.selected === undefined}>答えを確認する</button>{response.selected === undefined && <p>選ぶと答えを確認できます</p>}</div>}
      </form>}

      {response.answered && <section className={styles.feedback} aria-live="polite">
        <h3>{response.selected === sample.correctIndex ? '正解です' : `正解は ${Number(sample.correctIndex) + 1} です`}</h3>
        <p>{sample.explanation}</p>
        {sample.script && <><button type="button" className={styles.disclosure} aria-expanded={!!response.showScript} onClick={() => update({ showScript: !response.showScript })}>{response.showScript ? '台本を閉じる' : '台本を見て聞き直す'}<ChevronDown size={16} aria-hidden="true" /></button>{response.showScript && <div className={styles.script}>{sample.script.map((turn, index) => <div key={index}><span>{turn.speaker === 'female' ? '女性' : '男性'}</span><p lang="en">{turn.text}</p></div>)}</div>}</>}
        <button type="button" className={styles.retry} onClick={() => update({ selected: undefined, answered: false, showScript: false })}>もう一度解く</button>
      </section>}

      {skill === 'Writing' && <section className={styles.writing}>
        {!!sample.points?.length && <div className={styles.points}><h3>POINTS</h3><ul lang="en">{sample.points.map(point => <li key={point}>{point}</li>)}</ul></div>}
        <label htmlFor={`writing-${sample.id}`}>英語で書いてみる<span>{sample.wordRange ? `目安 ${sample.wordRange[0]}〜${sample.wordRange[1]}語` : '自由に入力できます'}</span></label>
        <textarea id={`writing-${sample.id}`} value={response.writing ?? ''} onChange={event => update({ writing: event.target.value })} placeholder="I think…" rows={8} lang="en" spellCheck />
        <p className={`${styles.wordCount} ${withinRange ? styles.wordCountGood : ''}`} aria-live="polite">{withinRange && <Check size={15} aria-hidden="true" />} {count}語 {sample.wordRange && count > sample.wordRange[1] && '・目安より多めです'}{sample.wordRange && count > 0 && count < sample.wordRange[0] && '・もう少し理由や具体例を加えられます'}</p>
        <p className={styles.localNote}>試し書きはこのページ内だけに残ります。級・技能の切り替えでは消えませんが、ページを閉じると消えます。自動採点は行いません。</p>
        {!!sample.rubric?.length && <details className={styles.checklist}><summary>書いたら、自分で確認する<ChevronDown size={17} aria-hidden="true" /></summary><div>{sample.rubric.map((item, index) => <label key={item}><input type="checkbox" checked={response.checked?.includes(index) ?? false} onChange={event => update({ checked: event.target.checked ? [...(response.checked ?? []), index] : (response.checked ?? []).filter(value => value !== index) })} /><span>{item}</span></label>)}</div></details>}
        {sample.modelAnswer && <><button type="button" className={styles.modelButton} aria-expanded={!!response.showModel} onClick={() => update({ showModel: !response.showModel })}>{response.showModel ? '解答例を閉じる' : '解答例とポイントを見る'}<ChevronDown size={17} aria-hidden="true" /></button>{response.showModel && <div className={styles.model}><p className={styles.modelLabel}>解答例・{wordCount(sample.modelAnswer)}語</p><p lang="en">{sample.modelAnswer}</p><h3>書き方のポイント</h3><p>{sample.explanation}</p></div>}</>}
      </section>}

      <p className={styles.testNote}>オリジナルの見本問題です。学習の成績には記録されず、学習者には公開されません。</p>
    </article> : <div className={styles.sample}><h2 ref={sampleHeading} tabIndex={-1}>この見本はまだありません</h2><p>ほかの技能を選んでください。</p></div>}

    <nav className={styles.navigation} aria-label="次の見本へ">
      <button type="button" className={styles.previous} disabled={position === 0} onClick={() => move(-1)}><ArrowLeft size={18} aria-hidden="true" />前へ</button>
      <span>{level}<small>{step + 1} / 3</small></span>
      {position < levels.length * skills.length - 1 ? <button type="button" className={styles.next} onClick={() => move(1)}>{step < 2 ? `次：${skillLabels[skills[step + 1]]}` : '次：準1級'}<ArrowRight size={18} aria-hidden="true" /></button> : <Link href="/" className={styles.next}>ホームへ<ArrowRight size={18} aria-hidden="true" /></Link>}
    </nav>
  </main>;
}
