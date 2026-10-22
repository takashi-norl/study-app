import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: '利用条件 | ひび学習',
  description: '家族でひび学習を利用するときの条件と注意点。',
};

export default function TermsPage() {
  return <main className={styles.page}><div className={styles.content}>
    <Link href="/" className={styles.brand}>ひび学習</Link>
    <article className={styles.card}>
      <h1>利用条件</h1>
      <p className={styles.updated}>最終更新：2026年10月22日</p>
      <p>ひび学習は、管理者が登録した家族だけで利用する学習アプリです。保護者が教材や問題を管理し、生徒の練習を見守ります。</p>

      <h2>アカウントと教材</h2>
      <p>各自の登録済みGoogleアカウントでログインしてください。アップロードする教材は、アプリでの保存やAI処理を含め、利用する権限があるものを選んでください。学習に不要な個人情報は含めないでください。</p>

      <h2>問題の確認</h2>
      <p>AIによる文字の読取りや問題・解説には誤りが含まれることがあります。保護者が原本と照らし合わせて確認・修正し、承認した問題を公開してください。疑問がある場合は、原本や学校の教材などでも確認してください。</p>

      <h2>学習記録と接続</h2>
      <p>家族共通の教材や学習記録の読み書きには、インターネット接続が必要です。通信に失敗したときは画面の案内を確認してください。サンプルモードの記録は、そのブラウザ内の体験用データです。</p>
      <p>Google、Vercel、Claude APIなどの設定や稼働状況により、利用できない機能が生じる場合があります。AI作問は管理者が有効にした場合に利用でき、APIの利用料金は管理者が管理します。</p>

      <h2>相談・問い合わせ</h2>
      <p>教材の誤り、アカウントの変更、記録の削除などは、このアプリを設定した保護者（管理者）へ直接お知らせください。情報の扱いはプライバシーポリシーをご確認ください。</p>
    </article>
    <nav className={styles.footer} aria-label="関連ページ"><Link href="/">ログイン画面へ</Link><Link href="/privacy">プライバシーポリシー</Link></nav>
  </div></main>;
}
