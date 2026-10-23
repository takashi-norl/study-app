'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Headphones, RotateCcw, Square, Volume2 } from 'lucide-react';
import type { VocabularyAudio, VocabularyEntry } from '@/lib/vocabulary-types';
import type { GlossaryEntry } from '@/lib/vocabulary-glossary';
import { buildVocabularyTest, checkVocabularyAnswer, summarizeVocabularyTest, vocabularyGroups, type VocabularyTestItem } from '@/lib/vocabulary-session';
import { GLOSSARY_PAUSE_AUDIO_EVENT, GlossaryHistoryButton, GlossarySentence, VocabularyGlossaryProvider } from './vocabulary-glossary';
import VerbForms from './verb-forms';
import styles from './vocabulary-marathon.module.css';

type TestState = {
  items: VocabularyTestItem[];
  answers: Record<string, number | string>;
  checked: Record<string, boolean>;
  question: number;
};
type GroupState = {
  stage: 'learn' | 'test' | 'result' | 'production';
  wordIndex: number;
  examples: Record<string, number>;
  reviewWordIds?: string[];
  test?: TestState;
  round: number;
  productionWordId?: string;
  writing: Record<string, string>;
  selfChecks: Record<string, number[]>;
  showModel: boolean;
  completedOnce?: boolean;
};
const initialGroup = (): GroupState => ({ stage: 'learn', wordIndex: 0, examples: {}, round: 0, writing: {}, selfChecks: {}, showModel: false });

