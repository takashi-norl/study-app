# Appleログインの設定

Appleログインは任意です。設定を完了するまで `APPLE_AUTH_ENABLED=false` とし、Googleログインを継続します。この手順では、有料プログラムへの加入、アプリの新規公開、秘密鍵の生成、実アカウントの追加を自動で行いません。

## 先に確認する前提

Apple Developer Programで、Certificates, Identifiers & Profilesを設定できるチーム権限が必要です。無料のApple Accountだけではこの設定を完了できません。[Appleのアカウント概要](https://developer.apple.com/help/account/basics/about-your-developer-account/)

Web認証は、Sign in with Appleを有効にしたprimary App IDと、Web用Services IDの関連付けを使います。Appleの現行説明では、Web認証にもSign in with Apple対応の既存App Storeアプリが必要とされています。PWAをホーム画面へ追加するだけで、この前提を満たすものではありません。既存の関連アプリがない場合は、公開を勝手に進めずApple側の利用条件を確認します。[環境設定](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)、[Web向け利用ガイドライン](https://developer.apple.com/sign-in-with-apple/usage-guidelines-for-websites-and-other-platforms/)

## 法人として加入する場合

1. 申込担当者本人のApple Accountで2ファクタ認証を有効にします。法人の正式名称、契約を締結できる権限、法人ドメインの業務メール、公開され実際に稼働する法人Webサイトを用意します。法人名を担当者の氏名欄へ入力しません。[法人加入の条件](https://developer.apple.com/help/account/membership/program-enrollment)
2. 法人に対応する9桁のD‑U‑N‑S番号を確認します。未取得ならAppleの案内から照会・申請します。正式法人名と本店所在地を法人登記・D&Bの情報に揃えます。Appleの案内では番号発行に最大5営業日、その後Appleへの反映に最大2営業日が目安です。[D‑U‑N‑Sの確認](https://developer.apple.com/help/account/membership/D-U-N-S)
3. [Apple Developer Programの加入ページ](https://developer.apple.com/programs/enroll/)で法人として申し込みます。Appleから追加の本人確認・法人確認・契約権限の確認を求められた場合は、担当者本人が対応します。
4. Appleの審査後に契約と年会費を確認して加入を完了します。通常のDeveloper Programは年99米ドル、対象地域では現地通貨で請求されます。請求額・更新条件は申込画面で確認してください。[プログラムの案内](https://developer.apple.com/programs/)

加入だけでWeb認証の前提がすべて揃うわけではありません。上記の関連App Storeアプリ、App ID、Services IDと実ログインの確認が完了するまで、アプリ側はApple無効のままにします。

## 環境ごとの設定

1. Apple DeveloperのIdentifiersでprimary App IDのSign in with Appleを有効にします。
2. 本番用とStaging用の**異なるServices ID**を作り、それぞれの固定HTTPSドメインと、`https://その環境のホスト/api/auth/callback/apple` を登録します。localhost、IPアドレス、HTTPの戻り先は使用しません。[Web設定手順](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)、[認証リクエスト](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.?changes=_6%2C_6)
3. Sign in with Apple用の秘密鍵を用意し、Appleの手順でServices IDごとにES256署名済みのclient-secret JWTを作ります。秘密鍵 `.p8` 自体はこのWebアプリへ登録しません。[秘密鍵の設定](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/)、[NextAuthのApple設定](https://next-auth.js.org/providers/apple)
4. Vercelの対象プロジェクトへ次のサーバー専用設定を登録します。値をチャット・ソースコード・公開環境変数へ貼り付けません。

| 設定 | 内容 |
|---|---|
| `APPLE_AUTH_ENABLED` | 確認前は `false`、有効化時だけ `true` |
| `APPLE_CLIENT_ID` | その環境のServices ID |
| `APPLE_CLIENT_SECRET` | Services IDに対応する署名済みJWT。`.p8`の本文ではない |

5. 既存の `APP_ENV_BINDINGS_JSON` の `production` と `staging` の両方へ `appleClientId` を追加します。それぞれのServices IDは異なる値にします。以下は追加部分だけの例で、既存のGoogle・保存先項目を消して置換するものではありません。

   ```json
   {
     "production": { "appleClientId": "com.example.study.web" },
     "staging": { "appleClientId": "com.example.study.staging" }
   }
   ```

Appleでは旧本番用の環境設定省略経路を使いません。既知Vercelプロジェクト、APP_ENV、Google/保存先binding、HTTPS URLが一致した上で、現在のApple Services IDも照合します。Googleだけの既存bindingには `appleClientId` は不要です。

## 期限と秘密情報

client-secret JWTには `alg=ES256`、10文字の `kid`、10文字のTeam IDを示す `iss`、Services IDと同じ `sub`、`aud=https://appleid.apple.com`、`iat`、`exp` が必要です。アプリは期限切れや6か月を超える期間、不正な形式、環境と違うServices IDを拒否してAppleボタンを非表示にします。署名の形式は確認しますが、秘密鍵を読み込んで署名の真正性を検証する処理ではありません。client secretの真正性はAppleとのtoken交換時に検証されます。期限前に、運営者が新しい署名済みJWTへ更新します。[Appleのclient secret形式](https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret?changes=_7)

不備があるApple設定はGoogleログインを無効にしません。JWT本文、秘密鍵、復号したclaim、OAuthのtokenをブラウザやログへ出さないでください。Appleのキーや識別子を取得・登録していない段階では、実ログインの確認は未完了です。

client secretの期限切れやAppleボタンの無効化だけでは、発行済みのアプリセッションを失効させません。既存セッションは会員が有効な間は継続し、アクセスのたびに会員の失効を確認します。期限切れ中にサインアウトした利用者は、設定を更新するまでAppleで再ログインできません。アクセスを停止する場合は会員を失効させます。

## 本人の学習アカウント

Appleの本人確認は、署名・issuer・audience・有効期限などを検証したID tokenから行います。Webから渡された名前や任意のメール入力を本人確認の代わりに使いません。氏名はAppleの署名済みID tokenに含まれません。[本人情報の扱い](https://developer.apple.com/documentation/signinwithapple/receiving-a-users-identity-token)

新規のApple利用者は、招待先とAppleが確認したメールが一致する場合に登録します。「メールを非公開」のリレーアドレスから元のGoogleメールを推測しません。招待先と異なるリレーアドレスの場合は、そのまま登録を通しません。既存のGoogleアカウントへメール一致だけで自動連携せず、運営者のメールと一致するだけで権限を付けません。同じ学習アカウントへの追加連携には、既存アカウントとAppleの両方の本人確認が必要です。その専用の連携操作を実装・確認するまでは、既存利用者はGoogleを使います。

Appleの初回メールと本人IDを登録した後は、providerと安定したsubjectで本人を識別します。メールや表示名を学習データの所有IDに置き換えません。既存のGoogleログイン、学習データのID、招待失効は引き継ぎます。

## 有効化前の確認

- StagingでApple設定が欠ける場合・期限切れの場合でもGoogleが使え、Appleが表示されない。
- 本番Services IDをStagingへ指定してもAppleが有効にならない。
- 新しい招待、再ログイン、メール非公開、キャンセルを実際のAppleアカウントで確認する。
- AppleのPOST callbackで短寿命の認証確認Cookieが届き、state・PKCE・nonceの照合に失敗したリクエストを拒否する。通常セッションCookieの保護は弱めない。
- 既存Google利用者や運営者へAppleのメール一致だけで接続しない。会員の利用停止後は既存セッションでもアクセスできず、未使用の招待を取り消した場合は新規登録できない。

Apple登録を含む新しい会員レコードを書き始める前に、Apple対応の保存レコード形式を読めるデプロイへ揃えてください。初期状態ではAppleが無効なので、新しいApple会員レコードは作成されません。

## 復旧先の制約

最初のApple登録後は、`beta.member.registered` に `authProvider: "apple"` と `authSubject` を含む運営記録が残ります。Apple対応前の版（`31768c3`を含む）はこの形式を厳密検証で拒否するため、Google利用者を含む全体の状態読み込みも失敗します。Appleを無効へ戻すだけでは、この互換性問題は解消しません。

有効化前に、今回のApple形式を読める版のコミットとデプロイを復旧先として保存してください。**最初のApple登録後に戻せる最低版は、このApple対応版、または同じ読み取り互換性を追加した版です。** 対応前の版へそのまま戻したり、復旧のために会員記録を削除したりしません。Apple無効・Apple登録なしの段階では、この新形式による制約は発生しません。
