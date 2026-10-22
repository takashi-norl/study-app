'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleHelp, LoaderCircle, MessageCircle, PencilLine, Send, Sparkles, X } from 'lucide-react';
import { defaultPersonalPreferences, personalizedStudyMessage, type PersonalPreferences } from '@/lib/personal-profile';
import { usePersonalProfile } from './personal-profile-context';
import styles from './personal-profile.module.css';

export { PersonalProfileProvider, usePersonalProfile } from './personal-profile-context';

export function PersonalEncouragement({ fallback, occasion, answeredToday }: { fallback: string; occasion?: 'home' | 'complete' | 'sidebar'; answeredToday?: number }) {
  const { state } = usePersonalProfile();
  return <>{personalizedStudyMessage(state.profile, { fallback, todayAnswers: occasion === 'complete' ? Math.max(10, answeredToday ?? 0) : answeredToday })}</>;
}

export function PersonalProfilePrompt({ onOpen }: { onOpen(): void }) {
  const { identity, demo, state, loading } = usePersonalProfile();
  const [dismissed, setDismissed] = useState(true);
  const key = `hibi-profile-prompt-v1:${demo ? 'demo' : 'live'}:${encodeURIComponent(identity.id)}`;
  useEffect(() => { try { setDismissed(localStorage.getItem(key) === 'dismissed'); } catch { setDismissed(false); } }, [key]);
  if (loading || state.profile || dismissed) return null;
  return <aside className={styles.prompt} aria-label="学び方プロフィールのご案内">
    <Sparkles size={20} aria-hidden="true" />
    <div><strong>あなたに合う、ひとことを。</strong><p>目標や好きなことを話して、学び方と声のかけ方を自分らしく。</p></div>
    <button className={styles.textButton} onClick={onOpen}>プロフィールをつくる<ArrowRight size={16} /></button>
    <button className={styles.dismiss} aria-label="プロフィールの案内を閉じる" onClick={() => { setDismissed(true); try { localStorage.setItem(key, 'dismissed'); } catch { /* Dismiss for this visit. */ } }}><X size={18} /></button>
  </aside>;
}

const starterMessages = [
  { title: '目標から話す', message: '今の目標を整理したい。まず何から話すといい？' },
  { title: '好きなことから', message: '好きなことや興味があることを、学習に結びつけたい。' },
  { title: '声のかけ方を相談', message: '自分に合う声のかけ方を一緒に考えたい。どんな選び方がある？' },
];
const tones = [
  { value: 'gentle', label: 'おだやかに', description: '自分のペースを大切に' },
  { value: 'direct', label: '端的に', description: 'やることが分かる言葉で' },
  { value: 'energetic', label: '明るく', description: '前向きなひと押しを' },
] as const;
function preferencesOf(value: PersonalPreferences | null): PersonalPreferences {
  const source = value ?? defaultPersonalPreferences();
  return { nickname: source.nickname, schoolYear: source.schoolYear, goals: source.goals, interests: source.interests,
    encouragementStyle: source.encouragementStyle, dailyMinutes: source.dailyMinutes, enabled: source.enabled,
    personalizedMessages: [...source.personalizedMessages] };
}

