'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './beta-access.module.css';
type Invitations = { invitations: { id: string; email: string; name: string; expiresAt: string; status: string }[];
  members: { id: string; email: string; name: string; active: boolean }[] };
type Target = { kind: 'invitation' | 'member'; id: string; name: string };
const statuses: Record<string,string> = { available: '未使用', used: '登録済み', expired: '期限切れ', revoked: '取り消し済み' };
const date = (value: string) => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(new Date(value));
export default function BetaInvitations() {
  const [data, setData] = useState<Invitations>(), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [days, setDays] = useState(7), [link, setLink] = useState('');
  const [target, setTarget] = useState<Target>(), [copied, setCopied] = useState(false);
  const retry = useRef<{ key: string; id: string } | undefined>(undefined);
  const reload = useCallback(async () => {
    const response = await fetch('/api/admin/beta-invitations', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '招待を読み込めませんでした。');
    setData(body);
  }, []);
  useEffect(() => { void reload().catch(reason => setError(reason.message)); }, [reload]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError(''); setCopied(false);
    const key = JSON.stringify([email.trim().toLowerCase(), name.trim(), days]);
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
    try {
      const response = await fetch('/api/admin/beta-invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: retry.current.id, email, name, expiresInDays: days }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '招待を発行できませんでした。');
      setLink(new URL(body.path, window.location.origin).toString()); retry.current = undefined;
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '招待を発行できませんでした。'); }
    finally { setPending(false); }
  }
  async function revoke() {
    if (!target) return;
    setPending(true); setError('');
    try {
      const response = await fetch('/api/admin/beta-invitations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: target.kind, id: target.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '取り消しできませんでした。');
      setData(body); setTarget(undefined); setLink('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '取り消しできませんでした。'); }
    finally { setPending(false); }
  }
  return <main className={styles.page}>
    <a href="/admin" className={styles.back}>運営画面へ戻る</a><h1>テスト利用に招待</h1>
    <p className={styles.intro}>ログインに使うメールアドレスを指定して招待します。リンクは自分で友達に渡してください。教材や学習記録は、招待した人にも共有されません。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!data && !error && <p role="status">招待を読み込んでいます…</p>}
    {data && <>
      <section className={styles.panel}><h2>招待リンクを作る</h2>
        <form className={styles.form} onSubmit={event => void create(event)}>
          <label>友達のログイン用メールアドレス<input type="email" required maxLength={254} value={email} disabled={pending} onChange={event => { setEmail(event.target.value); setLink(''); }} autoComplete="off" /></label>
          <p className={styles.note}>Appleの「メールを非公開」を使う場合は、Appleがこのアプリに共有する非公開メールアドレスを指定します。既存GoogleアカウントとAppleの連携は、まだ利用できません。</p>
          <label>表示名<input required maxLength={80} value={name} disabled={pending} onChange={event => { setName(event.target.value); setLink(''); }} autoComplete="off" /></label>
          <label>リンクの有効期限<select value={days} disabled={pending} onChange={event => { setDays(Number(event.target.value)); setLink(''); }}><option value={1}>1日間</option><option value={7}>7日間</option><option value={14}>14日間</option></select></label>
          <button className="button primary" disabled={pending}>{pending ? '処理しています…' : '招待リンクを発行'}</button>
        </form>
        {link && <div><label className={styles.note}>このリンクを指定した友達に渡してください<input aria-label="招待リンク" className={styles.link} readOnly value={link} onFocus={event => event.target.select()} /></label>
          <button className="button secondary" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setError('リンクを選択してコピーしてください。')); }}>{copied ? 'コピーしました' : 'リンクをコピー'}</button>
          <p className={styles.note}>この画面を閉じるとリンクは表示できなくなります。メールの自動送信は行いません。</p></div>}
      </section>
      {target && <section className={styles.confirm} role="alert"><p>{target.name}の{target.kind === 'member' ? 'テスト利用を停止します。保存済みの教材は削除されません。' : '未使用の招待を取り消します。'}</p>
        <div className={styles.actions}><button className="button danger" disabled={pending} onClick={() => void revoke()}>確定する</button><button className="button secondary" disabled={pending} onClick={() => setTarget(undefined)}>戻る</button></div></section>}
      <section className={styles.panel}><h2>招待の状態</h2>{!data.invitations.length && <p className={styles.note}>まだ招待はありません。</p>}
        <ul className={styles.list}>{data.invitations.map(invitation => <li key={invitation.id}><div><strong>{invitation.name}</strong><small>{invitation.email}</small><small>{statuses[invitation.status]} · {date(invitation.expiresAt)}まで</small></div>
          {invitation.status === 'available' && <button className="button secondary" disabled={pending} onClick={() => setTarget({ kind: 'invitation', id: invitation.id, name: invitation.name })}>取り消す</button>}</li>)}</ul>
      </section>
      <section className={styles.panel}><h2>登録した人</h2><p className={styles.note}>利用状態だけを管理します。教材・問題・学習記録は表示しません。</p>
        {!data.members.length && <p className={styles.note}>まだ登録はありません。</p>}<ul className={styles.list}>{data.members.map(member => <li key={member.id}><div><strong>{member.name}</strong><small>{member.email}</small><small>{member.active ? '利用中' : '利用停止'}</small></div>
          {member.active && <button className="button secondary" disabled={pending} onClick={() => setTarget({ kind: 'member', id: member.id, name: member.name })}>利用を停止</button>}</li>)}</ul>
      </section>
    </>}
  </main>;
}
