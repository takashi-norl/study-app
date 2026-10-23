# Production / Staging 導入案

作成日: 2026-10-23。これは設計案です。Vercel・Googleの設定や本番データは、この計画に合わせてまだ変更していません。

## 推奨構成

同じGitHubリポジトリを使い、同じVercelチーム内に2つのプロジェクトを置きます。コードは共有し、公開先・認証・保存先・バックグラウンド処理を分けます。現在のアプリはGoogle DriveとGoogle Sheetsのイベントログに保存する構成なので、表示上の「管理者用テスト」だけでは環境分離になりません。

| | Production | Staging |
|---|---|---|
| 用途 | Yuseiと家族が日々使う | 変更・不具合修正を試す |
| Vercelプロジェクト | 現在のstudy-app | study-app-staging（候補名） |
| 固定URL | 現在のstudy-app-opal-eight.vercel.appを維持 | 新規プロジェクトの固定URL、作成後に確定 |
| Gitブランチ | main | staging |
| Google Drive | 既存の本番フォルダ | 検証専用フォルダ |
| Google Sheets | 既存の本番記録シート | 検証専用シート |
| Googleログイン | 現在の家族アカウント | まずTakashi、必要に応じてManagerとテスト利用者 |
| 有料AI・音声 | 現行の利用制限 | 原則無効、実接続テスト時だけ少額の専用枠 |
| 通知 | 本番端末への通知 | 送信無効、試験時は検証用購読だけ |
| PWA | 現在の名前・アイコン | 「ひび学習 TEST」、別アイコン・常時テスト表示 |

Vercel Proには1プロジェクト内のCustom Environmentも1つ含まれます。この方式も可能です。今回はGoogleの認証情報と継続実行するWorkflowの管理を取り違えにくくするため、2プロジェクトを推奨します。同じProチーム・既存の開発者席を使い、新しいPro契約や有料保護オプションを前提にしません。ただしビルド・実行・保存・API利用分は増え得ます。

## 実装前に確認・分離する設定

- 有料のVercelチームに現在のプロジェクトが所属していること、Git連携状況、別チャットの未反映変更を確認します。
- Stagingには別のGoogle OAuthクライアント、Drive所有者の接続、NEXTAUTH_SECRET、固定URLを設定します。同じ個人Googleアカウントを所有者にできますが、本番のrefresh tokenをコピーしません。
- GOOGLE_DRIVE_FOLDER_ID / GOOGLE_SHEETS_ID / FAMILY_IDを分けます。FAMILY_IDだけ変えて同じシートを使うと、現行のログ検証で読み込みに失敗します。
- APP_ENVと許可する保存先IDの組み合わせを検証し、Stagingから本番の保存先を指定した場合は処理開始前に拒否します。2プロジェクト方式ではVercel側のtargetがどちらもproductionになり得るため、NODE_ENVやVERCEL_ENVだけで判定しません。
- StagingのAI_GENERATION_ENABLEDはfalse。これは音声APIには適用されないため、ElevenLabsの鍵も外し、音声生成・通知・Workflow開始に個別の停止ガードを設けます。
- 100語の音声を再生成しません。必要な見本と音声を検証フォルダへコピーし、参照するファイルIDと記録を検証専用に作り直します。実際の回答・プロフィール・通知先を丸ごとコピーしません。
- Stagingはアプリ側のGoogle許可リストで制限します。必要に応じVercel Authenticationも加え、Googleログインの戻り先とWorkflowが保護設定と両立することを確認します。

## 開発と公開の手順

1. 別チャットのUI変更を含む現行作業を確認し、公開する版を確定。検証中のものを巻き込まないようにします。
2. 以降の各チャットは作業ブランチと別の作業ディレクトリを使い、同じmainを同時に編集しません。
3. PRで変更をまとめ、自動テストを通します。開発中のPreviewには本番の秘密設定を渡しません。初期は画面確認用のテストデータを使い、Googleログインなど結合テストは固定URLのStagingで行います。
4. stagingに反映し、iPhoneの通常サイズ・Max・PWAでログイン、学習、保存、音声、再開、権限を確認します。
5. 確認済みのコミットだけmainへ取り込み、本番用設定でビルドします。本番の公開ドメインへは自動で割り当てず、Takashiの公開判断で切り替えます。本番設定での事前確認は読み取り中心とし、テストの学習記録を書き込みません。
6. バージョン・リリースノートを記録して公開。Yuseiは現在と同じURL・PWAを使い続けます。解答途中に強制再読込せず、区切りで更新を案内します。

VercelのGit連携は2プロジェクトとも同じリポジトリから反応するため、ブランチごとのビルド対象を明示します。本番プロジェクトはmainのみ、Stagingはstagingを対象にします。Previewの追加は本番設定を渡さない運用を確認してから行います。

コードの公開と教材のPublishは別です。Stagingで確認した教材を本番へ出す場合は、教材・問題・必要な音声だけを明示して取り込み、学習履歴やテスト用ユーザーは移しません。

## 戻す手順と完了条件

公開前に本番の記録シートと必要な教材をバックアップし、保存形式は旧版でも読める変更を基本にします。VercelのRollbackはアプリの版を戻す機能で、Google Sheetsへ書いたデータまでは戻しません。新しいイベント種別に旧版が対応していないと、ロールバック後にログ全体が読めなくなるため、互換性を事前にテストします。

完了条件は、Stagingで作問・回答・音声再生を行っても本番の記録・通知・課金管理に混入しないこと、確認済みの版だけを公開できること、旧版へ戻して既存の学習記録を読めることです。

## 参考（公式、2026-10-23確認）

- [Vercelの環境・Custom Environment](https://vercel.com/docs/deployments/environments)
- [Git連携とブランチ別デプロイ](https://vercel.com/docs/git)
- [環境ごとの設定管理](https://vercel.com/docs/environment-variables/manage-across-environments)
- [公開前の確認とPromote](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Instant Rollback](https://vercel.com/docs/instant-rollback)
- [Proの料金体系](https://vercel.com/docs/plans/pro-plan)
