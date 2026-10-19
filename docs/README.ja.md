# Pi Web

[English](../README.md) | [简体中文](./README.zh-CN.md) | [Русский](./README.ru.md)

[pi コーディングエージェント](https://github.com/earendil-works/pi) のローカルブラウザー UI です。Pi Web は pi と同じローカル設定とセッションファイルを使用し、ブラウザーから会話の検索と再開、エージェントの実行、モデルやリソースの設定、プロジェクトファイルの確認を行えます。

**[インタラクティブデモを試す →](https://agegr.github.io/pi-web/)**：実際の Pi Web UI がブラウザー内だけで動作し、サンプルのセッション、ファイル、モデルを確認できます。インストールは不要です。返信はあらかじめ用意された内容で、モデルは呼び出しません。

![構造化された Markdown、ツール呼び出し、プロジェクトナビゲーションとともに pi セッションを表示する Pi Web](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 機能

- **セッションワークスペース**：プロジェクトごとに会話を閲覧、再開、名前変更、エクスポート、削除し、実行状態、コンテキスト使用量、コスト、コンパクション情報を確認できます。
- **2 種類の分岐**：**New session** は以前のメッセージから独立したセッションファイルを作成し、**Edit from here** は現在のセッション内にブランチを作成します。
- **プロジェクトファイルツール**：ファイルの閲覧とアップロード、Git Diff の確認、ソース、Markdown、画像、音声、PDF、DOCX のプレビューに対応し、変更時は自動更新されます。
- **Git worktree**：同じリポジトリのセッションをまとめたまま、サイドバーからチェックアウトを切り替えられます。
- **Web での設定**：Pi Web を離れずに、Provider のログインと API Key、モデル、モデルテスト、プラグインパッケージ、スキルを管理できます。
- **英語、簡体字中国語、繁体字中国語の UI**：初回はブラウザーの言語に従い、トップバーから言語を切り替えられます。

## クイックスタート

Pi Web には Node.js 22.19.0 以降が必要です。`node --version` でバージョンを確認してから、次を実行します：

```bash
npx @agegr/pi-web@latest
```

サーバーの準備が整うと、CLI はブラウザーを自動的に開こうとします。開かない場合は [http://127.0.0.1:30141](http://127.0.0.1:30141) にアクセスしてください。Pi Web はデフォルトで `0.0.0.0` をリッスンするため、同じネットワーク上のスマートフォンや他のデバイスからもアクセスできます（準備完了後、コンソールに LAN の URL 例 `http://192.168.1.20:30141` が表示されます）。ローカル専用にするには `--hostname 127.0.0.1` を指定してください。

モデル Provider が未設定の場合は、**Models** パネルを開いてログインするか API Key を追加してください。

`pi-web` コマンドをグローバルにインストールする場合：

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

コマンド：

```bash
pi-web version          # インストール済みのバージョンを表示
pi-web status           # 実行中のサーバーを一覧表示
pi-web stop [--port N]  # 実行中のサーバーを停止
pi-web open [--port N]  # 実行中のサーバーをブラウザーで開く
pi-web update [--check] # グローバル npm インストールを更新
```

更新時は `pi-web stop` を実行してから `pi-web update` を実行します（同じインストールコマンドの再実行でも構いません）。アンインストールするには `npm uninstall -g @agegr/pi-web` を実行します。

## 設定

ポートとホスト名では、コマンドラインオプションが対応する環境変数より優先されます。`--no-open` と `PI_WEB_NO_OPEN=1` は、どちらを指定してもブラウザーの自動起動が無効になります。`pi-web --help`（または `-h`）で起動オプションを表示して終了します。未知のオプションはエラーで終了します。

| オプションまたは環境変数 | 用途 | デフォルト |
| --- | --- | --- |
| `--help`、`-h` | 起動オプションを表示して終了 | — |
| `--port <port>`、`-p <port>`、または `PORT` | サーバーポート | `30141` |
| `--hostname <host>`、`-H <host>`、または `PI_WEB_HOSTNAME` | バインドするホスト名 | `0.0.0.0`（LAN から到達可能。ローカル専用は `127.0.0.1`） |
| `--no-open` または `PI_WEB_NO_OPEN=1` | ブラウザーを自動的に開かない | 自動的に開く |
| `PI_WEB_ALLOWED_HOSTS` | 追加で許可するプロキシまたはカスタムホスト名。複数指定はカンマ区切りで完全一致 | 未設定 |
| `PI_WEB_PASSWORD` | ブラウザーのパスワードログイン（API はユーザー名 `pi` の Basic Auth）。設定すると生成済みパスワードを上書き、空文字で認証を完全に無効化 | 初回起動時に強力なランダムパスワードを生成し、起動時にコンソールへ表示、`~/.pi/agent/pi-web-secret` に保存 |

例：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### リモートアクセス

Pi Web は既定で `0.0.0.0` にバインドし、**パスワードを必須**にします。ソースに既定のパスワードはありません。初回起動時に強力なランダムパスワードを生成して起動時に表示し、`~/.pi/agent/pi-web-secret`（権限 `0600`）に保存します。このファイルを削除すれば新しいパスワードになります。自分で指定する場合は `PI_WEB_PASSWORD` を設定します：

```bash
PI_WEB_PASSWORD='十分に長いランダムなパスワード' pi-web
```

`PI_WEB_PASSWORD` を空にすると認証を完全に無効化できます（POSIX のみ。Windows は空の環境変数を設定できないため、**設定 › リモートアクセス › ログインにパスワードを要求** を使ってください。`~/.pi/agent/pi-web-auth.json` に保存されます）。信頼できる隔離されたマシンでのみ行ってください。

**設定 › リモートアクセス** では、入力なしでスマートフォンをペアリングできます。このマシンの LAN アドレス（Tailscale があればそれも）を一覧し、約 2 分間有効な使い捨て QR コードを生成します。同じパネルから Cloudflare のクイックトンネル（`https://<ランダム>.trycloudflare.com`）も開始でき、別ネットワークのスマートフォンでもアプリもアカウントも不要でアクセスできます。パスワード未設定ではトンネルは開始しません。初回利用時に `cloudflared` を（`HTTPS_PROXY` または検出したローカルプロキシ経由で）`~/.pi/agent/pi-web-bin` にダウンロードし、**アンインストール** で削除できます。

パスワード認証は接続を暗号化しません。公開トンネルは HTTPS ですが、LAN アドレスは平文 HTTP です。平文 HTTP で Pi Web をインターネットに公開せず、信頼できるリバースプロキシによる HTTPS または信頼できる VPN を使用してください。リバースプロキシが外部ホスト名を転送する場合は、その名前を完全一致で `PI_WEB_ALLOWED_HOSTS` に追加します。この許可リストは Pi Web のバインド先を変更しません。

### HTTP プロキシ

サーバー側のモデルリクエストと API リクエストは、標準の `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 環境変数を使用します。

macOS または Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 注意事項

- **エージェントデータ**：Pi Web はデフォルトで `~/.pi/agent` の pi データを読み込みます。セッションファイルは `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` にあります。別の pi エージェントディレクトリを使用するには `PI_CODING_AGENT_DIR` を設定してください。
- **ファイルシステムへのアクセス**：Pi Web はエージェントデータディレクトリと、セッションに記録された作業ディレクトリを読み取れる必要があります。既存の pi セッションを共有する場合は、pi と同じファイルシステム環境で Pi Web を実行してください。
- **共有設定**：Models パネルは pi のモデル、設定、認証情報ストレージを使用するため、変更は両方のインターフェースに反映されます。
- **ファイルアクセスの範囲**：ファイルブラウザーは、Pi Web で選択した作業ディレクトリと、既知のプロジェクトまたはセッションルートに限定されます。汎用のファイルシステムブラウザーではありません。
- **Git worktree**：スイッチャーの表示条件、worktree の作成、削除時の動作については [Worktrees in Pi Web](./worktrees.md) を参照してください。

## 開発

```bash
npm install
npm run dev
```

開発サーバーは [http://127.0.0.1:30141](http://127.0.0.1:30141) で動作します。一般的なチェックは次のコマンドで実行します：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

通常の開発中は `next build` または `npm run build` を実行しないでください。`.next/` に書き込まれ、開発サーバーに影響する可能性があります。ビルドはリリース作業時にのみ実行してください。

新機能に取りかかる前に、[Contributing](../CONTRIBUTING.md) で対象範囲とプルリクエスト前のチェック項目を確認してください。

コントリビューター向けガイド：[Internationalization](./i18n.md) と [Release process](./release.md)。

## リポジトリ構成

```text
app/             Next.js UI と API ルート
components/      React UI コンポーネント
hooks/           クライアントの状態と操作に関する hooks
lib/             セッション、エージェント、モデル、ファイル、Git、セキュリティのロジック
public/          静的アセットと PWA ファイル
bin/             npm CLI エントリポイントと起動オプションの解析
docs/            ユーザーおよびコントリビューター向けの個別ガイド
demo/            GitHub Pages で公開する静的デモ（demo/README.md を参照）
```

アーキテクチャの説明と詳細なファイルマップについては [AGENTS.md](../AGENTS.md) を参照してください。

## ライセンス

[MIT](../LICENSE)
