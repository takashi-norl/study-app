import { PlayCircle } from 'lucide-react';
import styles from './study-guide.module.css';

export function StudyGuide() {
  return <section className={`panel ${styles.guide}`} aria-labelledby="guide-title">
    <div className={styles.heading}><PlayCircle size={24} /><div><h2 id="guide-title">ひび学習の使い方</h2><p>科目を選んで、相談して、今日の10問へ。</p></div></div>
    <video controls playsInline preload="none" poster="/guide/quick-start-portrait.jpg" width="720" height="1280" aria-label="ひび学習の使い方を紹介する縦長動画">
      <source src="/guide/quick-start-portrait.mp4" type="video/mp4" />
      <track src="/guide/quick-start.vtt" kind="captions" srcLang="ja" label="日本語" />
      <a href="/guide/quick-start-portrait.mp4">使い方の動画を見る</a>
    </video>
    <p className={styles.libraryNote}>公開された問題集は「ライブラリ」から選び、「学習プランに追加」で始められます。管理者はテスト用で試してから公開できます。</p>
    <details><summary>文章で読む</summary><ol>
      <li>「学習相談」から、科目と目的を選びます。問題集の名前は入力不要です。</li>
      <li>教材なしでも作れます。ノートや教科書を使うときは、写真・PDFを保存して選びます。</li>
      <li>「あと1時間」「1か月」「身につくまで」など、期間とペース、難しさ、分量を選びます。</li>
      <li>「この内容で提案して」で案を見ます。希望はコメントで調整し、納得したら「この案で作る」。</li>
      <li>自分で作った自習問題は、すぐ練習できます。保護者が作る共有問題は、レビュー後に公開します。英語は音声ボタンから発音を聞けます。</li>
      <li>一度正解しても、日を空けて復習します。「学習の記録」で正答率・間違い・最後に解いた日時を確認できます。</li>
    </ol></details>
  </section>;
}
