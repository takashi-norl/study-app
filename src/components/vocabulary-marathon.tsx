'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Headphones, RotateCcw, Square, Volume2 } from 'lucide-react';
import type { VocabularyAudio, VocabularyEntry } from '@/lib/vocabulary-types';
import styles from './vocabulary-marathon.module.css';

type StudyState = {
  stage: 'learn' | 'quiz' | 'result';
  example: number;
  question: number;
  selected: Record<string, number>;
  checked: Record<string, boolean>;
  questionOrder?: string[];
  firstCorrect?: number;
};

const initialStudy = (): StudyState => ({ stage: 'learn', example: 0, question: 0, selected: {}, checked: {} });
const questionLabels = { usage: '自然な使い方', context: '文脈から考える', paraphrase: '別の言葉で捉える' };

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
    return () => {
      document.removeEventListener('visibilitychange', visibility);
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

export default function VocabularyMarathon({ entries, audio }: { entries: VocabularyEntry[]; audio: VocabularyAudio[] }) {
  const [level, setLevel] = useState<VocabularyEntry['level']>('2級');
  const [wordId, setWordId] = useState(entries.find(entry => entry.level === '2級')?.id ?? entries[0]?.id ?? '');
  const [studies, setStudies] = useState<Record<string, StudyState>>({});
  const [availableAudio, setAvailableAudio] = useState(audio);
  const [busyWord, setBusyWord] = useState<string | null>(null);
  const [audioError, setAudioError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLElement>(null);
  const entry = entries.find(item => item.id === wordId);
  const levelEntries = entries.filter(item => item.level === level);
  const wordIndex = levelEntries.findIndex(item => item.id === wordId);
  const study = studies[wordId] ?? initialStudy();
  const example = entry?.examples[study.example];
  const questions = entry ? (study.questionOrder?.map(id => entry.questions.find(question => question.id === id)).filter((question): question is VocabularyEntry['questions'][number] => !!question) ?? entry.questions) : [];
  const question = questions[study.question];
  const selected = question ? study.selected[question.id] : undefined;
  const checked = question ? study.checked[question.id] : false;
  const correctCount = entry?.questions.filter(item => study.checked[item.id] && study.selected[item.id] === item.correctIndex).length ?? 0;
  const wrong = entry?.questions.filter(item => study.checked[item.id] && study.selected[item.id] !== item.correctIndex) ?? [];
  const completed = entries.filter(item => {
    const saved = studies[item.id];
    return saved && item.questions.every(question => saved.checked[question.id]);
  }).length;

  const update = (patch: Partial<StudyState>) => setStudies(previous => ({ ...previous, [wordId]: { ...(previous[wordId] ?? initialStudy()), ...patch } }));
  const focusCard = () => requestAnimationFrame(() => {
    heading.current?.focus({ preventScroll: true });
    if (card.current) {
      const top = card.current.getBoundingClientRect().top + window.scrollY - 14;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }
  });
  const navigate = (id: string) => {
    const target = entries.find(item => item.id === id);
    if (!target) return;
    setLevel(target.level);
    setWordId(id);
    setAudioError('');
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  };
  const changeStage = (stage: StudyState['stage']) => { update({ stage }); focusCard(); };
  const fetchAudioStatus = async () => {
    const result = await fetch('/api/admin/vocabulary-samples', { credentials: 'same-origin', cache: 'no-store' });
    if (!result.ok) throw new Error('音声の準備状況を確認できませんでした。');
    const data: { audio?: VocabularyAudio[] } = await result.json();
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
      const result = await fetch('/api/admin/vocabulary-samples/audio', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wordId: id }), signal: AbortSignal.timeout(65_000),
      });
      if (!result.ok) {
        const data: { error?: string } = await result.json().catch(() => ({}));
        throw new Error(data.error || '音声の準備が完了しませんでした。');
      }
      await fetchAudioStatus();
    } catch (error) {
      setAudioError(`${entry.word} の音声：${error instanceof Error && error.name !== 'TimeoutError' ? error.message : '準備結果の確認に時間がかかっています。「準備状況を確認」で確かめてください。'}`);
      try { await fetchAudioStatus(); } catch { /* Preserve pending state rather than repeat a paid request. */ }
    } finally { setBusyWord(null); }
  };

  if (!entry || !example || !question) return <main className={styles.page}><Link className={styles.back} href="/admin/eiken-samples"><ArrowLeft size={18} />英検サンプルへ</Link><p>見本の単語を準備しています。</p></main>;

  const nextWord = levelEntries[wordIndex + 1] ?? entries.find(item => item.level !== level && !item.questions.every(question => studies[item.id]?.checked[question.id]));
  const finish = () => {
    update({ stage: 'result', firstCorrect: study.firstCorrect ?? correctCount });
    focusCard();
  };
  const next = () => {
    if (study.stage === 'learn') {
      if (study.example < entry.examples.length - 1) update({ example: study.example + 1 });
      else { update({ stage: 'quiz', question: 0 }); focusCard(); }
    } else if (study.stage === 'quiz') {
      if (!checked) update({ checked: { ...study.checked, [question.id]: true } });
      else if (study.question < questions.length - 1) { update({ question: study.question + 1 }); focusCard(); }
      else finish();
    } else if (nextWord) navigate(nextWord.id);
  };
  const previous = () => {
    if (study.stage === 'result') { update({ stage: 'quiz', question: questions.length - 1 }); focusCard(); }
    else if (study.stage === 'quiz') {
      if (study.question > 0) update({ question: study.question - 1 });
      else update({ stage: 'learn', example: entry.examples.length - 1 });
      focusCard();
    } else if (study.example > 0) update({ example: study.example - 1 });
    else if (wordIndex > 0) navigate(levelEntries[wordIndex - 1].id);
  };
  const retry = () => {
    const retrySelected = { ...study.selected };
    const retryChecked = { ...study.checked };
    wrong.forEach(item => { delete retrySelected[item.id]; delete retryChecked[item.id]; });
    update({ stage: 'quiz', question: 0, questionOrder: wrong.map(item => item.id), selected: retrySelected, checked: retryChecked });
    focusCard();
  };
  const nextLabel = study.stage === 'learn' ? study.example < entry.examples.length - 1 ? '次の例文' : '使い方を試す' : study.stage === 'quiz' ? !checked ? '答え合わせ' : study.question < questions.length - 1 ? '次の問題' : '結果を見る' : nextWord ? nextWord.level !== level ? `${nextWord.level}へ` : '次の単語へ' : '完了';
  const previousLabel = study.stage === 'result' ? '問題へ' : study.stage === 'quiz' ? study.question === 0 ? '例文へ' : '前の問題' : study.example > 0 ? '前の例文' : '前の単語';

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link className={styles.back} href="/"><ArrowLeft size={17} aria-hidden="true" />ホーム</Link>
      <Link className={styles.back} href="/admin/eiken-samples">英検サンプル<ArrowRight size={16} aria-hidden="true" /></Link>
    </header>
    <div className={styles.intro}>
      <div><p className={styles.eyebrow}>管理者用サンプル</p><span className={styles.progress}>{completed} / {entries.length}語</span></div>
      <h1>ボキャブラリーマラソン</h1>
      <p>発音を聞く → 3つの例文 → 使い方を試す</p>
    </div>
    <div className={styles.levels} aria-label="英検の級">
      {(['2級', '準1級'] as const).map(value => <button type="button" key={value} aria-pressed={value === level} onClick={() => { const target = entries.find(item => item.level === value); if (target) navigate(target.id); }}>{value}<small>{entries.filter(item => item.level === value).length}語の見本</small></button>)}
    </div>
    <div className={styles.words} aria-label="学ぶ単語">
      {levelEntries.map((item, index) => <button type="button" key={item.id} aria-pressed={item.id === wordId} onClick={() => navigate(item.id)}><span>{index + 1}</span><span lang="en">{item.word}</span>{studies[item.id] && item.questions.every(question => studies[item.id].checked[question.id]) && <Check size={13} aria-label="練習済み" />}</button>)}
    </div>
    <nav className={styles.steps} aria-label="学習のステップ">
      <button type="button" aria-current={study.stage === 'learn' ? 'step' : undefined} onClick={() => changeStage('learn')}><span>1</span>単語と例文</button>
      <ChevronRight size={13} aria-hidden="true" />
      <button type="button" aria-current={study.stage === 'quiz' ? 'step' : undefined} onClick={() => { update({ stage: 'quiz', question: 0, questionOrder: undefined }); focusCard(); }}><span>2</span>使い方</button>
      <ChevronRight size={13} aria-hidden="true" />
      <button type="button" aria-current={study.stage === 'result' ? 'step' : undefined} disabled={!entry.questions.every(item => study.checked[item.id])} title="3問の答え合わせ後に確認できます" onClick={finish}><span>3</span>結果</button>
    </nav>
    <article className={styles.card} ref={card}>
      <div className={styles.wordHeading}>
        <div><p>{entry.level}を目安にしたオリジナル教材 · {wordIndex + 1} / {levelEntries.length}語</p><h2 ref={heading} tabIndex={-1} lang="en">{entry.word}</h2></div>
        <span>{entry.partOfSpeech}</span>
      </div>
      {study.stage === 'learn' && <>
        <p className={styles.ipa}><span lang="en">{entry.ipa}</span><small>{entry.ipaLabel}</small></p>
        <WordAudio key={entry.id} entry={entry} clip={availableAudio.find(clip => clip.wordId === entry.id)} example={study.example} stopKey={`${entry.id}-${study.stage}-${study.example}`} busy={!!busyWord} onPrepare={() => void prepare()} onRefresh={() => void refresh()} />
        {audioError && <p role="alert" className={styles.error}>{audioError}</p>}
        <div className={styles.definition}><p lang="en">{entry.definition}</p><p>{entry.meaning}</p></div>
        <section className={styles.example} aria-label={`例文 ${study.example + 1}`}>
          <div className={styles.exampleHeading}><span>例文 {study.example + 1} / {entry.examples.length}</span><strong>{example.context}</strong></div>
          <p lang="en" className={styles.exampleText}>{example.text}</p>
          <details className={styles.translation} key={example.id}><summary>日本語の意味を見る</summary><p>{example.translation}</p></details>
          <div className={styles.examplePager}>
            <button type="button" aria-label="前の例文" disabled={study.example === 0} onClick={() => update({ example: study.example - 1 })}><ChevronLeft size={19} /></button>
            <div aria-label={`${study.example + 1}番目の例文`}>{entry.examples.map((item, index) => <button type="button" key={item.id} aria-label={`例文${index + 1}`} aria-pressed={study.example === index} onClick={() => update({ example: index })}><span /></button>)}</div>
            <button type="button" aria-label="次の例文" disabled={study.example === entry.examples.length - 1} onClick={() => update({ example: study.example + 1 })}><ChevronRight size={19} /></button>
          </div>
        </section>
        <details className={styles.tip}><summary>使い方のポイント</summary><p>{entry.usageTip}</p></details>
      </>}
      {study.stage === 'quiz' && <section className={styles.quiz} aria-label="使い方の問題">
        <p className={styles.quizMeta}>{study.questionOrder ? 'もう一度確認' : questionLabels[question.type]}<span>{study.question + 1} / {questions.length}問</span></p>
        <h3>{question.prompt}</h3>
        <fieldset className={styles.choices} disabled={checked}>
          <legend>一番適切なものを1つ選んでください</legend>
          {question.choices.map((choice, index) => <label key={`${question.id}-${index}`} className={`${styles.choice} ${selected === index ? styles.selected : ''} ${checked && question.correctIndex === index ? styles.correctChoice : ''}`}>
            <input type="radio" name={`vocab-${question.id}`} value={index} checked={selected === index} onChange={() => update({ selected: { ...study.selected, [question.id]: index } })} />
            <span className={styles.choiceNumber}>{checked && question.correctIndex === index ? <Check size={15} aria-label="正解" /> : String.fromCharCode(65 + index)}</span><span lang="en">{choice}</span>
          </label>)}
        </fieldset>
        {checked && <div className={`${styles.feedback} ${selected !== question.correctIndex ? styles.incorrect : ''}`} role="status">
          <h4>{selected === question.correctIndex ? <><CheckCircle2 size={20} aria-hidden="true" />その使い方で合っています</> : <>正解は {String.fromCharCode(65 + question.correctIndex)}</>}</h4>
          <p>{question.explanation}</p>
          <button type="button" className={styles.textButton} onClick={() => changeStage('learn')}>例文でもう一度確かめる<ArrowRight size={15} aria-hidden="true" /></button>
        </div>}
      </section>}
      {study.stage === 'result' && <section className={styles.result}>
        <CheckCircle2 size={34} aria-hidden="true" />
        <h3>1語を、いろいろな角度から。</h3>
        <p className={styles.score}><strong>{correctCount}</strong> / {entry.questions.length}問 正解</p>
        {study.firstCorrect !== undefined && study.firstCorrect !== correctCount && <p className={styles.resultNote}>最初は {study.firstCorrect} / {entry.questions.length}問。例文を確認して解き直せました。</p>}
        <div className={styles.resultRows}>{entry.questions.map(item => <div key={item.id}><span>{questionLabels[item.type]}</span><strong>{study.selected[item.id] === item.correctIndex ? 'できた' : 'もう一度'}</strong></div>)}</div>
        {wrong.length > 0 ? <button type="button" className={styles.secondary} onClick={retry}><RotateCcw size={16} aria-hidden="true" />間違えた{wrong.length}問をもう一度</button> : <p className={styles.resultNote}>今日の確認はできました。少し時間を空けて、また試してみましょう。</p>}
        <button type="button" className={styles.textButton} onClick={() => changeStage('learn')}>発音と例文に戻る<ArrowRight size={15} aria-hidden="true" /></button>
      </section>}
    </article>
    <p className={styles.previewNote}>管理者だけが見られる試作です。学習者には未公開で、成績には記録しません。画面を閉じると、この見本の回答はリセットされます。</p>
    <footer className={styles.footer}>
      {study.stage === 'learn' && study.example === 0 && wordIndex === 0 ? <Link className={styles.previous} href="/admin/eiken-samples"><ArrowLeft size={17} aria-hidden="true" />サンプル一覧</Link> : <button type="button" className={styles.previous} onClick={previous}><ArrowLeft size={17} aria-hidden="true" />{previousLabel}</button>}
      {study.stage === 'result' && !nextWord ? <Link className={styles.primary} href="/admin/eiken-samples">サンプル一覧へ<ArrowRight size={18} aria-hidden="true" /></Link> : <button type="button" className={styles.primary} disabled={study.stage === 'quiz' && !checked && selected === undefined} onClick={next}>{nextLabel}<ArrowRight size={18} aria-hidden="true" /></button>}
      <p>{study.stage === 'learn' ? `例文 ${study.example + 1} / ${entry.examples.length} · 音声を聞いて、使う場面をつかもう` : study.stage === 'quiz' ? !checked && selected === undefined ? '答えを選ぶと、答え合わせに進めます' : `問題 ${study.question + 1} / ${questions.length} · ${checked ? '理由を確かめたら、次へ' : '選んだ答えを確認しましょう'}` : `${entry.word} の確認が完了しました`}</p>
    </footer>
  </main>;
}
