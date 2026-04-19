# Xolvien — 現行仕様

**最終更新**: 2026-04-19

本書は現時点で実装済みの仕様を記録する。未実装の将来機能は `roadmap.md` に記載する。

---

## 1. システム概要

### 1.1 目的

GitHub Actions + Claude Code による AI 駆動開発の以下の課題を解決する：

- リポジトリ上の操作のみで、ローカルでのビルド・テスト等の動作確認ができない
- 修正のたびに master から新しいブランチが作成され、同一ブランチでの継続的な修正ができない
- すべてのコミットが Claude 名義になり、開発担当者の名前でコミットできない

### 1.2 利用者

当面は個人（1名）での利用を想定。マルチユーザー対応は roadmap に記載。

### 1.3 技術スタック

| 領域 | 技術 |
|---|---|
| バックエンド | Python 3.11 + FastAPI + SQLAlchemy 2.0（async） |
| データベース | PostgreSQL 16（Docker Compose で起動） |
| コンテナ管理 | docker-py |
| AI 実行 | Claude Code CLI（Max Plan、`--dangerously-skip-permissions` モード） |
| フロントエンド | React 18 + Vite + TypeScript |
| リアルタイム通信 | WebSocket（FastAPI） |
| 認証 | Bearer トークン固定（`dev-token-12345`） |

---

## 2. データモデル

### 2.1 エンティティ関係

```
User ──< Repository ──< Task ──< Instruction
                              └──< TestRun
                              └──< TaskLog
```

### 2.2 Task ステータス遷移

```
PENDING → INITIALIZING → IDLE → RUNNING → TESTING → COMPLETED
                                                   → FAILED
                                                   → STOPPED
```

### 2.3 主要テーブル定義

**tasks**

| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| repository_id | INTEGER FK | |
| title | VARCHAR | タスクのタイトル |
| branch_name | VARCHAR | 作業ブランチ名 |
| status | ENUM | PENDING / INITIALIZING / IDLE / RUNNING / TESTING / COMPLETED / FAILED / STOPPED |
| container_id | VARCHAR | Docker コンテナ ID |
| container_name | VARCHAR | Docker コンテナ名 |
| workspace_path | VARCHAR | コンテナ内ワークスペースパス（`/workspace`） |

**instructions**

| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| content | TEXT | 実行したプロンプト |
| status | ENUM | PENDING / RUNNING / COMPLETED / FAILED |
| output | TEXT | Claude の出力 |
| exit_code | INTEGER | |

**test_runs**

| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| test_type | ENUM | UNIT / INTEGRATION / E2E |
| status | ENUM | PENDING / RUNNING / PASSED / FAILED |
| test_cases | TEXT | 承認済みテストケース（Markdown） |
| retry_count | INTEGER | 自動修正の実施回数 |
| report_path | VARCHAR | テストレポートのパス |
| passed_count | INTEGER | |
| failed_count | INTEGER | |

**task_logs**

| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| source | ENUM | SYSTEM / DOCKER / CLAUDE / GIT / TEST |
| message | TEXT | |

---

## 3. API エンドポイント

### 3.1 エンドポイント一覧

```
GET  /health
GET  /docs  (Swagger UI)

# リポジトリ管理
GET    /api/v1/repositories
POST   /api/v1/repositories
GET    /api/v1/repositories/{id}
PATCH  /api/v1/repositories/{id}
DELETE /api/v1/repositories/{id}

# タスク管理
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/{id}
PATCH  /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}/stop
DELETE /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}/git/push          ← ストリーミング

# 指示・実行
POST /api/v1/tasks/{id}/instructions
POST /api/v1/tasks/{id}/instructions/execute-stream       ← ストリーミング
POST /api/v1/tasks/{id}/instructions/clarify              ← ストリーミング
POST /api/v1/tasks/{id}/instructions/generate-prompt      ← ストリーミング
POST /api/v1/tasks/{id}/instructions/generate-test-cases  ← ストリーミング
POST /api/v1/tasks/{id}/instructions/run-unit-tests       ← ストリーミング
GET  /api/v1/tasks/{id}/instructions
GET  /api/v1/tasks/{id}/instructions/{instruction_id}
GET  /api/v1/tasks/{id}/instructions/last-completed

# テスト
POST /api/v1/tasks/{id}/test-runs
GET  /api/v1/tasks/{id}/test-runs
GET  /api/v1/tasks/{id}/test-runs/{run_id}

# ログ
GET /api/v1/tasks/{id}/logs
WS  /api/v1/ws/tasks/{id}/logs    ← WebSocket
WS  /api/v1/ws/tasks/{id}/status  ← WebSocket
```

