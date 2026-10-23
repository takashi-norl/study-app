import { PlayCircle } from 'lucide-react';
import styles from './study-guide.module.css';

export function StudyGuide() {
  return <section className={`panel ${styles.guide}`} aria-labelledby="guide-title">
    <div className={styles.heading}><PlayCircle size={24}/><div><h2 id="guide-title">ひび学習の使い方</h2><p>用意された教材でも、自分の写真・PDFでも。</p></div></div>
    <p className={styles.libraryNote}>「用意された教材」では英語を学べます。自分で作った問題は「自分の問題・教材」に保存され、そのまま練習・編集できます。ほかの利用者への公開・配布はありません。</p>
    <details open><summary>自分の問題を作って練習する</summary><ol>
      <li>「問題を作る」で科目・目的を選び、必要なら写真・PDFを追加します。教材なしの相談でも始められます。</li>
      <li>期間・ペース・難しさを選び、「この内容で3問を試作」を押します。選んだ教材と希望をAIへ送ります。教材を保存しただけではAIへ送りません。</li>
      <li>試作3問を並べて確認し、聞き方や難しさを相談で調整します。形式がよければ、まとめて作る問題数を決めます。</li>
      <li>「問題の確認・編集」で全体の並びと原本を見比べます。正解や解説は自分で直せます。確認済みにしなくても、保存された問題から練習できます。</li>
      <li>答えを選ぶと正解・解説が表示されます。開始前の「答え合わせボタンを使う」をオンにすると、選び直してから答え合わせできます。</li>
      <li>「学習プラン」では中間テストなどのプロジェクトにまとめられます。「学習の記録」で進み具合や間違えた問題を確認し、日を空けて復習します。</li>
    </ol></details>
    <details><summary>教材と問題の扱い</summary><p>写真・PDFは自分の学習に利用できるものを選んでください。作問時にはAIサービスへ送りますが、アプリのほかの利用者には公開されません。</p><p>すでにある自分の問題は「AIと相談してアレンジ」から別の問題集を作れます。元の問題と学習記録は残ります。</p></details>
  </section>;
}
