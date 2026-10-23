'use client';

import { Eye, ListChecks, ShieldCheck } from 'lucide-react';
import styles from './admin-workspace-guide.module.css';

export function AdminWorkspaceGuide({ onCreate, onReview, onLibrary, onPreview, onKobunCreate, onKobunReview }: {
  onCreate: () => void; onReview: () => void; onLibrary: () => void; onPreview: () => void;
  onKobunCreate: () => void; onKobunReview: () => void;
}) {
  return <section className={styles.guide} aria-label="管理者の作業とユーザーの表示範囲">
    <div className={styles.heading}><div><span><ShieldCheck size={16}/>管理者モード</span><h2>作った問題を、ユーザーに届けるまで</h2></div><button className="button secondary" onClick={onPreview}><Eye size={18}/>ユーザーとして見る</button></div>
    <div className={styles.kobunStart}><div><strong>古文の教材を、良い問題に。</strong><p>本文に沿った聞き方を選び、3問を見比べてから作成します。</p></div><div><button className="button primary" onClick={onKobunCreate}>教材から古文を作る</button><button className="button secondary" onClick={onKobunReview}><ListChecks size={16}/>作った古文を見直す</button></div></div>
    <ol className={styles.steps}>
      <li><button onClick={onCreate}><b>1</b><span><strong>写真から作る</strong><small>教材を選び、試作から本作成へ</small></span></button></li>
      <li><button onClick={onReview}><b>2</b><span><strong>一覧でレビュー</strong><small>全体の傾向・順番を見て修正</small></span></button></li>
      <li><button onClick={onLibrary}><b>3</b><span><strong>学習者に届ける</strong><small>本人用のセットをコピーして渡す</small></span></button></li>
      <li><button onClick={onPreview}><b>4</b><span><strong>ユーザー表示を確認</strong><small>見える問題集と解き方を試す</small></span></button></li>
    </ol>
    <p className={styles.note}><ListChecks size={16}/>レビュー後に学習者を選び、本人用のセットを届けられます。登録ユーザー全体への公開は、必要なときだけ行います。</p>
    <details><summary>誰に、どこまで見える？</summary><dl className={styles.scope}>
      <div><dt>管理者が作った非公開・テスト用の問題</dt><dd>管理者が確認できます。学習者には表示されません。</dd></div>
      <div><dt>学習者本人が作った問題</dt><dd>本人がすぐ練習できます。管理者は確認・編集でき、他の学習者には見えません。</dd></div>
      <div><dt>学習者に届けた問題セット</dt><dd>指定した本人の学習プランに入り、すぐ練習できます。他の学習者には見えません。</dd></div>
      <div><dt>パブリックに公開した問題集</dt><dd>登録ユーザーの一覧に表示されます。本人が「学習プランに追加」すると、毎日の練習に入ります。</dd></div>
      <div><dt>写真・PDF・相談履歴</dt><dd>本人と管理者が確認できます。公開した問題集には添付されません。</dd></div>
    </dl><p className={styles.note}>問題の一覧レビュー・編集・公開と、このプレビューモードは管理者用です。通常の解答画面では、答え合わせをするまで正解・解説を表示しません。</p></details>
  </section>;
}
