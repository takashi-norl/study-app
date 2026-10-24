import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, ArrowRight, BookOpen, CircleDollarSign, FileCheck2, Headphones, LayoutDashboard, LockKeyhole, MessageSquare, ShieldCheck, Upload, UserPlus } from 'lucide-react';
import type { Profile } from '@/lib/types';
import { CURRENT_RELEASE } from '@/lib/releases';
import { appIdentity, isTestEnvironment } from '@/lib/app-identity';
import { AiUsagePanel } from './ai-usage';
import styles from '@/app/admin/page.module.css';

function ConsoleLink({ href, title, description, icon: Icon, label }: {
  href: string; title: string; description: string; icon: LucideIcon; label?: string;
}) {
  return <Link className={styles.actionCard} href={href}>
    <span className={styles.cardIcon}><Icon size={23} aria-hidden="true"/></span>
    <span className={styles.cardBody}>{label && <span className={styles.cardLabel}>{label}</span>}<strong>{title}</strong><span className={styles.cardDescription}>{description}</span></span>
    <ArrowRight size={18} className={styles.cardArrow} aria-hidden="true"/>
  </Link>;
}

/** Presentation only. The /admin server page authorizes the current operator before rendering. */
export function AdminConsole({ profile, operatorEmail, environment = 'local' }: { profile: Profile; operatorEmail?: string; environment?: 'production' | 'staging' | 'local' | 'misconfigured' }) {
  const identity = appIdentity(isTestEnvironment(environment));
  const environmentLabel = environment === 'misconfigured' ? '環境設定の確認が必要' : environment === 'staging' ? '検証用 TEST' : environment === 'production' ? '本番' : 'ローカル';
  return <div className={styles.console}>
    <a className={styles.skipLink} href="#admin-main">運営メニューへ移動</a>
    <header className={styles.topbar}>
      <div className={styles.topbarInner}>
        <div className={styles.brand}><span className={styles.brandMark}><ShieldCheck size={25} aria-hidden="true"/></span><div><p>{identity.name} · 運営Web</p><h1>Admin Console</h1></div></div>
        <Link className={styles.returnLink} href="/"><ArrowLeft size={17} aria-hidden="true"/>学習アプリへ戻る</Link>
      </div>
    </header>
    <div className={styles.layout}>
      <aside className={styles.sidebar} aria-label="運営アカウントと移動">
        <section className={styles.account} aria-label="ログイン中の運営アカウント">
          <span className={styles.accountLabel}>運営としてログイン中</span><strong>{profile.name}</strong>{operatorEmail && <span className={styles.email}>{operatorEmail}</span>}<span className={styles.permission}><ShieldCheck size={13} aria-hidden="true"/>Super User</span>
        </section>
        <nav className={styles.sectionNav} aria-label="Console内の移動">
          <a href="#operations"><LayoutDashboard size={17} aria-hidden="true"/>利用の運営</a>
          <a href="#materials"><BookOpen size={17} aria-hidden="true"/>教材の準備</a>
          <a href="#ai-usage"><CircleDollarSign size={17} aria-hidden="true"/>AI利用・概算料金</a>
        </nav>
        <p className={styles.sidebarNote}>自分の勉強は「学習アプリへ戻る」から。同じアカウントで学習できます。</p>
      </aside>
      <main id="admin-main" className={styles.main} tabIndex={-1}>
        <section className={styles.overview} aria-labelledby="overview-heading">
          <p className={styles.eyebrow}>運営ダッシュボード</p><h2 id="overview-heading">学ぶ人を支える、運営の入口。</h2><p>招待や感想の確認、共通教材の準備、AI利用の集計をここから。</p>
          <dl className={styles.statuses}>
            <div className={styles.environment} data-environment={environment}><dt>表示している環境</dt><dd>{environmentLabel}</dd></div>
            <div><dt>利用形態</dt><dd>招待制テスト</dd></div>
            <div><dt>利用者への課金</dt><dd>未開始</dd></div>
            <div><dt>このアプリのバージョン</dt><dd>v{CURRENT_RELEASE.version}</dd></div>
          </dl>
        </section>
        <section id="operations" className={styles.section} aria-labelledby="operations-heading">
          <div className={styles.sectionHeading}><span className={styles.sectionNumber}>01</span><div><h2 id="operations-heading">利用の運営</h2><p>参加の手続きと、利用者から届いた声を確認します。</p></div></div>
          <div className={styles.actionGrid}>
            <ConsoleLink href="/admin/invitations" icon={UserPlus} title="招待を管理する" description="招待リンクの作成・取り消し、テスト利用者の利用停止。"/>
            <ConsoleLink href="/admin/feedback" icon={MessageSquare} title="感想・不具合を見る" description="利用者が送信した内容を確認し、改善につなげます。"/>
          </div>
        </section>
        <section id="materials" className={styles.section} aria-labelledby="materials-heading">
          <div className={styles.sectionHeading}><span className={styles.sectionNumber}>02</span><div><h2 id="materials-heading">教材の準備</h2><p>アプリに用意する教材を確認し、音声を準備します。</p></div></div>
          <div className={styles.actionGrid}>
            <ConsoleLink href="/admin/vocabulary-samples" icon={BookOpen} label="共通教材" title="英単語・例文を確認" description="教材・選択問題・保存済み音声を確認し、対応する音声を準備。"/>
            <ConsoleLink href="/admin/eiken-samples" icon={Headphones} label="共通教材" title="英検問題・音声を確認" description="読む・聞く・書くの問題を確認し、必要な音声を準備。"/>
            <ConsoleLink href="/admin/vocabulary-import" icon={Upload} label="共通教材の音声" title="作成済み音声を取り込む" description="音声取込用ファイルを選び、内容と保存結果を確認。"/>
            <ConsoleLink href="/admin/question-set-import" icon={FileCheck2} label="自分の問題集" title="確認済み問題を取り込む" description="確認した問題セットを、ログイン中の自分の問題集に保存。"/>
          </div>
        </section>
        <section id="ai-usage" className={styles.section} aria-labelledby="usage-heading">
          <div className={styles.sectionHeading}><span className={styles.sectionNumber}>03</span><div><h2 id="usage-heading">AI利用・概算料金</h2><p>アプリ全体の利用記録を必要なときに読み込みます。</p></div></div>
          <AiUsagePanel profile={profile} demo={false}/>
        </section>
        <aside className={styles.privacy} aria-label="運営画面で扱う情報"><LockKeyhole size={21} aria-hidden="true"/><div><strong>個人の学習は、本人の画面で。</strong><p>このConsoleには、利用者の教材・問題・学習履歴・成績を閲覧する機能はありません。AI利用は個人別の明細を含まない全体集計です。</p></div></aside>
        <footer className={styles.footer}><span>{identity.name} · Admin Console</span><Link href="/billing">現在の料金・支払い案内<ArrowRight size={14} aria-hidden="true"/></Link></footer>
      </main>
    </div>
  </div>;
}
