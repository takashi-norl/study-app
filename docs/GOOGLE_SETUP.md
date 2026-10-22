# Google Drive / Sheets の接続設定

写真・PDFは個人Google Driveのアプリ専用フォルダ、問題・履歴は同じアカウントのGoogle Sheetsに保存します。保存には所有者のOAuth接続を使います。家族のログインは別の処理で、奥さま・お子さんにDriveの権限を求めません。サービスアカウントは使用しません。

この手順では、所有者が接続を承認した後、専用フォルダと記録シートを**アプリ自身が新規作成**します。`drive.file` はアプリが作成したファイルにアクセスできるため、Google Picker、Picker用APIキー、トークンの手動コピーは不要です。既存のDriveファイルには権限を追加しません。[Driveのファイル単位権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[Sheets作成APIの権限](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create)

Googleの `/drive/project/…` は通常の保存フォルダとは限りません。Geminiプロジェクト等のURLを `GOOGLE_DRIVE_FOLDER_ID` に転用しないでください。既存フォルダへの保存が必須の場合は、同じOAuthアプリのGoogle Pickerでそのフォルダを許可する別手順が必要です。

## 1. Google Cloudにアプリを登録する

1. 保存先所有者の**個人用Chromeプロフィール**で [Google Cloud Console](https://console.cloud.google.com/)を開き、専用プロジェクトを作成します。
2. **Google Drive API** と **Google Sheets API** を有効にします。
3. Google Auth Platformのアプリ情報・対象ユーザー・連絡先を設定します。個人Googleアカウントを含む場合はExternalを選び、テスト中は所有者と利用する家族をテストユーザーに追加します。
4. Data Accessには `openid`、`https://www.googleapis.com/auth/userinfo.email`、`https://www.googleapis.com/auth/userinfo.profile`、`https://www.googleapis.com/auth/drive.file` を登録します。`drive`や`spreadsheets`全体の権限は不要です。
5. **Web application** のOAuthクライアントを作ります。Authorized redirect URIsに次を登録します。

   ```text
   https://study-app-opal-eight.vercel.app/api/auth/callback/google
   http://localhost:8765/oauth/callback
   ```

   別の本番ドメインを使う場合は1行目を置換します。ローカルのアプリログインも検証する場合だけ `http://localhost:3000/api/auth/callback/google` を追加します。現在のサーバー側OAuth方式ではJavaScript originsやPlayground redirectは不要です。
6. `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を、次の秘密設定ファイルに保存します。チャットやリポジトリに貼り付けません。

Externalで公開ステータスがTestingの場合、Driveを含むrefresh tokenは原則7日で期限切れになります。継続運用前にGoogle側でProductionへの切替・必要な確認を済ませ、その後に最終的な接続を取得してください。Productionでもアプリ側の家族許可リストは有効です。[Googleのトークン有効期限](https://developers.google.com/identity/protocols/oauth2/)

## 2. このMacに秘密設定ファイルを用意する

プロジェクト直下の `.env.google-client.json` に、次の形式で設定します。`.env*` はGit管理対象外ですが、Googleのファイル共有やクラウド同期が行われる場所には置かないでください。別の秘密フォルダに置き、起動時にそのパスを渡すこともできます。

```json
{
  "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
  "GOOGLE_DRIVE_OWNER_EMAIL": "owner@example.com"
}
```

実際の保存先所有者のメールに置換し、ファイルを所有者だけが読めるようにします。

```sh
chmod 600 .env.google-client.json
node scripts/setup-google.mjs --config .env.google-client.json
```

Google Consoleからダウンロードした `web` 形式のJSONをそのまま渡す方式ではありません。上記3項目の形式に変換してください。すでに安全に設定済みの場合は、同名の3環境変数からも起動できます。秘密値をコマンド引数に渡したり、コマンド履歴へ直接書いたりしないでください。

## 3. 所有者が接続を確認する

個人用Chromeで [セットアップ画面](http://localhost:8765)を開き、表示される所有者メールと作成内容を確認します。「Googleで接続し、専用の保存先を作成する」を押し、指定した所有者のGoogleアカウントで許可します。開始画面の有効期限は10分です。

セットアップは次を実行します。

- `openid`、メール、`drive.file` のみでoffline accessを要求します。家族の通常ログイン設定は変更しません。
- Googleから返された認証を、state・PKCE・ブラウザ用Cookie・ID tokenの署名／発行元／audience／nonce・本人確認済み所有者メールで検証します。指定と異なるアカウントや広いDrive権限なら、ファイル作成前に停止します。
- マイドライブに「ひび学習アプリ」フォルダと「ひび学習アプリ・学習記録」を作成し、シートを専用フォルダに移動します。共有リンクは公開しません。
- `Events` タブのA〜M列に以下の見出しを設定します。

  ```text
  id type actorId familyId createdAt payload1 payload2 payload3 payload4 payload5 payload6 payload7 payload8
  ```

接続結果はプロジェクト直下の **`.env.google-setup.json`** に、所有者のみ読み書き可能な `0600` で保存されます。秘密値はブラウザ、標準出力、ログに表示しません。access tokenやID tokenは出力ファイルに保存しません。保存されるrefresh tokenとclient secretは秘密情報です。セットアップはVercelへ自動送信せず、AIも呼び出しません。[GoogleのOffline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)

完了画面を確認してページを閉じ、ターミナルで `Ctrl+C` を押してローカルサーバーを終了します。成功済みの結果を使って再開・確認する場合は次を使います。起動するだけでは書き込みせず、再開画面のボタンを押してから実行します。

```sh
node scripts/setup-google.mjs --resume
```

保存済みフォルダやシートは再作成しません。ファイル作成の通信中に結果不明となった場合は、重複を避けるため自動再実行せず停止します。その場合はDrive側の作成結果を確認してから復旧します。秘密出力ファイルを削除して最初からやり直す操作は、結果の確認後に行ってください。

`Events` はアプリ専用です。行の並べ替え・削除・セルの編集はせず、閲覧用の集計は別タブに作ります。イベントの行順が「最初に受け付けた回答」を決めます。バックアップはシートのコピーで取れます。

セットアップのローカルテストは以下で実行します。GoogleやVercelには接続しません。

```sh
node --test tests/setup-google.test.mjs
```

## 4. Vercelの環境変数

`.env.google-setup.json` の `env` 内にある接続値を、明示的な操作でVercelのProduction環境へ登録し、再デプロイします。ファイル全体を表示・チャットへ貼付せず、設定画面または値を標準入力で渡すCLI操作を使ってください。必ず意図したVercelアカウント・チームを確認します。Preview環境も使う場合は、そのURLのOAuth callbackと環境変数も別途設定します。

| 名前 | 値 |
|---|---|
| `NEXTAUTH_URL` | `https://YOUR-APP.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | 同じ本番URL |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` で作成したランダム値 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 同じOAuthクライアントの値 |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | 所有者のrefresh token |
| `GOOGLE_DRIVE_OWNER_EMAIL` | 所有者のメール。設定するとtokenの所有者と確認済みメールを照合 |
| `GOOGLE_DRIVE_FOLDER_ID` | セットアップで作成した保存フォルダID |
| `GOOGLE_SHEETS_ID` | セットアップで作成した記録スプレッドシートID |
| `GOOGLE_SHEETS_EVENTS_TAB` | `Events`（省略時も同じ） |
| `FAMILY_ID` | `family-primary`（省略時も同じ。運用開始後は変更しない） |
| `ALLOWED_FAMILY_MEMBERS_JSON` | 下記の形式。実際の家族のメールに置換 |

```json
[{"id":"parent","email":"parent@example.com","name":"お母さん","role":"parent"},{"id":"student","email":"student@example.com","name":"高校生","role":"student"}]
```

`id` は学習履歴と結びつくので運用開始後は変えません。役割は `parent` / `student` のみです。許可リストを空にする、同じメールやIDを重複させる、設定が欠ける場合はログインできません。所有者と利用する保護者が別アカウントでも構いません。

Claude API・Web Push・Vercel Workflowの設定は別途必要です。Google接続の確認中は `AI_GENERATION_ENABLED=false` にしておけます。

## 5. 接続確認と運用上の範囲

本番URLで保護者としてログインし、問題集を1つ作成、写真を1枚アップロードします。Eventsへの行追加、指定フォルダへの写真追加、認証された原本プレビューを確認します。次に生徒としてログインし、下書き・解答・原本が公開前の画面に出ないことを確認します。

ブラウザの写真アップロードは、サーバーが作った単一ファイル用resumable URLへ直接PUTします。OAuthトークンはブラウザに渡しません。Googleの公式ブラウザ例と同じ方式ですが、**実運用URLとiPhone SafariでのCORS・10MBのアップロードは実接続後に確認する必要があります。** URLはアップロード権限を持つため、ログや学習記録へ保存しません。失敗した場合は写真を選び直してアップロードします。[Googleのresumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

Sheetsはデータベースではありません。読み書きは所有者の割当量を家族で共有します。現在の目安では10問で約30回の読み取りと20回の書き込みに、画面更新・開始処理が加わります。毎問後の全履歴確認で競合を防ぐため、履歴をキャッシュして読み飛ばすことはしていません。高速な連続練習・複数端末・保護者の頻繁な更新が重なると429が発生し得ます。既定の割当はユーザー・プロジェクト当たり毎分60回ずつで、長期に履歴が増えると全件読込みも重くなります。規模が増えたら問題・解答履歴だけをデータベースへ移す設計です。[Sheetsの割当量](https://developers.google.com/workspace/sheets/api/limits)

問題の生成上限はアプリ内のジョブ回数・問題数上限です。API側で発生する正確な料金を保証する金額上限ではないため、Claude側でも利用上限を設定します。通信が不明な状態で終わった場合、課金済みの応答を再取得できないことがあります。
