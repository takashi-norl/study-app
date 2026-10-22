export interface AppRelease {
  version: string;
  date: string;
  title: string;
  announcement: string;
  changes: readonly { title: string; description: string }[];
}

// Newest first. This is the source for Settings, public history and update notices.
export const APP_RELEASES: readonly AppRelease[] = [{
  version: '0.2.1',
  date: '2026-10-23',
  title: 'iPhoneの画面に、きちんと収まるように',
  announcement: 'スマホで見出しやボタンが重ならないよう、画面を整えました。',
  changes: [
    { title: '通常サイズもMaxも、画面幅に合わせて', description: '長い見出しや問題集の名前を折り返し、操作ボタンと重ならない配置にしました。教材・学習相談・記録もスマホの幅に合わせて調整しました。' },
    { title: '入力するときも読みやすく', description: 'スマホの入力欄の文字を大きくして、入力時に画面が自動で拡大されにくくしました。指での拡大・縮小は引き続き使えます。' },
  ],
}, {
  version: '0.2.0',
  date: '2026-10-23',
  title: '選んで相談、自分に合う練習へ',
  announcement: '問題づくりが、選ぶだけで始められるようになりました。',
  changes: [
    { title: '名前を付けずに、問題づくり', description: '科目・目的・教材・難しさ・分量を選んでAIに相談できます。提案を見てから作り、コメントで調整できます。' },
    { title: '今の目標に合わせた相談', description: '試験まであと1時間、英検に向けて1か月、身につくまでの練習など、期間とペースを選べます。教材なしでも、保存した写真・PDFからでも始められます。' },
    { title: '管理者が試して、ライブラリへ', description: '管理者は学習者に表示されないテスト用の問題を作れます。気に入った内容をライブラリに公開すると、学習者が自分の学習プランに追加できます。' },
    { title: '英語を聞いて練習', description: '英語の問題文や選択肢を音声で確認できます。通常の速さとゆっくり再生を選べます。音声の種類は端末や設定によって異なります。' },
    { title: '使い方とアップロードを見やすく', description: '縦長の使い方動画と、iPhoneのホーム画面に追加する案内を用意しました。アップロード中は進み具合を表示し、回転表示をゆっくりにしました。' },
    { title: '更新内容をアプリで確認', description: '設定からバージョンと更新履歴を見られます。新しい版のお知らせは、閉じるボタンですぐ消せます。' },
  ],
}];

export const CURRENT_RELEASE = APP_RELEASES[0];

export function releaseDateLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}
