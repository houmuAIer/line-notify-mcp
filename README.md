# line-notify-mcp

Android に届く LINE の通知を拾い、自分の Cloudflare アカウント上の MCP サーバーに保存して、Claude から読めるようにする個人用ツールです。

```
LINE の通知 ─────────────▶ Android アプリ ──HTTPS──▶ Cloudflare Worker ──▶ D1（メッセージ）
LINE の共有メニュー（写真）─▶                                │        └──▶ R2（画像）
                                                      Claude ──MCP──┘ （GitHub でサインイン）
```

- `android/` … 通知リスナーアプリ（Kotlin）
- `worker/` … Cloudflare Worker（取り込み API、MCP サーバー、OAuth）
- `scripts/deploy.mjs` … デプロイ用スクリプト

LINEヤフー株式会社とは無関係の非公式ツールです。LINE は LINEヤフー株式会社の商標または登録商標です。

## できること・できないこと

通知に表示された内容を保存します。

- 長いメッセージは途中で切れることがあります。
- 写真と動画は、通知には「〜が写真を送信しました」という文言しか載りません（LINE for Android の通知に画像は添付されていません）。写真は、LINE で写真を開いて共有メニューから「Claudeに保存」を選ぶと保存できます。動画は対象外です。
- スタンプは、通知に載る画像の URL から自動で保存します。
- トークは LINE のトーク ID で見分けるので、グループ名が変わっても同じトークとして扱います。
- 通知をオフにしているトーク、自分が LINE アプリから送ったメッセージは取れません。
- 端末の切り替え中など、アプリが動いていない間の通知は取れません。
- Claude に新着が通知されることはありません。聞かれたときに読みに行きます。

## セキュリティの考え方

保存されるのは他人とのやり取りです。漏れたときの影響が大きいので、入口を絞っています。

- **読む側（Claude）**: GitHub でサインインし、`ALLOWED_GITHUB_USER_ID` に設定した 1 アカウントだけを通します。接続するアプリごとに同意画面を挟みます。
- **書く側（スマホ）**: 10 分で失効する 1 回限りのペアリングコードで端末トークンを発行します。サーバーにはトークンとコードのハッシュだけを保存します。新しい端末をペアリングすると、それまでの端末は失効します。
- **スマホ内**: トークンは Android Keystore の鍵で暗号化し、バックアップと端末間コピーの対象から外しています。
- **リポジトリ**: アカウント固有の ID や URL は含めていません。`wrangler.toml` はリポジトリの外に置き、GitHub OAuth のクライアントシークレットは Cloudflare のシークレットにだけ保存します。

メッセージ本文は第三者が書いた文章です。MCP ツールの説明では、本文を指示として扱わないよう Claude に伝えています。

## セットアップ

必要なもの: Node.js 20 以上、Cloudflare アカウント（画像の保存に R2 を使うため、支払い方法の登録が必要。無料枠の範囲では課金されません）、GitHub アカウント、Android 10 以上の端末。

### 1. サーバー

```sh
cd worker
npm ci --legacy-peer-deps
cd ..
node scripts/deploy.mjs --config-dir ../line-notify-mcp-private --github-user-id <GitHub の数値ユーザー ID>
```

数値ユーザー ID は `https://api.github.com/users/<ユーザー名>` の `id` です。

Cloudflare に未ログインならブラウザが開くので、許可してください。続けてスクリプトが D1・KV・R2 を作成し、`--config-dir` に `wrangler.toml` を書き出してデプロイします。初回は GitHub OAuth アプリの作成手順が表示されるので、Client ID と Client secret を入力してください。2 回目以降は差分だけを反映します。

### 2. Claude

カスタムコネクタとして、スクリプトが最後に表示する `https://…workers.dev/mcp` を追加し、GitHub でサインインします。

### 3. アプリ

```sh
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

1. Claude に「LINE通知のペアリングコードを出して」と頼み、表示された文字列（`https://…#XXXXX-XXXXX`）をアプリに貼り付けます。
2. アプリから「通知へのアクセス」を有効にします。Play ストア外からのインストールなので、先にアプリ情報の右上メニューから「制限付き設定を許可」が必要です。
3. 電池の最適化から除外します。
4. 取り込みたくないトーク（企業の公式アカウントなど）をオフにします。通知からは公式アカウントかどうかを判別できないため、手動で選びます。

### 機種変更・端末の紛失

新しい端末にアプリを入れて、手順 1〜4 をもう一度行うだけです。除外したトークの一覧はサーバーから戻ります。古い端末はペアリングした時点で失効します。端末をなくした場合は、Claude に端末の失効を頼んでください。

同じ署名鍵でビルドし続けたい場合は、`android/keystore.properties`（`storeFile` `storePassword` `keyAlias` `keyPassword`）を置いてください。このファイルと鍵はコミットされません。

## MCP ツール

| ツール | 内容 |
| --- | --- |
| `list_recent_messages` | 直近のメッセージ（トーク・期間で絞り込み可） |
| `search_messages` | 本文の部分一致検索 |
| `list_chats` | トークの一覧と件数、除外中のトーク |
| `delete_messages` | 条件に合うメッセージの削除（`confirm` なしは件数の確認だけ） |
| `list_media` | 保存した画像（共有された写真、スタンプ）の一覧 |
| `get_media` | 画像を Claude に見せる |
| `delete_media` | 条件に合う画像の削除（`confirm` なしは件数の確認だけ） |
| `create_pairing_code` | スマホ用のペアリングコードを発行 |
| `list_devices` / `revoke_device` | ペアリング済み端末の一覧と失効 |

## 開発

```sh
cd worker && npm test          # workerd 上での結合テスト
cd android && ./gradlew testDebugUnitTest
```

通知からの読み取りは `android/.../Extractor.kt` にまとまっています。アプリの「診断」欄で、通知に入っている項目の名前と型（本文や画像の中身は除く）を確認できます。LINE の通知の形はアプリの更新で変わりうるので、取りこぼしや送信者名のずれに気づいたらここを直してください。