### 3.2 認証

すべてのエンドポイントで `Authorization: Bearer dev-token-12345` ヘッダーが必要。

---

## 4. 実行フロー

### 4.1 新規作成フロー（現在の実装）

```
1. 指示入力
2. 要件確認（Claude ↔ ユーザー）← スキップ可
3. プロンプト確認 → ユーザーが承認
4. Claude が実装を実行（コミットまで自動）
5. Claude がテストケース一覧を自動生成（Markdown 形式）
6. ユーザーがテストケースを確認・編集 → 承認
7. Claude がテストコードを生成 → 単体テスト実行
8. 失敗した場合は自動修正ループ（最大3回）
9. ユーザーが実装を確認 → 承認 / 差し戻し
10. Git Push
```

### 4.2 ユーザー確認ポイント

| タイミング | 確認内容 | 承認後の動作 | 差し戻し時の動作 |
|---|---|---|---|
| ステップ3 | プロンプトが意図通りか | 実装開始 | 指示を修正して再生成 |
| ステップ6 | テストケースが網羅的か | テストコード生成・実行 | テストケースを修正して再承認 |
| ステップ9 | 実装が意図通りか | コミット確定 → 次フェーズ or Push | 指示入力に戻る（前回指示を復元） |

### 4.3 セッション再開

タスク詳細画面を開いたとき、DB から `TestRun` 履歴と最後に完了した `Instruction` を取得し、ステップバーに状態を反映する。完了済みの最後のステップの次の画面に自動移動する。

ステップバーの各ステップは、完了済みであればクリックして直接移動できる。

---

## 5. フロントエンド UI

### 5.1 画面構成

| 画面 | 説明 |
|---|---|
| ダッシュボード | タスク一覧。ステータスバッジ、作成ボタン |
| タスク作成モーダル | リポジトリ選択（既存 / 新規登録）、タイトル・ブランチ名入力 |
| タスク詳細画面 | 左右分割ペイン（ログエリア / 操作パネル）、リサイズ可能 |

### 5.2 操作パネルのステート遷移（PromptState）

```
idle
  ↓「要件を確認する」
clarifying（要件確認 Q&A）
  ↓ 十分な情報が揃ったら自動移行、またはスキップ
generating（プロンプト生成中）
  ↓
confirming（プロンプト確認・承認）
  ↓「確定して実行」
  ↓ 実行完了後に自動移行
test_cases（テストケース確認）
  ↓「承認してテスト実行」
running_tests（テスト実行中）
  ↓ 完了後に自動移行
reviewing（実装確認）
  ↓「承認」→ idle
  ↓「差し戻し」→ idle（前回指示を入力欄に復元）
```

### 5.3 ステップバー

操作パネルの上部に常時表示。ステップ：実装 → 単体テスト → 結合テスト* → E2Eテスト* → 実装確認

| 表示色 | 意味 |
|---|---|
| 緑（合格件数付き） | 完了（テスト成功） |
| 赤 | 完了（テスト失敗） |
| 青（太字） | 現在のステップ |
| グレー | 未実施 |
| グレー斜体（\*付き） | 未実装の将来ステップ |

---

## 6. バックエンド設計

### 6.1 ディレクトリ構成

