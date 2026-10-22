import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen, Check, Share, Smartphone, Sprout } from 'lucide-react';
import { CopyAppLink } from './copy-link';
import styles from './install.module.css';

export const metadata: Metadata = {
  title: 'iPhoneに追加する | ひび学習',
  description: 'ひび学習をiPhoneのホーム画面に追加し、Googleアカウントで使い始める手順。',
};

const appUrl = 'https://study-app-opal-eight.vercel.app/';

export default function InstallPage() {
  return <main className={styles.page}><div className={styles.content}>
    <Link href="/" className={styles.brand}><span><Sprout size={25} /></span>ひび学習</Link>
    <header className={styles.hero}>
      <p className={styles.eyebrow}>いつものホーム画面から</p>
      <h1>今日の10問を、<br />すぐそばに。</h1>
      <p>iPhoneにアイコンを追加して、<br />自分のGoogleアカウントで始めましょう。</p>
      <Link href="/" className={styles.primary}>ひび学習を開く<ArrowRight size={19} /></Link>
      <small>追加する前でも、ブラウザで利用できます。</small>
    </header>

    <section className={styles.guide} aria-labelledby="iphone-title">
      <div className={styles.heading}><Smartphone size={22} /><h2 id="iphone-title">iPhoneへの追加方法</h2></div>
      <ol className={styles.steps}>
        <li><span className={styles.number}>1</span><div><h3>Safariで「ひび学習」を開く</h3><p>上の「ひび学習を開く」を押します。Gmailなどのアプリ内で開いた場合は、下のリンクをコピーしてSafariのアドレス欄に貼り付けてください。</p><CopyAppLink url={appUrl} /></div></li>
        <li><span className={styles.number}>2</span><div><h3><Share size={20} aria-hidden="true" />共有ボタンを押す</h3><p>四角から上向きの矢印が出たボタンです。画面によっては、ページメニューを開いてから「共有」を選びます。</p></div></li>
        <li><span className={styles.number}>3</span><div><h3>「ホーム画面に追加」を選ぶ</h3><p>共有メニューを下にスクロールして選び、「追加」を押します。「ウェブアプリとして開く」が表示されたら、オンにしてください。</p></div></li>
        <li><span className={styles.number}><Check size={16} /></span><div><h3>追加したアイコンからログイン</h3><p>ホーム画面の「ひび学習」を開き、「Googleアカウントでログイン」を押して、ご自身の登録済みアカウントを選びます。</p></div></li>
      </ol>
      <details className={styles.help}><summary>「ホーム画面に追加」が見つからないとき</summary><p>Safariで開いていることを確認してください。共有メニューの下にある「アクションを編集」から「ホーム画面に追加」を表示できる場合もあります。</p><a href="https://support.apple.com/ja-jp/guide/iphone/iphea86e5236/27/ios/27" target="_blank" rel="noreferrer">Appleの手順を確認する ↗</a></details>
    </section>

    <section className={styles.start} aria-labelledby="first-title"><div className={styles.heading}><BookOpen size={21} /><h2 id="first-title">ログインしたら</h2></div><div className={styles.roles}>
      <article><h3>学習する人</h3><p>ライブラリから気になる問題を自分の学習に追加。学習相談では、試験や目標に合わせて問題を作れます。</p></article>
      <article><h3>管理する人</h3><p>教材の写真を保存し、問題を作成・確認。テスト用の問題を試してからライブラリへ公開できます。</p></article>
    </div><p className={styles.familyNote}>使うアプリは全員同じです。Googleアカウントに応じた画面が開きます。</p><Link href="/" className={styles.secondary}>アプリを開いてログイン<ArrowRight size={17} /></Link></section>
    <footer className={styles.footer}><span>ひとつずつ、自分の力に。</span><nav aria-label="アプリについて"><Link href="/privacy">プライバシー</Link><Link href="/terms">利用条件</Link></nav></footer>
  </div></main>;
}
