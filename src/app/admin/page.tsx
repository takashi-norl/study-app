import Link from 'next/link';
import { ArrowLeft, ArrowRight, MessageSquare, ShieldCheck, TrendingUp, UserPlus } from 'lucide-react';
import { AiUsagePanel } from '@/components/ai-usage';
import { requireSuperUser } from '@/server/auth';
import { ApiError } from '@/server/config';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function OperationsPage() {
  let profile;
  try { ({ profile } = await requireSuperUser()); }
  catch (error) {
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) throw error;
    const login = error.status === 401;
    return <main className={styles.page}><section className={styles.intro}><ShieldCheck size={30}/><h1>運営用Web画面</h1><p>{login ? '運営用アカウントでログインしてください。' : 'この画面は運営者だけが利用できます。'}</p><Link className="button primary" href={login ? '/api/auth/signin?callbackUrl=%2Fadmin' : '/'}>{login ? 'Googleでログイン' : '学習画面へ戻る'}</Link></section></main>;
  }
  return <main className={styles.page}>
    <Link className={styles.back} href="/"><ArrowLeft size={16}/>自分の学習へ戻る</Link>
    <header className={styles.intro}><ShieldCheck size={30}/><p className={styles.eyebrow}>運営専用</p><h1>ベータ版の運営</h1><p>招待、届いた感想、AIの利用状況を確認できます。</p><p className={styles.note}>利用者の教材・問題・学習成績を閲覧する画面はありません。</p></header>
    <nav className={styles.links} aria-label="運営メニュー">
      <Link href="/admin/invitations"><UserPlus size={25}/><span><strong>テスト利用に招待</strong><small>招待リンクの作成と利用状態の確認</small></span><ArrowRight size={18}/></Link>
      <Link href="/admin/feedback"><MessageSquare size={25}/><span><strong>届いた感想・不具合</strong><small>利用者が送ってくれた内容を確認</small></span><ArrowRight size={18}/></Link>
      <a href="#ai-usage"><TrendingUp size={25}/><span><strong>AIの利用状況</strong><small>アプリ全体の利用量と概算料金を確認</small></span><ArrowRight size={18}/></a>
    </nav>
    <div id="ai-usage" className={styles.usage}><AiUsagePanel profile={profile} demo={false}/></div>
  </main>;
}