function WordAudio({ entry, clip, example, stopKey, busy, onPrepare, onRefresh }: {
  entry: VocabularyEntry;
  clip?: VocabularyAudio;
  example: number;
  stopKey: string;
  busy: boolean;
  onPrepare: () => void;
  onRefresh: () => void;
}) {
  const player = useRef<HTMLAudioElement>(null);
  const range = useRef<NonNullable<VocabularyAudio['segments']>[number] | null>(null);
  const pendingSeek = useRef(false);
  const startRequestedAt = useRef(0);
  const lastSeekAt = useRef(0);
  const playbackToken = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');

  const stop = useCallback(() => {
    playbackToken.current += 1;
    range.current = null;
    pendingSeek.current = false;
    if (stopTimer.current) clearInterval(stopTimer.current);
    stopTimer.current = null;
    if (player.current) { player.current.pause(); player.current.muted = false; }
    setActive(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    stop();
    setError('');
  }, [stopKey, clip?.url, stop]);

  useEffect(() => {
    const element = player.current;
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener(GLOSSARY_PAUSE_AUDIO_EVENT, stop);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener(GLOSSARY_PAUSE_AUDIO_EVENT, stop);
      playbackToken.current += 1;
      if (stopTimer.current) clearInterval(stopTimer.current);
      element?.pause();
    };
  }, [stop, clip?.url, clip?.state]);

  const completePendingSeek = () => {
    const element = player.current;
    const segment = range.current;
    if (!element || !segment || !pendingSeek.current) return;
    const now = Date.now();
    if (now - startRequestedAt.current >= 15_000) {
      stop();
      setError('音声の読み込みに時間がかかっています。接続を確認して、もう一度「聞く」を押してください。');
      return;
    }
    if (element.readyState < 1 || element.seeking) return;
    const atStart = element.currentTime >= segment.startSeconds - 0.08 && element.currentTime <= segment.startSeconds + 0.12;
    if (atStart && element.readyState >= 2) {
      pendingSeek.current = false;
      element.muted = false;
      setLoading(false);
      return;
    }
    // Metadata may arrive before Safari can seek. Keep listening for usable data instead of accepting a dropped seek.
    const seekable = element.seekable;
    let targetAvailable = false;
    for (let index = 0; index < seekable.length; index += 1) {
      if (segment.startSeconds >= seekable.start(index) && segment.startSeconds < seekable.end(index)) {
        targetAvailable = true;
        break;
      }
    }
    if (!targetAvailable || atStart || now - lastSeekAt.current < 250) return;
    lastSeekAt.current = now;
    try {
      element.currentTime = segment.startSeconds;
    } catch {
      // A subsequent canplay/progress event retries while the bounded start timer remains active.
    }
  };

  const checkPlayback = () => {
    if (pendingSeek.current) { completePendingSeek(); return; }
    if (player.current && range.current && player.current.currentTime >= range.current.endSeconds) stop();
  };

  const play = (id: string) => {
    if (active === id) { stop(); return; }
    stop();
    setError('');
    const segment = clip?.segments?.find(item => item.id === id);
    const element = player.current;
    if (!segment || !element) {
      setError('この音声を読み込めませんでした。「準備状況を確認」で確かめてください。');
      return;
    }
    const token = playbackToken.current;
    range.current = segment;
    pendingSeek.current = true;
    startRequestedAt.current = Date.now();
    lastSeekAt.current = 0;
    setActive(id);
    setLoading(true);
    element.playbackRate = rate;
    // Start playback within the tap gesture on iPhone; stay silent until the requested range is ready.
    element.muted = true;
    try {
      const playing = element.play();
      completePendingSeek();
      stopTimer.current = setInterval(checkPlayback, 35);
      void playing.then(() => {
        if (token !== playbackToken.current) return;
        completePendingSeek();
      }).catch(() => {
        if (token !== playbackToken.current) return;
        stop();
        setError('再生できませんでした。もう一度「聞く」を押してください。');
      });
    } catch {
      stop();
      setError('再生できませんでした。もう一度「聞く」を押してください。');
    }
  };

  const state = clip?.state ?? 'missing';
  const button = (id: string, label: string) => <button type="button" className={`${styles.listen} ${active === id ? styles.listening : ''}`} onClick={() => play(id)} aria-pressed={active === id}>
    {active === id ? <Square size={17} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
    {active === id ? loading ? '読込中・停止' : '再生中・停止' : label}
  </button>;

  return <section className={styles.audio} aria-label={`${entry.word}の音声`}>
    <div className={styles.audioTop}>
      <span><Headphones size={16} aria-hidden="true" />{clip?.voiceLabel || '英語の発音'}</span>
      <div className={styles.speed} aria-label="再生速度">
        {[1, 0.8].map(value => <button type="button" key={value} aria-pressed={value === rate} onClick={() => { setRate(value); if (player.current) player.current.playbackRate = value; }}>{value === 1 ? '通常' : 'ゆっくり'}</button>)}
      </div>
    </div>
    {state === 'ready' ? <>
      <audio ref={player} src={clip?.url} preload="metadata" onLoadedMetadata={completePendingSeek} onCanPlay={completePendingSeek} onProgress={completePendingSeek} onSeeked={completePendingSeek} onTimeUpdate={checkPlayback} onEnded={() => {
        if (pendingSeek.current) {
          stop();
          setError('音声の開始位置を読み込めませんでした。もう一度「聞く」を押してください。');
        } else stop();
      }} onError={() => { stop(); setError('音声を読み込めませんでした。接続を確認して、もう一度お試しください。'); }} />
      <div className={styles.audioActions}>{button('word', '単語を聞く')}{button(`example-${example + 1}`, `例文${example + 1}を聞く`)}</div>
      <p className={styles.audioHint}>単語と例文を、それぞれ何度でも聞けます。</p>
    </> : <div className={styles.audioStatus} aria-live="polite">
      <p>{state === 'missing' ? '単語の発音と3つの例文の音声を準備します。' : state === 'pending' ? '音声を準備しています。別の単語へ移動しても大丈夫です。' : '音声の準備が完了しませんでした。準備状況を確認してください。'}</p>
      <button type="button" className={styles.secondary} disabled={busy} onClick={state === 'missing' ? onPrepare : onRefresh}>{busy ? '音声を準備しています…' : state === 'missing' ? 'この単語の音声を準備' : '準備状況を確認'}</button>
    </div>}
    {error && <p className={styles.error} role="alert">{error}<button type="button" onClick={() => { stop(); setError(''); player.current?.load(); onRefresh(); }}>準備状況を確認</button></p>}
  </section>;
}

export default function VocabularyMarathon({ entries, audio, preparation, glossary }: { entries: VocabularyEntry[]; audio: VocabularyAudio[]; preparation?: ReactNode; glossary: GlossaryEntry[] }) {
  const [level, setLevel] = useState<VocabularyEntry['level']>('2級');
  const [groupIndex, setGroupIndex] = useState(0);
  const [sessions, setSessions] = useState<Record<string, GroupState>>({});
  const [availableAudio, setAvailableAudio] = useState(audio);
  const [busyWord, setBusyWord] = useState<string | null>(null);
  const [audioError, setAudioError] = useState('');
  useEffect(() => { setAvailableAudio(audio); }, [audio]);
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const groups = vocabularyGroups(entries, level);
  const group = groups[groupIndex] ?? [];
  const sessionKey = `${level}-${groupIndex}`;
  const session = sessions[sessionKey] ?? initialGroup();
  const learningEntries = session.reviewWordIds ? group.filter(item => session.reviewWordIds?.includes(item.id)) : group;
  const entry = learningEntries[session.wordIndex] ?? learningEntries[0];
  const exampleIndex = entry ? session.examples[entry.id] ?? 0 : 0;
  const example = entry?.examples[exampleIndex];
  const test = session.test;
  const item = test?.items[test.question];
  const checked = item ? !!test?.checked[item.id] : false;
  const answer = item ? test?.answers[item.id] : undefined;
  const submittedAnswers = test ? Object.fromEntries(Object.entries(test.answers).filter(([id]) => test.checked[id])) : {};
  const summary = test ? summarizeVocabularyTest(test.items, submittedAnswers) : null;
  const allChecked = !!test && test.items.length > 0 && test.items.every(question => test.checked[question.id]);
  const resultReady = allChecked && !!summary?.completed;
  const weakEntries = group.filter(word => summary?.wrongWordIds.includes(word.id));
  const productionEntry = group.find(word => word.id === session.productionWordId) ?? weakEntries[0] ?? group[0];
  const writing = productionEntry ? session.writing[productionEntry.id] ?? '' : '';
  const hasInput = typeof answer === 'number' || typeof answer === 'string' && answer.trim().length > 0;
  const isReview = !!session.reviewWordIds;
  const finishedSets = Object.values(sessions).filter(saved => saved.completedOnce).length;

  const update = (patch: Partial<GroupState>) => setSessions(previous => ({ ...previous, [sessionKey]: { ...(previous[sessionKey] ?? initialGroup()), ...patch } }));
  const updateTest = (patch: Partial<TestState>) => { if (test) update({ test: { ...test, ...patch } }); };
  const focusCard = () => requestAnimationFrame(() => {
    heading.current?.focus({ preventScroll: true });
    if (card.current) window.scrollTo({ top: Math.max(0, card.current.getBoundingClientRect().top + window.scrollY - 14), behavior: 'instant' });
  });
  const focusFeedback = () => requestAnimationFrame(() => {
    feedback.current?.focus({ preventScroll: true });
    if (feedback.current) window.scrollTo({ top: Math.max(0, feedback.current.getBoundingClientRect().top + window.scrollY - 16), behavior: 'instant' });
  });
  const navigateSet = (nextLevel: VocabularyEntry['level'], nextIndex: number) => {
    setLevel(nextLevel);
    setGroupIndex(nextIndex);
    setAudioError('');
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  };
  const goLearn = (wordIndex = session.wordIndex) => { update({ stage: 'learn', wordIndex }); focusCard(); };
  const showExample = (index: number) => { if (entry) update({ examples: { ...session.examples, [entry.id]: index } }); };
  const startTest = (allWords = false) => {
    if (test && !resultReady && !allWords) { update({ stage: 'test' }); focusCard(); return; }
    const words = allWords ? group : learningEntries;
    update({ stage: 'test', round: session.round + 1, ...(allWords ? { reviewWordIds: undefined } : {}), test: { items: buildVocabularyTest(words, session.round), answers: {}, checked: {}, question: 0 } });
    focusCard();
  };
  const submit = (unknown = false) => {
    if (!test || !item || checked || !unknown && !hasInput) return;
    updateTest({ answers: unknown ? { ...test.answers, [item.id]: '' } : test.answers, checked: { ...test.checked, [item.id]: true } });
    focusFeedback();
  };
  const finishTest = () => { if (resultReady) { update({ stage: 'result', completedOnce: true }); focusCard(); } };
  const nextTest = () => {
    if (!test || !item) return;
    if (!checked) submit();
    else if (test.question < test.items.length - 1) { updateTest({ question: test.question + 1 }); focusCard(); }
    else finishTest();
  };
  const reviewWeak = () => {
    if (!summary?.wrongWordIds.length) return;
    update({ stage: 'learn', reviewWordIds: summary.wrongWordIds, wordIndex: 0 });
    focusCard();
  };
  const fetchAudioStatus = async () => {
    const response = await fetch('/api/admin/vocabulary-samples', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('音声の準備状況を確認できませんでした。');
    const data: { audio?: VocabularyAudio[] } = await response.json();
    if (!Array.isArray(data.audio)) throw new Error('音声の準備状況を読み込めませんでした。');
    setAvailableAudio(data.audio);
  };
  const refresh = async () => {
    setAudioError('');
    try { await fetchAudioStatus(); }
    catch (error) { setAudioError(error instanceof Error ? error.message : '準備状況を確認できませんでした。'); }
  };
  const prepare = async () => {
    if (busyWord || !entry) return;
    const id = entry.id;
    setBusyWord(id);
    setAudioError('');
    setAvailableAudio(previous => previous.some(clip => clip.wordId === id)
      ? previous.map(clip => clip.wordId === id ? { ...clip, state: 'pending' } : clip)
      : [...previous, { wordId: id, state: 'pending', voiceLabel: '', url: '' }]);
    try {
      const response = await fetch('/api/admin/vocabulary-samples/audio', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wordId: id }), signal: AbortSignal.timeout(65_000),
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(data.error || '音声の準備が完了しませんでした。');
      }
      await fetchAudioStatus();
    } catch (error) {
      setAudioError(`${entry.word} の音声：${error instanceof Error && error.name !== 'TimeoutError' ? error.message : '準備結果の確認に時間がかかっています。「準備状況を確認」で確かめてください。'}`);
      try { await fetchAudioStatus(); } catch { /* Keep pending rather than repeat a paid request. */ }
    } finally { setBusyWord(null); }
  };

  if (!entry || !example) return <main className={styles.page}><Link className={styles.back} href="/admin/eiken-samples"><ArrowLeft size={18} />英検サンプルへ</Link><p>単語セットを準備しています。</p></main>;

  const nextSet = groupIndex < groups.length - 1 ? { level, index: groupIndex + 1 } : level === '2級' && entries.some(word => word.level === '準1級') ? { level: '準1級' as const, index: 0 } : undefined;
  const testLabel = test && !resultReady ? '途中のテストに戻る' : isReview ? `苦手${learningEntries.length}語を再テスト` : `${group.length}語をまとめてテスト`;
  const nextLearn = () => {
    if (session.wordIndex < learningEntries.length - 1) { update({ wordIndex: session.wordIndex + 1 }); focusCard(); }
    else startTest();
  };

  return <VocabularyGlossaryProvider entries={glossary}><main className={styles.page}>
    <header className={styles.header}>
      <Link className={styles.back} href="/"><ArrowLeft size={17} aria-hidden="true" />ホーム</Link>
      <Link className={styles.back} href="/admin/eiken-samples">英検サンプル<ArrowRight size={16} aria-hidden="true" /></Link>
    </header>
    <div className={styles.intro}>
      <div><p className={styles.eyebrow}>管理者用サンプル</p><span className={styles.progress}>{finishedSets}セットを確認</span></div>
      <h1>ボキャブラリーマラソン</h1>
      <p>10語を学ぶ → 混ぜてテスト → 苦手をもう一度</p>
    </div>
    {(session.stage === 'learn' || session.stage === 'result') && <div className={styles.glossaryTools}><span>例文の下線を押すと、言葉の説明が開きます</span><GlossaryHistoryButton /></div>}
    {session.stage !== 'test' && session.stage !== 'production' && preparation}
    {session.stage !== 'test' && session.stage !== 'production' && <>
      <div className={styles.levels} aria-label="英検の級">
        {(['2級', '準1級'] as const).map(value => <button type="button" key={value} aria-pressed={value === level} onClick={() => navigateSet(value, 0)}>{value}<small>{entries.filter(word => word.level === value).length}語</small></button>)}
      </div>
      <div className={styles.sets} aria-label="学ぶ単語セット">
        {groups.map((words, index) => <button type="button" key={index} aria-pressed={groupIndex === index} onClick={() => navigateSet(level, index)}><span>セット{index + 1}</span><small>{words.length}語</small></button>)}
      </div>
    </>}
    <nav className={styles.steps} aria-label="学習のステップ">
      <button type="button" aria-current={session.stage === 'learn' ? 'step' : undefined} onClick={() => goLearn()}><span>1</span>学ぶ</button>
      <ChevronRight size={13} aria-hidden="true" />
      <button type="button" aria-current={session.stage === 'test' ? 'step' : undefined} onClick={() => startTest()}><span>2</span>まとめてテスト</button>
      <ChevronRight size={13} aria-hidden="true" />
      <button type="button" aria-current={session.stage === 'result' || session.stage === 'production' ? 'step' : undefined} disabled={!resultReady} title="全問の答え合わせ後に確認できます" onClick={finishTest}><span>3</span>結果・復習</button>
    </nav>
    <article className={styles.card} ref={card}>
      {session.stage === 'learn' && <>
        <div className={styles.learnTop}><span>{level} · セット{groupIndex + 1}{isReview ? ' · 苦手の学び直し' : ''}</span><button type="button" onClick={() => startTest()}>{testLabel}<ArrowRight size={14} aria-hidden="true" /></button></div>
        <div className={styles.wordHeading}>
          <div><p>{session.wordIndex + 1} / {learningEntries.length}語目</p><h2 ref={heading} tabIndex={-1} lang="en">{entry.word}</h2></div><span>{entry.partOfSpeech}</span>
        </div>
        <p className={styles.ipa}><span lang="en">{entry.ipa}</span><small>{entry.ipaLabel}</small></p>
        <WordAudio key={entry.id} entry={entry} clip={availableAudio.find(clip => clip.wordId === entry.id)} example={exampleIndex} stopKey={`${entry.id}-${session.stage}-${exampleIndex}`} busy={!!busyWord} onPrepare={() => void prepare()} onRefresh={() => void refresh()} />
        {audioError && <p role="alert" className={styles.error}>{audioError}</p>}
        <div className={styles.definition}><p lang="en">{entry.definition}</p><p>{entry.meaning}</p></div>
        <VerbForms key={entry.id} forms={entry.verbForms} />
        <section className={styles.example} aria-label={`例文 ${exampleIndex + 1}`}>
          <div className={styles.exampleHeading}><span>例文 {exampleIndex + 1} / {entry.examples.length}</span><strong>{example.context}</strong></div>
          <p lang="en" className={styles.exampleText}><GlossarySentence text={example.text} /></p>
          <details className={styles.translation} key={example.id}><summary>日本語の意味を見る</summary><p>{example.translation}</p></details>
          <div className={styles.examplePager}>
            <button type="button" aria-label="前の例文" disabled={exampleIndex === 0} onClick={() => showExample(exampleIndex - 1)}><ChevronLeft size={19} /></button>
            <div aria-label={`${exampleIndex + 1}番目の例文`}>{entry.examples.map((item, index) => <button type="button" key={item.id} aria-label={`例文${index + 1}`} aria-pressed={exampleIndex === index} onClick={() => showExample(index)}><span /></button>)}</div>
            <button type="button" aria-label="次の例文" disabled={exampleIndex === entry.examples.length - 1} onClick={() => showExample(exampleIndex + 1)}><ChevronRight size={19} /></button>
          </div>
        </section>
        <details className={styles.tip}><summary>使い方のポイント</summary><p>{entry.usageTip}</p></details>
        <details className={styles.wordList}><summary>{isReview ? '学び直す単語' : `このセットの${group.length}語`}から選ぶ</summary><div>{learningEntries.map((word, index) => <button type="button" key={word.id} aria-pressed={entry.id === word.id} onClick={() => { update({ wordIndex: index }); focusCard(); }}><span>{index + 1}</span><span lang="en">{word.word}</span></button>)}</div></details>
      </>}
      {session.stage === 'test' && item && test && <section className={styles.quiz} aria-label="複数の単語を混ぜたテスト">
        <div className={styles.testHeading}><p>{level} · セット{groupIndex + 1}{isReview ? ' · 苦手の再テスト' : ''}</p><h2 ref={heading} tabIndex={-1}>まとめてテスト</h2></div>
        <p className={styles.quizMeta}>{item.kind === 'recall' ? '思い出して書く' : '文脈から選ぶ'}<span>{test.question + 1} / {test.items.length}問</span></p>
        <div className={styles.testProgress} aria-hidden="true"><span style={{ width: `${(test.question + 1) / test.items.length * 100}%` }} /></div>
        <h3>{item.prompt}</h3>
        {item.kind === 'choice' ? <fieldset className={styles.choices} disabled={checked}>
          <legend>一番適切なものを1つ選んでください</legend>
          {item.choices?.map((choice, index) => <label key={`${item.id}-${index}`} className={`${styles.choice} ${answer === index ? styles.selected : ''} ${checked && item.correctIndex === index ? styles.correctChoice : ''}`}>
            <input type="radio" name={`vocab-${item.id}`} value={index} checked={answer === index} onChange={() => updateTest({ answers: { ...test.answers, [item.id]: index } })} />
            <span className={styles.choiceNumber}>{checked && item.correctIndex === index ? <Check size={15} aria-label="正解" /> : index + 1}</span><span lang="en">{choice}</span>
          </label>)}
        </fieldset> : <form className={styles.recall} onSubmit={event => { event.preventDefault(); submit(); }}>
          <label htmlFor="vocabulary-recall-answer">空欄に合う英単語を入力</label>
          <input id="vocabulary-recall-answer" key={item.id} lang="en" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" value={typeof answer === 'string' ? answer : ''} readOnly={checked} onChange={event => updateTest({ answers: { ...test.answers, [item.id]: event.target.value } })} aria-describedby="vocabulary-recall-hint" />
          <p id="vocabulary-recall-hint">選択肢や頭文字を見ずに、思い出してみましょう。</p>
        </form>}
        {!checked && <button type="button" className={styles.unknown} onClick={() => submit(true)}>分からない・答えを見る</button>}
        {checked && <div ref={feedback} tabIndex={-1} className={`${styles.feedback} ${!checkVocabularyAnswer(item, answer ?? '') ? styles.incorrect : ''}`} role="status">
          <h4>{checkVocabularyAnswer(item, answer ?? '') ? <><CheckCircle2 size={20} aria-hidden="true" />{item.kind === 'recall' ? '思い出せました' : 'その使い方で合っています'}</> : item.kind === 'recall' ? '答えを確認しましょう' : `正解は ${(item.correctIndex ?? 0) + 1}`}</h4>
          {item.kind === 'recall' && <p className={styles.recallAnswer} lang="en">{item.answers?.join(' / ')}</p>}
          <p>{item.explanation}</p>
        </div>}
      </section>}
      {session.stage === 'result' && summary && test && <section className={styles.result}>
        <CheckCircle2 size={34} aria-hidden="true" />
        <h2 ref={heading} tabIndex={-1}>{isReview ? '苦手の再確認ができました' : `${group.length}語の確認ができました`}</h2>
        <p className={styles.resultSub}>{level} · セット{groupIndex + 1}{isReview ? ' · 再テストの結果' : ''}</p>
        <div className={styles.resultScores}>
          <div><span>選べた</span><p><strong>{summary.choice.correct}</strong> / {summary.choice.total}</p><small>使い方を見分ける</small></div>
          <div><span>思い出せた</span><p><strong>{summary.recall.correct}</strong> / {summary.recall.total}</p><small>自分で単語を書く</small></div>
        </div>
        <p className={styles.resultNote}>「選べる」と「何も見ずに思い出せる」を分けて確認しました。</p>
        {weakEntries.length > 0 ? <div className={styles.weakBox}><h3>もう一度確かめたい {weakEntries.length}語</h3><p lang="en">{weakEntries.map(word => word.word).join(' · ')}</p><button type="button" className={styles.secondary} onClick={reviewWeak}><RotateCcw size={16} aria-hidden="true" />苦手{weakEntries.length}語を学び直す</button><small>例文を確認してから、この単語だけ再テストできます。</small></div> : <p className={styles.allCorrect}>今回の確認はできました。少し時間を空けて、また試してみましょう。</p>}
        <button type="button" className={styles.productionEntry} onClick={() => { update({ stage: 'production', showModel: false }); focusCard(); }}><span><strong>自分の文でも使ってみる</strong><small>英作文1問・任意・自分で確認</small></span><ArrowRight size={18} aria-hidden="true" /></button>
        <div className={styles.resultLinks}><button type="button" className={styles.textButton} onClick={() => startTest(true)}>このセットの全{group.length * 2}問をもう一度</button><button type="button" className={styles.textButton} onClick={() => { update({ stage: 'learn', wordIndex: 0, reviewWordIds: undefined }); focusCard(); }}>全{group.length}語の学習へ戻る</button></div>
        <Link className={styles.finishLink} href="/">今日はここまで・ホームへ</Link>
      </section>}
      {session.stage === 'production' && productionEntry && <section className={styles.production}>
        <p className={styles.productionLabel}>任意のチャレンジ · 自分で確認</p>
        <h2 ref={heading} tabIndex={-1}>自分の文で使ってみる</h2>
        <label className={styles.productionPicker}>使う単語<select value={productionEntry.id} onChange={event => update({ productionWordId: event.target.value, showModel: false })}>{group.map(word => <option key={word.id} value={word.id}>{word.word}</option>)}</select></label>
        <p className={styles.productionPrompt}>{productionEntry.production.prompt}</p>
        <label htmlFor="vocabulary-production-answer">あなたの英文</label>
        <textarea id="vocabulary-production-answer" value={writing} rows={4} lang="en" autoCapitalize="sentences" spellCheck={false} onChange={event => update({ writing: { ...session.writing, [productionEntry.id]: event.target.value } })} />
        <p className={styles.resultNote}>AIによる採点は行いません。解答例と確認ポイントを使って、自分の文を見直します。</p>
        {session.showModel && <div ref={feedback} tabIndex={-1} className={styles.selfReview}>
          <h3>解答例</h3><p lang="en">{productionEntry.production.modelAnswer}</p><small>これは一例です。別の表現でも、意味が自然に伝われば大丈夫です。</small>
          <fieldset><legend>自分の文をチェック</legend>{productionEntry.production.checkpoints.map((point, index) => <label key={`${productionEntry.id}-${index}`}><input type="checkbox" checked={(session.selfChecks[productionEntry.id] ?? []).includes(index)} onChange={event => {
            const previous = session.selfChecks[productionEntry.id] ?? [];
            update({ selfChecks: { ...session.selfChecks, [productionEntry.id]: event.target.checked ? [...previous, index] : previous.filter(item => item !== index) } });
          }} /><span>{point}</span></label>)}</fieldset>
        </div>}
      </section>}
    </article>
    <p className={styles.previewNote}>管理者だけが見られる試作です。学習者には未公開で、成績には記録しません。このタブでセットを切り替えても回答は残りますが、再読み込みや終了でリセットされます。</p>
    <footer className={styles.footer}>
      {session.stage === 'learn' ? <>
        {session.wordIndex > 0 ? <button type="button" className={styles.previous} onClick={() => { update({ wordIndex: session.wordIndex - 1 }); focusCard(); }}><ArrowLeft size={17} aria-hidden="true" />前の単語</button> : isReview && resultReady ? <button type="button" className={styles.previous} onClick={finishTest}><ArrowLeft size={17} aria-hidden="true" />結果へ戻る</button> : <Link className={styles.previous} href="/admin/eiken-samples"><ArrowLeft size={17} aria-hidden="true" />サンプル一覧</Link>}
        <button type="button" className={styles.primary} onClick={nextLearn}>{session.wordIndex < learningEntries.length - 1 ? '次の単語' : testLabel}<ArrowRight size={18} aria-hidden="true" /></button>
        <p>{session.wordIndex + 1} / {learningEntries.length}語目 · 例文はカード内の矢印で切り替えられます</p>
      </> : session.stage === 'test' && test && item ? <>
        <button type="button" className={styles.previous} onClick={() => { if (test.question > 0) { updateTest({ question: test.question - 1 }); focusCard(); } else goLearn(); }}><ArrowLeft size={17} aria-hidden="true" />{test.question > 0 ? '前の問題' : '学習へ戻る'}</button>
        <button type="button" className={styles.primary} disabled={!checked && !hasInput} onClick={nextTest}>{!checked ? '答え合わせ' : test.question < test.items.length - 1 ? '次の問題' : '結果を見る'}<ArrowRight size={18} aria-hidden="true" /></button>
        <p>{test.question + 1} / {test.items.length}問 · {checked ? '理由を確認したら次へ' : item.kind === 'recall' ? '単語を入力すると答え合わせできます' : '答えを1つ選んでください'}</p>
      </> : session.stage === 'production' ? <>
        <button type="button" className={styles.previous} onClick={finishTest}><ArrowLeft size={17} aria-hidden="true" />結果へ戻る</button>
        <button type="button" className={styles.primary} disabled={!session.showModel && !writing.trim()} onClick={() => { if (session.showModel) finishTest(); else { update({ showModel: true }); focusFeedback(); } }}>{session.showModel ? '確認を終える' : '解答例と確認ポイント'}<ArrowRight size={18} aria-hidden="true" /></button>
        <p>自分の文を見直す練習です。自動採点はしません。</p>
      </> : <>
        <button type="button" className={styles.previous} onClick={() => { update({ stage: 'learn', wordIndex: 0, reviewWordIds: undefined }); focusCard(); }}><ArrowLeft size={17} aria-hidden="true" />学習に戻る</button>
        {nextSet ? <button type="button" className={styles.primary} onClick={() => navigateSet(nextSet.level, nextSet.index)}>{nextSet.level !== level ? '準1級のセット1へ' : '次のセットへ'}<ArrowRight size={18} aria-hidden="true" /></button> : <Link className={styles.primary} href="/">終了してホームへ<ArrowRight size={18} aria-hidden="true" /></Link>}
        <p>{level} · セット{groupIndex + 1}の確認が終わりました</p>
      </>}
    </footer>
  </main></VocabularyGlossaryProvider>;
}
