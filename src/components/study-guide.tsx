import { PlayCircle } from 'lucide-react';
import styles from './study-guide.module.css';

export function StudyGuide() {
  return <section className={`panel ${styles.guide}`} aria-labelledby="guide-title">
    <div className={styles.heading}><PlayCircle size={24} /><div><h2 id="guide-title">ひび学習の使い方</h2><p>まず3問で相談。形式が決まったら、必要な分だけ。</p></div></div>
    <details><summary>基本の操作を動画で見る（以前の画面）</summary><p>現在は、下の案内のようにサンプル3問を確認してから分量を決めます。</p><video controls playsInline preload="none" poster="/guide/quick-start-portrait.jpg" width="720" height="1280" aria-label="ひび学習の基本操作を紹介する縦長動画（以前の画面）">
      <source src="/guide/quick-start-portrait.mp4" type="video/mp4" />
      <track src="/guide/quick-start.vtt" kind="captions" srcLang="ja" label="日本語" />
      <a href="/guide/quick-start-portrait.mp4">使い方の動画を見る</a>
    </video></details>
    <p className={styles.libraryNote}>自分で作った問題は「ライブラリ」の「プライベート」ですぐ練習できます。「パブリック」からは、登録ユーザー向けに公開された問題集を自分の学習に追加できます。</p>
    <details><summary>文章で読む</summary><ol>
      <li>画面下の「問題を作る」から、科目と目的を選びます。問題集の名前は入力不要です。</li>
      <li>教材なしでも作れます。ノートや教科書を使うときは、写真・PDFを保存して選びます。</li>
      <li>「あと1時間」「1か月」「身につくまで」など、期間とペース、難しさを選びます。総問題数はまだ決めなくて大丈夫です。</li>
      <li>AIが作ったサンプル3問を見ます。「現代語訳を隠して」「穴埋め中心に」などとコメントして、聞き方や難しさを調整できます。</li>
      <li>形式がよければ分量へ進み、総問題数、または日数と1日の問題数を選びます。最後に作成ボタンを押すと、その形式で新しい問題を作ります。サンプル3問は総数に含みません。</li>
      <li>保存された問題はプライベートライブラリですぐ練習できます。1問ずつ承認する必要はありません。気になる内容は必要に応じて管理者が編集できます。英語は音声ボタンから発音を聞けます。</li>
      <li>共有したいときは、問題集単位で公開を依頼します。Manager・Super Userはパブリックライブラリに公開できます。元の写真や相談履歴は公開版に添付しません。</li>
      <li>すでにある問題も「AIと相談してアレンジ」から試作できます。元の問題と学習記録は残り、別の問題集を作るための相談になります。</li>
      <li>一度正解しても、日を空けて復習します。「学習の記録」で正答率・間違い・最後に解いた日時を確認できます。</li>
    </ol></details>
  </section>;
}
