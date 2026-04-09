# Karakuri

AI駆動開発プラットフォーム - Docker + Claude Code による自動コード生成システム

## 概要

KarakuriはGitHub Actions + Claude Codeの課題を解決する独自のWebアプリケーションです：

- **タスク単位のDockerコンテナ**: 各タスクが独立した開発環境を持つ
- **リアルタイムログ配信**: Claude Code実行中のログをWebSocketで配信
- **ローカル開発**: ローカルでビルド・テスト可能
- **ブランチ継続性**: 開発コンテキストをセッション間で維持

## 実装状況

### MVP（実装済み・動作確認済み）

- タスク管理（作成、一覧、詳細表示、停止、削除）
- Dockerコンテナのライフサイクル管理（SSH鍵マウントによるGitHub認証）
- プロンプト変換AI（簡潔な指示→最適なプロンプトへ変換・再生成）
- プロンプト確認画面（確定後にClaude Code CLI実行）
- Claude Code CLI実行（ストリーミング出力）
- WebSocketによるリアルタイムログ配信
- テスト実行と結果追跡
- シンプルなトークン認証
- React + Vite + TypeScript フロントエンド

### 今後実装予定

優先度 **高**（使い勝手に直結）：
- 指示入力欄・プロンプト表示欄の拡大（現在コンソールより狭く作業しにくい）
- コンソールへの過去ログ自動表示（起動直後から履歴が見えるようにする）
- 要件明確化フェーズの追加（プロンプト生成前にClaudeが不明点を質問する）

優先度 **中**：
- 自動テスト → 失敗時の自動修正ループ
- GitHub Issue連携（Webhook自動検知・実行）
- PR自動作成

優先度 **低**（将来対応）：
- GitHub OAuth認証
- ファイルアップロード（Excel/Word → HTML変換）
- Cloudflare Tunnel による外部公開

### 設計上の決定事項（変更しない理由）

**`generate_prompt` はエージェントモードで動作する**

プロンプト生成フェーズでも Claude Code CLI をエージェントモード（`--dangerously-skip-permissions`）で実行しています。
対象プロジェクトのファイル数が1万以上になるため、事前にファイル内容を埋め込む方式は不可能です。
Claude が指示の内容に応じて関連ファイルを自分で選択して読み込み、その内容を踏まえたプロンプトを生成するためにエージェントモードが必須です。
`-p`（テキスト生成専用）モードに変更するとファイルを読めなくなり、大規模プロジェクトで機能しなくなります。

**ストリーミングは同期ブロッキング方式**

`execute_command_stream` は docker-py の同期 API をそのまま使っており、`asyncio.sleep(0.01)` で疑似的に非同期化しています。
複数タスクを同時実行すると他のリクエストが遅延します。
現在はシングルユーザー用途であるため許容範囲としています。
マルチユーザー対応時には `run_in_executor` でスレッドプールに移譲する対応が必要です。

## 技術スタック

- **バックエンド**: Python 3.11 + FastAPI + SQLAlchemy 2.0
- **データベース**: PostgreSQL 16
- **コンテナ管理**: docker-py
- **WebSocket**: FastAPI WebSocket
- **フロントエンド**: React 18 + Vite + TypeScript
- **AI実行**: Claude Code CLI（Max Planのサブスクリプションを使用）

---

## 🚀 クイックスタート（初回セットアップ）

### リポジトリのクローン

任意のディレクトリで以下を実行します：

```bash
git clone git@github.com:k-amano/karakuri.git
cd karakuri
```

以降の手順はすべて `karakuri/` ディレクトリ内で実行します。

---

### 動作条件

| 条件 | 確認コマンド |
|---|---|
| Docker 20.10以上 | `docker --version` |
| Python 3.11以上 | `python3 --version` |
| Node.js 18以上 | `node --version` |
| Claude Code CLI（認証済み） | `claude --version` |
| Claude Max Plan | — |
| GitHubのSSH鍵（設定済み） | `ssh -T git@github.com` |

**Claude Code CLI と Max Plan について**

Karakuri は AI との通信に Claude Code CLI を使います。ログイン済みの認証情報（`~/.claude/`）をコンテナにマウントして使用するため、APIキーの設定は不要です。Max Plan のサブスクリプションがあれば追加費用なく動作します。

