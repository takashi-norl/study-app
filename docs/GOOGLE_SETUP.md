# Google Drive / Sheets の接続設定

写真・PDFは指定した個人Google Driveフォルダ、問題・履歴は指定したGoogle Sheetsに保存します。保存には所有者のOAuth接続を使います。家族のログインは別の処理で、奥さま・お子さんにDriveの権限を求めません。サービスアカウントは使用しません。

## 1. 保存先を用意する

保存先の所有者アカウントでGoogle Driveを開き、アプリ専用フォルダと、その中に新しいスプレッドシートを作成します。既存の専用フォルダを使っても構いません。共有リンクを公開する必要はありません。

シート内のタブ名を `Events` に変更し、1行目のA〜M列に以下をタブ区切りで貼り付けます。

```text
id	type	actorId	familyId	createdAt	payload1	payload2	payload3	payload4	payload5	payload6	payload7	payload8
```

以後このタブはアプリ専用です。行の並べ替え・削除・セルの編集はせず、閲覧用の集計は別タブに作ります。イベントの行順が「最初に受け付けた回答」を決めます。バックアップはシートのコピーで取れます。

## 2. Google Cloudにアプリを登録する

1. [Google Cloud Console](https://console.cloud.google.com/)で専用プロジェクトを作成し、**プロジェクト番号**を控えます。
2. Google Drive API、Google Sheets API、Google Picker APIを有効にします。
3. Google Auth Platformのアプリ情報・対象ユーザー・連絡先を設定します。個人Googleアカウントを含む場合はExternalを選び、テスト中は所有者と利用する家族をテストユーザーに追加します。
4. Data Accessに `openid`、`https://www.googleapis.com/auth/userinfo.email`、`https://www.googleapis.com/auth/userinfo.profile`、`https://www.googleapis.com/auth/drive.file` を登録します。`drive`や`spreadsheets`全体の権限は不要です。
5. Web applicationのOAuthクライアントを作ります。JavaScript originsに本番URL、`http://localhost:3000`、セットアップ用の `http://localhost:8765` を登録します。
6. Authorized redirect URIsに以下を登録します。
   - `https://YOUR-APP.vercel.app/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
   - `https://developers.google.com/oauthplayground`
7. `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を控えます。同じプロジェクト内にPicker用APIキーも作り、HTTP referrersを `http://localhost:8765/*`、API制限をGoogle Picker APIに絞ります。このキーは一度の保存先選択にだけ使います。

Externalで公開ステータスがTestingの場合、Driveを含むrefresh tokenは原則7日で期限切れになります。継続運用前にGoogle側でProductionへの切替・必要な確認を済ませ、その後に接続を取得してください。アプリ側の家族許可リストはProductionでも有効です。[Googleのトークン有効期限](https://developers.google.com/identity/protocols/oauth2/)

## 3. 所有者のrefresh tokenを取得する

1. [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)を開き、右上の設定で **Use your own OAuth credentials** を有効にして、手順2のクライアントID・シークレットを入力します。OAuth flowはServer-side、Access typeはOffline、PromptはConsentにします。
2. Step 1の入力欄に、空白で区切って以下を指定し、Authorize APIsを押します。

   ```text
   openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file
   ```

3. **保存先フォルダを所有するアカウント**を選び、要求された権限を確認して許可します。
4. Step 2で **Exchange authorization code for tokens** を押します。返された `refresh_token` をVercelの `GOOGLE_DRIVE_REFRESH_TOKEN` に登録します。`access_token` は次のPicker設定で一時的に使います。
5. トークンのscopeに広い `drive` / `spreadsheets` 権限が混ざっていたら、既存のアプリ連携をGoogleアカウントから取り消して、必要なscopeだけで取り直します。アプリは広すぎる保存用トークンを拒否します。

Playground既定のクライアントを使ったトークンでは、このアプリの保存権限になりません。必ず**自分のOAuthクライアント**で取得してください。refresh tokenやclient secretはサーバーの環境変数だけに保存し、リポジトリ、HTML、チャット、ブラウザのlocalStorageには保存しません。[GoogleのOffline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)

## 4. Pickerで既存フォルダとシートを許可する

**フォルダIDを環境変数に入れるだけでは許可されません。** `drive.file` では、同じアプリのGoogle Pickerで既存のフォルダと既存のスプレッドシートをそれぞれ選択します。フォルダを選んでも、既存のシートまで自動で許可されたとは扱いません。[Driveのファイル単位権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

以下をローカルの空の作業用フォルダに `picker.html` として保存します。コードには秘密値を書かず、ブラウザの入力欄に短期access token・APIキー・プロジェクト番号を入力します。

```html
<!doctype html><html lang="ja"><meta charset="utf-8">
<title>学習アプリの保存先を選ぶ</title>
<p>同じGoogle Cloudプロジェクトの値を入力します。保存はしません。</p>
<p><label>プロジェクト番号 <input id="project" autocomplete="off"></label></p>
<p><label>Picker APIキー <input id="apiKey" autocomplete="off"></label></p>
<p><label>短期access token <input id="token" type="password" autocomplete="off"></label></p>
<button id="folder" disabled>1. 保存フォルダを選ぶ</button>
<button id="sheet" disabled>2. 記録スプレッドシートを選ぶ</button>
<pre id="result"></pre>
<script>
function pickerReady() {
  gapi.load('picker', () => {
    document.querySelector('#folder').disabled = false;
    document.querySelector('#sheet').disabled = false;
  });
}
function choose(kind) {
  const project = document.querySelector('#project').value.trim();
  const apiKey = document.querySelector('#apiKey').value.trim();
  const token = document.querySelector('#token').value.trim();
  if (!project || !apiKey || !token) return alert('3つの値を入力してください。');
  const view = kind === 'folder'
    ? new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true).setSelectFolderEnabled(true)
    : new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);
  new google.picker.PickerBuilder().setAppId(project).setDeveloperKey(apiKey)
    .setOAuthToken(token).setOrigin(location.origin).addView(view)
    .setCallback(data => {
      if (data.action === google.picker.Action.PICKED) {
        const file = data.docs[0];
        const key = kind === 'folder' ? 'GOOGLE_DRIVE_FOLDER_ID' : 'GOOGLE_SHEETS_ID';
        document.querySelector('#result').textContent += key + '=' + file.id + '\n';
      }
    }).build().setVisible(true);
}
document.querySelector('#folder').onclick = () => choose('folder');
document.querySelector('#sheet').onclick = () => choose('sheet');
</script>
<script src="https://apis.google.com/js/api.js?onload=pickerReady" async defer></script>
</html>
```

そのフォルダで次を実行し、[ローカルPicker](http://localhost:8765)をChromeで開きます。Node.jsの標準機能だけを使います。

```sh
node -e 'const http=require("node:http"),fs=require("node:fs");http.createServer((req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.setHeader("Cache-Control","no-store");res.end(fs.readFileSync("picker.html"));}).listen(8765,"127.0.0.1")'
```

1→2の順で作成済みの保存先を選び、表示された2つのIDをVercelに登録します。終わったらページを閉じ、ローカルサーバーを停止します。期限切れのaccess tokenはPlaygroundでrefresh tokenから更新できます。**refresh tokenをPicker入力欄へ入れないでください。** [Pickerの公式実装例](https://developers.google.com/workspace/drive/picker/guides/web-picker)

## 5. Vercelの環境変数

Production環境に以下を登録し、再デプロイします。Preview環境も使う場合は、そのURLのOAuth callbackと環境変数も別途設定します。

| 名前 | 値 |
|---|---|
| `NEXTAUTH_URL` | `https://YOUR-APP.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | 同じ本番URL |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` で作成したランダム値 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 同じOAuthクライアントの値 |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | 所有者のrefresh token |
| `GOOGLE_DRIVE_OWNER_EMAIL` | 所有者のメール。設定するとtokenの所有者と確認済みメールを照合 |
| `GOOGLE_DRIVE_FOLDER_ID` | Pickerで許可した保存フォルダID |
| `GOOGLE_SHEETS_ID` | Pickerで許可した記録スプレッドシートID |
| `GOOGLE_SHEETS_EVENTS_TAB` | `Events`（省略時も同じ） |
| `FAMILY_ID` | `family-primary`（省略時も同じ。運用開始後は変更しない） |
| `ALLOWED_FAMILY_MEMBERS_JSON` | 下記の形式。実際の家族のメールに置換 |

```json
[{"id":"parent","email":"parent@example.com","name":"お母さん","role":"parent"},{"id":"student","email":"student@example.com","name":"高校生","role":"student"}]
```

`id` は学習履歴と結びつくので運用開始後は変えません。役割は `parent` / `student` のみです。許可リストを空にする、同じメールやIDを重複させる、設定が欠ける場合はログインできません。所有者と利用する保護者が別アカウントでも構いません。

Claude API・Web Push・Vercel Workflowの設定は別途必要です。Google接続の確認中は `AI_GENERATION_ENABLED=false` にしておけます。

## 6. 接続確認と運用上の範囲

本番URLで保護者としてログインし、問題集を1つ作成、写真を1枚アップロードします。Eventsへの行追加、指定フォルダへの写真追加、認証された原本プレビューを確認します。次に生徒としてログインし、下書き・解答・原本が公開前の画面に出ないことを確認します。

ブラウザの写真アップロードは、サーバーが作った単一ファイル用resumable URLへ直接PUTします。OAuthトークンはブラウザに渡しません。Googleの公式ブラウザ例と同じ方式ですが、**実運用URLとiPhone SafariでのCORS・10MBのアップロードは実接続後に確認する必要があります。** URLはアップロード権限を持つため、ログや学習記録へ保存しません。失敗した場合は写真を選び直してアップロードします。[Googleのresumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

Sheetsはデータベースではありません。読み書きは所有者の割当量を家族で共有します。現在の目安では10問で約30回の読み取りと20回の書き込みに、画面更新・開始処理が加わります。毎問後の全履歴確認で競合を防ぐため、履歴をキャッシュして読み飛ばすことはしていません。高速な連続練習・複数端末・保護者の頻繁な更新が重なると429が発生し得ます。既定の割当はユーザー・プロジェクト当たり毎分60回ずつで、長期に履歴が増えると全件読込みも重くなります。規模が増えたら問題・解答履歴だけをデータベースへ移す設計です。[Sheetsの割当量](https://developers.google.com/workspace/sheets/api/limits)

問題の生成上限はアプリ内のジョブ回数・問題数上限です。API側で発生する正確な料金を保証する金額上限ではないため、Claude側でも利用上限を設定します。通信が不明な状態で終わった場合、課金済みの応答を再取得できないことがあります。
