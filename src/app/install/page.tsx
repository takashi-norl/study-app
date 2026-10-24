import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen, Check, Share, Smartphone, Sprout } from 'lucide-react';
import { appIdentity, isTestEnvironment } from '@/lib/app-identity';
import { getAppEnvironment } from '@/server/environment';
import { CopyAppLink } from './copy-link';
import styles from './install.module.css';

export function generateMetadata(): Metadata {
  const { name } = appIdentity(isTestEnvironment(getAppEnvironment()));
  return { title: { absolute: `iPhoneに追加する | ${name}` },
    description: `${name}をiPhoneのホーム画面に追加し、Googleアカウントで使い始める手順。` };
}

export default function InstallPage() {
  const { name, staging } = appIdentity(isTestEnvironment(getAppEnvironment()));
  const openLabel = staging ? 'サンプルで試す' : `${name}を開く`;
  const appPath = staging ? '/?demo=1' : '/';
  return <main className={styles.page}><div className={styles.content}>
    <Link href="/" className={styles.brand}><span><Sprout size={25} /></span>{name}</Link>
    <header className={styles.hero}>
      <p className={styles.eyebrow}>{staging ? 'TEST環境をホーム画面へ' : 'いつものホーム画面から'}</p>
      <h1>{staging ? <>検証用アプリを、<br />ホーム画面に。</> : <>今日の10問を、<br />すぐそばに。</>}</h1>
      <p>{staging ? <>オレンジ色の「TEST」アイコンで、<br />本番とは別に追加します。</> : <>iPhoneにアイコンを追加して、<br />自分のGoogleアカウントで始めましょう。</>}</p>
      <Link href={appPath} className={styles.primary}>{openLabel}<ArrowRight size={19} /></Link>
      <small>{staging ? 'サンプルは端末内で試せます。クラウド利用には検証用の接続設定が必要です。' : '追加する前でも、ブラウザで利用できます。'}</small>
    </header>

    <section className={styles.guide} aria-labelledby="iphone-title">
      <div className={styles.heading}><Smartphone size={22} /><h2 id="iphone-title">iPhoneへの追加方法</h2></div>
      <ol className={styles.steps}>
        <li><span className={styles.number}>1</span><div><h3>Safariで「{name}」を開く</h3><p>上の「{openLabel}」を押します。Gmailなどのアプリ内で開いた場合は、下のリンクをコピーしてSafariのアドレス欄に貼り付けてください。</p><CopyAppLink /></div></li>
        <li><span className={styles.number}>2</span><div><h3><Share size={20} aria-hidden="true" />共有ボタンを押す</h3><p>四角から上向きの矢印が出たボタンです。画面によっては、ページメニューを開いてから「共有」を選びます。</p></div></li>
        <li><span className={styles.number}>3</span><div><h3>「ホーム画面に追加」を選ぶ</h3><p>共有メニューを下にスクロールして選び、「追加」を押します。「ウェブアプリとして開く」が表示されたら、オンにしてください。</p></div></li>
        <li><span className={styles.number}><Check size={16} /></span><div><h3>{staging ? 'TESTのアイコンから試す' : '追加したアイコンからログイン'}</h3><p>{staging ? <>ホーム画面の「{name}」を開き、サンプルから試してください。Googleログインは、検証用の接続が用意された場合に利用できます。</> : <>ホーム画面の「{name}」を開き、「Googleアカウントでログイン」を押して、ご自身の登録済みアカウントを選びます。</>}</p></div></li>
      </ol>
      <details className={styles.help}><summary>「ホーム画面に追加」が見つからないとき</summary><p>Safariで開いていることを確認してください。共有メニューの下にある「アクションを編集」から「ホーム画面に追加」を表示できる場合もあります。</p><a href="https://support.apple.com/ja-jp/guide/iphone/iphea86e5236/27/ios/27" target="_blank" rel="noreferrer">Appleの手順を確認する ↗</a></details>
    </section>

    <section className={styles.start} aria-labelledby="first-title"><div className={styles.heading}><BookOpen size={21} /><h2 id="first-title">{staging ? '検証環境で試すこと' : 'ログインしたら'}</h2></div><div className={styles.roles}>
      <article><h3>学習する人</h3><p>「用意された教材」から学ぶか、自分の問題集で練習。1回10問を目安に、自分のペースで進められます。</p></article>
      <article><h3>自分の教材で作る</h3><p>写真・PDFを追加して、まず3問を試作。問題を確認してから本作成へ。教材と問題は本人の個人利用だけで、共有・公開はできません。</p></article>
    </div><p className={styles.accountNote}>{staging ? 'ここは検証用です。サンプルの操作は端末内だけで、本番の学習記録にはなりません。保存やAI作問などのクラウド機能は、検証用の接続が用意された場合に利用できます。' : '招待された自分のGoogleアカウントで利用できます。教材や成績は本人だけが確認できます。'}</p><Link href={appPath} className={styles.secondary}>{staging ? 'サンプルを開く' : 'アプリを開いてログイン'}<ArrowRight size={17} /></Link></section>
    <footer className={styles.footer}><span>ひとつずつ、自分の力に。</span><nav aria-label="アプリについて"><Link href="/privacy">プライバシー</Link><Link href="/terms">利用条件</Link></nav></footer>
  </div></main>;
}