Claude Code CLI のインストールとログインがまだの場合は https://claude.ai/download を参照してください。

**SSH鍵について**

ホストの `~/.ssh/` をコンテナにマウントするため、ホストで設定済みのSSH鍵がそのままコンテナ内で使えます。GitHubへのSSH鍵登録がまだの場合は GitHub の設定ページ（Settings → SSH and GPG keys）で登録してください。

---

### ステップ1: 環境変数の設定

```bash
cp .env.example backend/.env
```

`backend/.env` の内容（デフォルトのままでOK）：

```env
DATABASE_URL=postgresql+asyncpg://karakuri:karakuri@localhost:5433/karakuri
DEV_AUTH_TOKEN=dev-token-12345
WORKSPACE_IMAGE=karakuri-workspace:latest
```

> `ANTHROPIC_API_KEY` の設定は不要です。Claude Code CLIがMax Planのサブスクリプションを使用します。

---

### ステップ2: データベースの起動

PostgreSQL は Docker Compose で起動します。**PostgreSQL を別途インストールする必要はありません。**

```bash
docker compose up -d db
docker compose ps
# karakuri-db が "Up (healthy)" になればOK
```

---

### ステップ3: バックエンドのセットアップ

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles
alembic upgrade head
cd ..
```

---

### ステップ4: Dockerワークスペースイメージのビルド

```bash
docker build -t karakuri-workspace:latest ./docker/workspace/
```

> ビルドには5〜10分かかります。

---

### ステップ5: フロントエンドの依存パッケージをインストール

```bash
cd frontend
npm install
cd ..
```

---

### ステップ6: バックエンドを起動

```bash
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

### ステップ7: フロントエンドを起動（別ターミナル）

```bash
cd frontend
npm run dev
```

ブラウザで `http://localhost:5173` を開く。

---

## 📖 使い方

### 基本フロー

1. ブラウザで `http://localhost:5173` を開く
2. **「新しいタスク」** をクリックし、GitリポジトリURL（SSH形式）とブランチ名を入力してタスクを作成
   - URL形式: `git@github.com:ユーザー名/リポジトリ名.git`
3. ステータスが `initializing` → `idle` になるまで待つ（30秒〜1分）
4. 指示欄に日本語で簡潔な指示を入力して **「プロンプトを生成」** をクリック
5. AIがワークスペースを分析して最適なプロンプトを生成する
6. 確認画面でプロンプトを確認し、不満があれば指摘を書いて **「再生成」**、よければ **「確定して実行」**
7. ログエリアにClaude Code CLIの出力がリアルタイムで表示され、完了後に自動コミットされる
8. タスク詳細画面の **「Git Push」** ボタンをクリックしてGitHubへ保存する

### Swagger UI（APIドキュメント）

`http://localhost:8000/docs` — 全エンドポイントをブラウザから試せます。

認証: 右上の **「Authorize」** → `dev-token-12345` を入力。

---

## 🔄 日常的な使用（2回目以降）

```bash
# 0. プロジェクトディレクトリに移動
cd karakuri   # クローン先のディレクトリ名

# 1. データベースを起動
docker compose up -d db

# 2. バックエンドを起動（ターミナルA）
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 3. フロントエンドを起動（ターミナルB）
cd frontend && npm run dev

# 4. ブラウザで開く
# http://localhost:5173

# 5. 使い終わったら
# Ctrl+C でバックエンド・フロントエンドを停止
docker compose down
```

---

## 📊 主要なAPIエンドポイント

### リポジトリ管理
- `GET /api/v1/repositories` - リポジトリ一覧
- `POST /api/v1/repositories` - リポジトリ登録
- `DELETE /api/v1/repositories/{id}` - リポジトリ削除

### タスク管理
- `GET /api/v1/tasks` - タスク一覧
- `POST /api/v1/tasks` - タスク作成（Dockerコンテナ自動起動）
- `GET /api/v1/tasks/{id}` - タスク詳細
- `POST /api/v1/tasks/{id}/stop` - タスク停止
- `POST /api/v1/tasks/{id}/git/push` - ブランチをGitHubへpush（ストリーミング）
- `DELETE /api/v1/tasks/{id}` - タスク削除