```
backend/app/
├── main.py          # FastAPI アプリ、ルーター登録、CORS
├── config.py        # Pydantic Settings（.env 読み込み）
├── database.py      # 非同期 SQLAlchemy エンジン + get_db()
├── models/          # SQLAlchemy ORM モデル
├── schemas/         # Pydantic リクエスト/レスポンス スキーマ
├── api/             # FastAPI ルーター（リソースごとに1ファイル）
├── services/
│   ├── docker_service.py   # コンテナライフサイクル管理
│   ├── claude_service.py   # Claude Code CLI 実行・テスト実行
│   └── test_service.py     # テスト結果パース
└── websocket/
    └── manager.py          # タスク別 WebSocket 接続プール
```

### 6.2 ClaudeCodeService の主要メソッド

| メソッド | 説明 |
|---|---|
| `execute_instruction()` | 任意の指示を Claude Agent で実行。AsyncGenerator でログを yield |
| `clarify_requirements()` | 要件確認 Q&A。不明点を質問、十分な情報が揃ったら終了 |
| `generate_prompt()` | 簡潔な指示を最適化されたプロンプトに変換 |
| `generate_test_cases()` | 実装プロンプトからテストケース一覧（Markdown）を生成 |
| `run_unit_tests()` | テストコード生成 → 実行 → 自動修正ループ（最大3回） |
| `_detect_test_command()` | pytest 等が実際にインストール済みか確認。未インストールは None を返す |

### 6.3 Docker ワークスペース

- イメージ: `xolvien-workspace:latest`（`docker/workspace/Dockerfile`）
- 構成: Python 3.11-slim + Git + Node.js 18 + Claude Code CLI
- 各タスク専用ボリューム: `xolvien-task-{task_id}-data`（マウント先: `/workspace`）
- SSH 鍵: ホストの `~/.ssh/` をコンテナにマウント（GitHub 認証用）
- Claude 認証情報: ホストの `~/.claude/` をコンテナにマウント

### 6.4 テスト実行の詳細

- Claude Agent がリポジトリの `package.json` / `pyproject.toml` 等からテストコマンドを自動判断
- 依存パッケージの未インストールも Claude Agent が検出してインストール
- テストレポート保存先: `/workspace/repo/test-reports/test-report-{日時}-{種別}.md`
- 自動修正フィードバック: 失敗テスト名・エラーメッセージ・標準出力

### 6.5 設計上の決定事項

**プロンプト生成もエージェントモードで実行する理由**

対象プロジェクトのファイル数が多い場合、事前にファイル内容を埋め込む方式は不可能。Claude Agent がリポジトリ内の関連ファイルを自分で選択して読み込み、それを踏まえたプロンプトを生成するためエージェントモードが必須。`-p` モードに変更するとファイルを読めなくなる。

**ストリーミングは同期ブロッキング方式**

`execute_command_stream` は docker-py の同期 API を使用し、`asyncio.sleep(0.01)` で疑似的に非同期化している。複数タスク同時実行時に他リクエストが遅延するが、シングルユーザー用途のため許容範囲。マルチユーザー対応時は `run_in_executor` でスレッドプールに移譲する。

---

## 7. 既知の制限事項

| 項目 | 内容 |
|---|---|
| 認証 | 固定トークン（`dev-token-12345`）。GitHub OAuth は未実装 |
| 同時実行 | シングルユーザー想定。複数タスク同時実行時はストリーミングが遅延する可能性あり |
| テストレポート形式 | Markdown のみ。Excel 形式は将来対応 |
| コンテナ停止後の再起動 | `docker compose down` 後の再起動時にコンテナが自動再起動する（タスク削除不要） |
| テスト結果表示 | テスト完了後のサマリー（passed/failed 件数）がパネルに表示されない（改善バックログ H2） |
| テストケース修正UI | `window.prompt` を使用中。インライン入力欄への変更が必要（改善バックログ H3） |