export function PersonalProfilePanel() {
  const { identity, demo, state, loading, busy, error, refresh, sendMessage, savePreferences } = usePersonalProfile();
  const [mode, setMode] = useState<'closed' | 'chat' | 'manual'>('closed');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<PersonalPreferences>(defaultPersonalPreferences);
  const [messageLines, setMessageLines] = useState('');
  const [dirty, setDirty] = useState(false);
  const [draftFromAI, setDraftFromAI] = useState(false);
  const [manuallyEdited, setManuallyEdited] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [chatNotice, setChatNotice] = useState('');
  const [validation, setValidation] = useState('');
  const pendingTurn = state.turns.some(turn => turn.status === 'pending');
  const disabled = loading || !!busy || pendingTurn;

  useEffect(() => {
    if (!dirty) {
      const next = preferencesOf(state.profile);
      setDraft(next);
      setMessageLines(next.personalizedMessages.join('\n'));
    }
  }, [state.profile, dirty]);

  function edit<K extends keyof PersonalPreferences>(field: K, value: PersonalPreferences[K]) {
    setDraft(current => ({ ...current, [field]: value }));
    setDirty(true);
    setManuallyEdited(true);
    setSavedNotice(false);
    setValidation('');
  }
  function open(next: 'chat' | 'manual') {
    setMode(next);
    setSavedNotice(false);
    if (!state.profile && !dirty) { setDraft(value => ({ ...value, enabled: true })); setDirty(true); }
  }
  function applyDraft(next: PersonalPreferences) {
    setDraft(preferencesOf(next));
    setMessageLines(next.personalizedMessages.join('\n'));
    setDirty(true);
    setDraftFromAI(true);
    setManuallyEdited(false);
    setSavedNotice(false);
    setValidation('');
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || disabled || !state.aiEnabled) return;
    setChatNotice('');
    const turn = await sendMessage(message.trim());
    if (turn?.status === 'complete') {
      setMessage('');
      if (turn.draft) {
        // Keep hand-edited preferences; the user can explicitly replace them with the new suggestion.
        if (!manuallyEdited) { applyDraft(turn.draft); }
        else setChatNotice('新しいプロフィール案が届きました。「この案を編集する」で下の内容に反映できます。');
      }
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const messages = messageLines.split('\n').map(line => line.trim()).filter(Boolean);
    if (messages.length > 6 || messages.some(line => line.length > 100)) { setValidation('ひとことは6つまで、1つ100文字以内で入力してください。'); return; }
    if (!Number.isInteger(draft.dailyMinutes) || draft.dailyMinutes < 1 || draft.dailyMinutes > 120) { setValidation('1回の目安は1〜120分で入力してください。'); return; }
    setValidation('');
    if (await savePreferences({ ...draft, personalizedMessages: messages })) {
      setDirty(false);
      setDraftFromAI(false);
      setManuallyEdited(false);
      setSavedNotice(true);
    }
  }
  const latestDraft = [...state.turns].reverse().find(turn => turn.status === 'complete' && turn.draft);
  const preview = state.profile ? personalizedStudyMessage(state.profile) : '';
  return <section className={styles.card} aria-labelledby="personal-profile-title">
    <div className={styles.heading}><span className={styles.icon}><Sparkles size={21} /></span><div>
      <h2 id="personal-profile-title">学び方プロフィール {demo && <span className={styles.badge}>デモ体験</span>}</h2>
      <p>目標や好きなこと、うれしい声のかけ方。少し話して、あなたに合う学び方へ。</p>
    </div></div>
    {state.profile && <div className={styles.saved}>
      <p><strong>{state.profile.nickname || identity.name || 'あなた'}のプロフィール</strong>{state.profile.schoolYear && ` · ${state.profile.schoolYear}`}</p>
      {state.profile.goals && <p>{state.profile.goals}</p>}
      {state.profile.enabled ? <p className={styles.quote}>「{preview}」</p> : <p>ひとことのパーソナライズはオフです。</p>}
      <small>プロフィールとこの会話は、自分のアカウントだけで見られます。</small>
    </div>}
    <div className={styles.actions}>
      <button className={styles.button} type="button" onClick={() => open('chat')} disabled={loading}><MessageCircle size={17} />AIと話してつくる</button>
      <button className={styles.secondary} type="button" onClick={() => open('manual')} disabled={loading}><PencilLine size={16} />自分で入力・編集</button>
      {mode !== 'closed' && <button type="button" className={styles.textButton} onClick={() => setMode('closed')}>いったん閉じる</button>}
    </div>
    <p className={styles.caption}>登録は任意です。書きたくないことは空欄で大丈夫。内容はいつでも変更できます。</p>
    {loading && <p className={styles.waiting} role="status"><LoaderCircle size={17} className={styles.spin} />プロフィールを読み込んでいます</p>}
    {error && <div className={styles.error} role="alert"><CircleHelp size={17} /><div>{error}<br /><button type="button" className={styles.textButton} onClick={() => void refresh()} disabled={!!busy}>保存状況を確認</button></div></div>}
    {mode !== 'closed' && <div className={styles.workspace}>
      {mode === 'chat' && <>
        <h3 className={styles.sectionTitle}>どんなふうに、取り組みたい？</h3>
        <p className={styles.intro}>目標を決めるところからでも、好きなことの話からでも。話題を選ぶと、入力欄に入ります。</p>
        {demo && <p className={styles.caption}>デモでは返信例を表示します。AIへの送信は行いません。</p>}
        {!loading && !state.aiEnabled && <p className={styles.waiting}>AIへの接続は準備中です。下のプロフィールは自分で入力できます。</p>}
        <div className={styles.starters}>{starterMessages.map(item => <button key={item.title} type="button" className={styles.starter} disabled={disabled || !state.aiEnabled} onClick={() => { setMessage(item.message); setChatNotice(''); }}>{item.title}<ArrowRight size={14} /></button>)}</div>
        {!!state.turns.length && <div className={styles.conversation} aria-label="プロフィールの会話">{state.turns.map(turn => <div className={styles.turn} key={turn.id}>
          <div className={`${styles.message} ${styles.userMessage}`}><strong>あなた</strong>{turn.message}</div>
          {turn.reply && <div className={`${styles.message} ${styles.aiMessage}`}><strong>{demo ? 'デモの返信例' : 'ひび学習 AI'}</strong>{turn.reply}</div>}
          {turn.status === 'failed' && <p className={styles.error} role="status">{turn.error || '返信を作れませんでした。プロフィールは自分で入力・保存できます。'}</p>}
          {turn.status === 'pending' && <p className={styles.waiting} role="status"><LoaderCircle size={17} className={styles.spin} /><span>相談への返信を準備しています。<button className={styles.textButton} disabled={!!busy} onClick={() => void refresh()}>返信を確認</button></span></p>}
        </div>)}</div>}
        {busy === 'chat' && !pendingTurn && <p className={styles.waiting} role="status"><LoaderCircle size={17} className={styles.spin} />話してくれたことをもとに、考えています</p>}
        <form className={styles.chatForm} onSubmit={event => void send(event)}>
          <label className={styles.field}>相談したいこと<textarea rows={3} value={message} maxLength={1500} placeholder="例：英検準1級の語彙を増やしたい。毎日10分くらい、声かけは短くていい。" onChange={event => setMessage(event.target.value)} disabled={!!busy} /></label>
          <div className={styles.chatActions}><small>送った内容から、AIが編集できる案をつくります。</small><button type="submit" className={styles.button} disabled={disabled || !state.aiEnabled || !message.trim()}><Send size={16} />送信</button></div>
        </form>
        {chatNotice && <p className={styles.status} role="status">{chatNotice}</p>}
        {latestDraft?.draft && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => applyDraft(latestDraft.draft!)}><PencilLine size={16} />この案を編集する</button></div>}
      </>}
      <form className={styles.editor} onSubmit={event => void save(event)}>
        <div><h3 className={styles.sectionTitle}>{draftFromAI ? 'プロフィール案' : 'あなたのプロフィール'}</h3><p className={styles.caption}>合っているところだけ残して、自由に直してください。「保存する」でひとことに反映します。</p></div>
        <div className={styles.grid}>
          <label className={styles.field}>呼んでほしい名前<input value={draft.nickname} maxLength={40} placeholder={identity.name || 'ニックネーム'} onChange={event => edit('nickname', event.target.value)} autoComplete="nickname" disabled={!!busy} /></label>
          <label className={styles.field}>学校・学年など <small>任意</small><input value={draft.schoolYear} maxLength={80} placeholder="例：高校1年生" onChange={event => edit('schoolYear', event.target.value)} disabled={!!busy} /></label>
        </div>
        <label className={styles.field}>目標・取り組みたいこと<textarea rows={3} value={draft.goals} maxLength={400} placeholder="例：英検準1級の語彙を1か月で増やしたい" onChange={event => edit('goals', event.target.value)} disabled={!!busy} /></label>
        <label className={styles.field}>好きなこと・興味があること<textarea rows={2} value={draft.interests} maxLength={240} placeholder="例：サッカー、映画、海外の大学生活" onChange={event => edit('interests', event.target.value)} disabled={!!busy} /></label>
        <fieldset className={styles.tones} disabled={!!busy}><legend>しっくりくる声のかけ方</legend><div className={styles.toneOptions}>{tones.map(tone => <label className={styles.tone} key={tone.value}><input type="radio" name="personal-encouragement" value={tone.value} checked={draft.encouragementStyle === tone.value} onChange={() => edit('encouragementStyle', tone.value)} /><span><strong>{tone.label}</strong><small>{tone.description}</small></span></label>)}</div></fieldset>
        <label className={styles.field}>1回に取り組む時間の目安（分）<input type="number" min={1} max={120} inputMode="numeric" value={Number.isNaN(draft.dailyMinutes) ? '' : draft.dailyMinutes} onChange={event => edit('dailyMinutes', event.target.value === '' ? NaN : Number(event.target.value))} disabled={!!busy} /><small>目安なので、途中までの日があっても大丈夫です。</small></label>
        <label className={styles.field}>ホームに表示するひとこと<textarea rows={3} value={messageLines} maxLength={605} placeholder="例：今日の10問が、明日の自信に。" onChange={event => { setMessageLines(event.target.value); setDirty(true); setManuallyEdited(true); setSavedNotice(false); setValidation(''); }} disabled={!!busy} /><small>1行に1つ、6つまで。空欄なら声のかけ方に合うひとことを使います。</small></label>
        <label className={styles.toggle}><input type="checkbox" checked={draft.enabled} onChange={event => edit('enabled', event.target.checked)} disabled={!!busy} /><span>ひとことを自分向けにする<small>保存した内容に合わせて、ホームの言葉が日ごとに変わります。</small></span></label>
        {validation && <p className={styles.error} role="alert">{validation}</p>}
        <div className={styles.actions}><button type="submit" className={styles.button} disabled={loading || !!busy}>{busy === 'save' ? <LoaderCircle className={styles.spin} size={17} /> : <Check size={17} />}{busy === 'save' ? '保存しています' : 'プロフィールを保存する'}</button></div>
      </form>
      {savedNotice && <p className={styles.status} role="status"><Check size={17} />保存しました。{draft.enabled ? 'ホームのひとことに反映しました。' : 'ひとことのパーソナライズをオフにしました。'}</p>}
    </div>}
  </section>;
}
