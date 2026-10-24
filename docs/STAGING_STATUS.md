# Stagingの公開状況

更新日: 2026-10-24 JST。アプリ担当が確認した公開実績を記録します。計画と未完了の接続作業は [STAGING_PLAN.md](STAGING_PLAN.md)、Googleの準備手順は [GOOGLE_SETUP.md](GOOGLE_SETUP.md) を参照してください。

## 現在使える範囲

**画面・デモを確認するためのStagingを公開済みです。Googleログイン・クラウド保存を含む結合テスト環境はまだ完成していません。** Vercel Authenticationによる保護を維持しており、誰でも入れる公開環境にはしていません。

| 項目 | 確認した値・状態 |
|---|---|
| プロジェクト | `study-app-staging` |
| プロジェクトID | `prj_2Ny51kBEY1Y1VyqVThuXlmALj8lA` |
| 固定URL | [study-app-staging.vercel.app](https://study-app-staging.vercel.app) |
| この版の固定デプロイURL | [確認済みのStagingデプロイ](https://study-app-staging-o11fn432u-takashi-7721s-projects.vercel.app) |
| デプロイID | `dpl_EMjiZHD94TKXeq2eRuopKVSGEWuW` |
| デプロイ状態 | `READY` |
| 公開ソースコミット | `31768c3ae0e8a7174aa4de22f1e62ed6f052858f` |
| ページ確認 | 保護された環境でルートページのHTTP 200とTESTタイトルを確認 |
| 実行基盤 | Node 24 / Next.js |
| システム環境変数の設定 | 既存本番・Staging両プロジェクトの`autoExposeSystemEnvs=true`を設定情報で確認。本番の新ガードを通す実行時確認は公開時に実施予定 |

この固定デプロイURLとコミットが、今回確認した版です。その後のローカル変更や将来の公開版を確認済みとは扱いません。

## 確認と停止状態

公開前のアプリテスト161件、サーバーテスト258件、Google設定補助テスト11件の計430件が成功しました。型検査と本番ビルドも成功しています。これらは、実際のGoogle接続・有料AI・音声生成・通知送信の成功を示すものではありません。

その後、Apple対応コミット`f48baa1`で、アプリテスト162件・サーバーテスト269件が成功しました。変更のないGoogle設定補助テスト11件の既存成功分を含めると計442件です。担当者によるビルド成功も確認しています。この追加検証は公開コミット`31768c3`の配信内容を示すものではなく、Apple対応はまだStagingに公開していません。

### 公開後の読み取り確認（2026-10-24 10:30 JST）

固定URL `https://study-app-staging.vercel.app` に対し、Vercel CLI 65.1.0の通常の認証・保護通過機能を使って次のGETを確認しました。Vercel Authenticationは解除していません。保護用tokenを手動で読み出したり、文書やログに転記したりしていません。

| パス | HTTP | 実際の応答で確認した内容 |
|---|---|---|
| `/manifest.webmanifest` | 200 | `name`・`short_name`が`ひび学習 TEST`、アイコンは`/test-icon-192.png`・`/test-icon-512.png`、`id`は`/` |
| `/offline.html` | 200 | titleが`ひび学習 TEST — 接続を確認` |
| `/api/state` | 503 | `code: ENVIRONMENT_NOT_BOUND`。学習データを返さず、接続設定不足で停止 |
| `/api/auth/session` | 503 | `code: ENVIRONMENT_NOT_BOUND`。未設定のGoogle接続へ進まず停止 |

APIの503は、この時点のクラウド未接続状態で意図した停止応答です。Googleログインが成功したことや、端末を実際にオフラインにしたPWA試験の完了を示すものではありません。今回確認したのは、配信中のmanifest・オフラインページの内容と、未接続APIの応答です。本番URLへのリクエスト、原本の追加、学習記録の更新、有料AI実行は行っていません。

CLI 65.1.0では`curl`への長い`--global-config`指定がcurl本体へ転送される問題があったため、パス指定後の短縮`-Q`と`--scope`を使用しました。認証情報を引数へ取り出す回避策は使っていません。

次の設定はすべて`false`です。

| 機能 | 設定 |
|---|---|
| AI作問 | `AI_GENERATION_ENABLED=false` |
| 音声生成 | `AUDIO_GENERATION_ENABLED=false` |
| 通知送信 | `PUSH_NOTIFICATIONS_ENABLED=false` |
| Workflow実行 | `WORKFLOW_EXECUTION_ENABLED=false` |

Staging専用のGoogle認証・Drive・Sheetsと保存先bindingは準備中です。専用設定が揃うまで認証・クラウド保存を停止します。Google OAuthのアプリ用callbackは、固定URLの`https://study-app-staging.vercel.app/api/auth/callback/google`を使用します。

## Googleの管理先と準備状況（2026-10-24更新）

ユーザーは、新しいGoogle Stagingの管理先として会社管理の`takashi@norl.ai`を明示的に選択しました。ブラウザでこの会社Googleアカウントへのログインと、組織`norl.ai`（組織ID: `122959324820`）を確認しました。次の会社管理プロジェクトを作成し、組織配下に存在することを確認済みです。

| 項目 | 確認した値 |
|---|---|
| プロジェクト名 | `Hibi Study TEST` |
| プロジェクトID | `norl-hibi-study-staging` |
| プロジェクト番号 | `1089477603802` |
| 所属組織 | `norl.ai` |

会社側のOAuthブランド`ひび学習 TEST`を、サポート・連絡先`takashi@norl.ai`、ExternalのTestingモードで作成しました。Google API Services User Data Policyへの同意は、会社側の設定についてユーザーが承認済みで、作成成功を画面で確認しています。Google Drive APIとGoogle Sheets APIを有効化し、それぞれの管理画面で`Enabled`を確認しました。APIの有効化は、ファイルへのアクセス同意や保存先の作成ではありません。

専用OAuthクライアント`Hibi Study TEST Web`は、Stagingアプリとローカル設定補助の2つのcallbackだけを入力して作成直前で承認待ちです。認証情報の作成、保存先の作成・アクセス権付与はまだ行っていません。Googleの画面には会社アカウントの2段階認証が必要との案内があり、その設定はユーザーの操作待ちです。会社Googleへのログイン確認は、アプリのGoogleログイン成功を意味しません。

それ以前に、個人GmailアカウントでGoogleプロジェクト`hibi-study-staging-20261024`を作成し、OAuthブランド`Hibi Study TEST`を設定しました。ポリシーへの同意はユーザーが明示的に承認済みです。ただし、OAuthクライアントは作成していません。作成フォームが失われた後、管理先を会社アカウントに変更しました。Drive・Sheetsの作成やアクセス権の付与も行っていません。この個人側プロジェクトは未使用のまま残し、削除しません。

GitHubリポジトリの会社管理への移管は相談した段階であり、移管の承認も実施もありません。既存本番の管理先・設定は変更していません。

## 未完了の作業

- 会社管理の`takashi@norl.ai`で必要な2段階認証を設定する。専用OAuthクライアントの作成、テストユーザー・scopeの設定、保存先所有者の同意、Staging専用Drive・Sheets・アカウント設定・bindingを完了する。
- 接続後にGoogleログインと本人限定の保存・読み取りを検証し、Vercel Authenticationを維持した状態でcallbackを確認する。
- 外部機能を有効にする場合は、専用設定と利用範囲を個別に確認する。現時点では有効化・実接続試験をしていない。
- ユーザーは会社メールでApple Accountを作成済みと報告。Apple Developerの法人会員登録・アプリ登録は未実施で、手順を案内済み。アプリ側のApple対応は無効状態で準備中であり、今回の公開版で利用可能と確認した機能には含めない。
- 新規アップロードの一時処理・自動削除は別変更。既存原本のStorage移行は後回しとする。

## 本番への影響

今回のStaging公開では、本番のデプロイ・設定を変更していません。本番の秘密設定・学習記録・原本をStagingへコピーせず、既存原本の移動・削除も行っていません。本番は引き続き[既存のURL](https://study-app-opal-eight.vercel.app/)を使用します。

本番には今回の環境ガードをまだ公開しておらず、その本番実行時の動作確認も未実施です。両プロジェクトの設定情報の確認と、Stagingのページ/API確認を、本番ガードの検証完了と混同しません。

旧デプロイで開始したWorkflowは、その旧版に結び付いています。新しい停止設定やガードの公開だけで旧runまで即停止するとは扱いません。本番で停止が必要な場合は既存runの確認・取消を別途行います。今回の新Stagingには既存runはありません。
