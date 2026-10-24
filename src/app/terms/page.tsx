import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: '利用条件 | ひび学習',
  description: '本人の学習のためにひび学習を利用するときの条件。',
};

export default function TermsPage() {
  return <main className={styles.page}><div className={styles.content}>
    <Link href="/" className={styles.brand}>ひび学習</Link>
    <article className={styles.card}>
      <h1>利用条件</h1>
      <p className={styles.updated}>最終更新：2026年10月23日</p>
      <p>ひび学習は、自分のペースで学習と復習に取り組むための、招待制のテスト利用アプリです。</p>

      <h2>アカウントと教材</h2>
      <p>招待された自分のアカウントで、最初に登録したログイン方法を使ってください。招待リンクは指定されたアカウントだけが使えます。アップロードする教材は、アプリでの保存やAI処理を含め、利用する権限があるものを選んでください。学習に不要な個人情報は含めないでください。</p>

      <h2>問題の確認</h2>
      <p>AIによる文字の読取りや問題・解説には誤りが含まれることがあります。自分で作った問題は本人の自習で利用し、正答や解説を確認・編集できます。写真・PDFと、それを元に作った問題は本人の個人利用に限り、アプリ内での公開・共有・配布はできません。利用できる範囲は教材の権利や条件にも従ってください。疑問がある場合は、原本や学校の教材などでも確認してください。</p>

      <h2>学習記録と接続</h2>
      <p>本人の教材や学習記録の読み書きには、インターネット接続が必要です。通信に失敗したときは画面の案内を確認してください。サンプルモードの記録は、そのブラウザ内の体験用データです。</p>
      <p>Google、Apple、Vercel、Claude APIなどの設定や稼働状況により、利用できない機能が生じる場合があります。現在は月額料金の請求を行っていません。AI相談・作問には回数上限があり、運営側が処理費用を管理します。有料プランを始める場合は料金と条件を別途案内し、自動で課金を開始しません。学習計画は提案であり、将来の作問や学習を自動実行する予約ではありません。</p>

      <h2>相談・問い合わせ</h2>
      <p>教材の誤り、アカウントの変更、記録の削除などは、アプリ内の「感想・不具合を送る」から運営へお知らせください。情報の扱いはプライバシーポリシーをご確認ください。</p>
    </article>
    <nav className={styles.footer} aria-label="関連ページ"><Link href="/">ログイン画面へ</Link><Link href="/privacy">プライバシーポリシー</Link></nav>
  </div></main>;
}