### Claude Code実行
- `POST /api/v1/tasks/{id}/instructions/execute-stream` - 指示実行（ストリーミング）
- `GET /api/v1/tasks/{id}/instructions` - 指示履歴

### テスト実行
- `POST /api/v1/tasks/{id}/test-runs` - テスト実行
- `GET /api/v1/tasks/{id}/test-runs` - テスト履歴

### ログ
- `GET /api/v1/tasks/{id}/logs` - ログ履歴
- `WS /api/v1/ws/tasks/{id}/logs` - リアルタイムログ（WebSocket）
- `WS /api/v1/ws/tasks/{id}/status` - ステータス更新（WebSocket）

---

## 🏗️ アーキテクチャ

### タスクのライフサイクル

```
1. PENDING      → タスク作成、コンテナ起動待ち
2. INITIALIZING → コンテナ起動中、git clone中
3. IDLE         → 待機中（指示入力待ち）
4. RUNNING      → Claude Code実行中
5. TESTING      → テスト実行中
6. COMPLETED    → 完了
7. FAILED       → 失敗
8. STOPPED      → 手動停止
```

### バックエンド構造

```
backend/app/
├── main.py          # FastAPIアプリ、ルーター登録
├── config.py        # 設定管理（.env読み込み）
├── database.py      # 非同期SQLAlchemyエンジン
├── models/          # SQLAlchemy ORMモデル
├── schemas/         # Pydanticスキーマ
├── api/             # FastAPIルーター
├── services/
│   ├── docker_service.py  # コンテナライフサイクル管理
│   ├── claude_service.py  # Claude Code CLI実行
│   └── test_service.py    # テスト実行・結果解析
└── websocket/
    └── manager.py   # タスク別WebSocket接続プール
```

---

## 🛠️ トラブルシューティング

### データベース接続エラー

```bash
docker compose ps          # コンテナが起動しているか確認
docker compose up -d db    # 停止していれば起動
```

### Claude Code CLIが見つからない

コンテナ内でclaudeコマンドが見つからない場合、ワークスペースイメージを再ビルドします：

```bash
docker build --no-cache -t karakuri-workspace:latest ./docker/workspace/
```

### Claude Code CLIの認証エラー

ホストマシンでClaude Code CLIが認証済みか確認します：

```bash
claude --version   # バージョンが表示されれば認証済み
ls ~/.claude/      # 認証情報ファイルが存在することを確認
```

### GitHubへのpushが失敗する

SSH認証が通っているか確認します：

```bash
ssh -T git@github.com
# Hi username! と表示されれば認証済み
```

認証が通らない場合、SSH鍵がGitHubに登録されていない可能性があります。GitHub の Settings → SSH and GPG keys で登録してください。

### タスク削除が失敗する

バックエンドのログでエラー内容を確認し、必要に応じてコンテナを手動で削除します：

```bash
docker rm -f karakuri-task-{タスクID}
```

---

## 📁 プロジェクト構造

```
karakuri/
├── backend/                    # FastAPIバックエンド
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── api/
│   │   ├── services/
│   │   └── websocket/
│   ├── alembic/
│   └── venv/
├── frontend/                   # React + Vite + TypeScript
│   └── src/
│       ├── pages/
│       ├── components/
│       └── store/
├── docker/
│   └── workspace/              # Claude Code実行環境（Dockerfile）
├── docs/                       # ドキュメント
├── docker-compose.yml
└── .env.example
```

---

## ❓ よくある質問

**Q: Anthropic APIキーは必要ですか？**
A: いいえ。Claude Code CLIがホストの `~/.claude/` 認証情報を使用するため、APIキーは不要です。Claude Max Planのサブスクリプションがあれば使えます。

**Q: 複数のタスクを同時に実行できますか？**
A: はい、各タスクが独立したDockerコンテナで動作します。

**Q: 生成されたファイルはどこに保存されますか？**
A: 各タスクのDockerコンテナ内の `/workspace/repo/` に保存されます。`docker cp` コマンドで取り出せます。

**Q: コンテナが残り続けますが？**
A: タスク削除時に自動削除されます。手動で削除する場合は `docker rm -f karakuri-task-X`

---

## 📝 ライセンス

MIT
