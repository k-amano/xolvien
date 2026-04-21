# 改修履歴

---

## 2026-04-21

### テスト結果サマリー表示・修正UI改善（H2・H3）

**変更内容:**

- フロントエンド `TaskDetail.tsx`：実装確認パネルにテスト結果サマリーバナーを追加（H2）
  - テスト完了後および再開時に passed / failed 件数を緑 / 赤バナーで表示
  - `testResultSummary` state で管理し、テスト完了時とページロード時の両方でセット

- フロントエンド `TaskDetail.tsx`：テストケース修正UIを `window.prompt` からインライン入力欄に変更（H3）
  - 「修正を依頼」ボタンでパネル内にテキストエリア + 送信 / キャンセルボタンをトグル表示
  - 送信するとテストケースを再生成。キャンセルで入力欄を閉じる

---

## 2026-04-19

### コンテナ自動再起動・ステップバー改善・文字化け修正

**概要**: 翌日に続きから作業できない問題の修正、ステップバーのUI改善、ストリーミング文字化けの修正。

**変更内容:**

- バックエンド `docker_service.py`：`ensure_container_running()` メソッドを追加
  - `execute_command()` / `execute_command_stream()` の実行前にコンテナの状態を確認し、停止していれば自動で再起動する
  - これにより、`docker compose down` で停止した翌日でもタスクを作り直さずに続きから操作できる

- バックエンド `docker_service.py`：ストリーミングのUTF-8文字化けを修正（H1）
  - `chunk.decode("utf-8", errors="replace")` を `codecs.getincrementaldecoder` に変更
  - チャンク境界でマルチバイト文字が分割されても正しく結合してからデコードする

- フロントエンド `TaskDetail.tsx`：ステップバーのUI改善
  - 選択中のステップを黄色背景・黒テキストで強調表示
  - `テストケース` と `単体テスト` の2ステップを `単体テスト` 1ステップに統合（動作の違いがなかったため）
  - ステップバーのボタンからテスト結果件数の表示を削除（操作ボタンに情報を混在させない）
  - ページロード時の自動再開でも着地したステップが選択状態で表示される

---

## 2026-04-14

### 前回の続きから再開（ステップバー）

**概要**: タスク詳細画面にステップバーを追加し、完了済みのステップから再開できるようにした。

**変更内容:**
- フロントエンド `TaskDetail.tsx` にステップバーUI（実装 → テストケース → 単体テスト → 結合テスト* → E2Eテスト* → 実装確認）を追加
- ページロード時に `GET /instructions/last-completed` と `GET /test-runs` でDB履歴を取得し、ステップ状態を復元
- 完了済みステップをクリックするとその画面に切り替わる。「実装」ステップは前回の指示を入力欄に復元する
- 旧バナー方式（`isResumed` フラグ + 青いバナー）を廃止
- バックエンド `instructions.py` に `GET /last-completed` エンドポイントを追加

---

## 2026-04-12

### フェーズ1：単体テスト自動化

**概要**: テストケース生成・単体テスト実行・自動修正ループを実装した。

**変更内容:**
- バックエンド `claude_service.py` に `generate_test_cases()`、`run_unit_tests()` を追加
  - テストコマンドはClaude Agentが `package.json` / `pyproject.toml` 等から自動判断
  - pytest未インストール時はClaude Agentが依存パッケージのインストールから実施
  - 自動修正ループ：最大3回。失敗テスト名・エラーメッセージ・標準出力をフィードバック
  - テストレポートを `/workspace/repo/test-reports/test-report-{日時}-unit.md` に保存
- バックエンド `instructions.py` に以下のエンドポイントを追加
  - `POST /generate-test-cases`（ストリーミング）
  - `POST /run-unit-tests`（ストリーミング）
- DBマイグレーション：`TestRun` モデルに `test_type`（UNIT/INTEGRATION/E2E）、`test_cases`、`retry_count`、`report_path` カラムを追加
- フロントエンドにテストケース確認パネル・実装確認パネルを追加
- `PromptState` を拡張：`test_cases` / `running_tests` / `reviewing` を追加

---

## 2026-04-07（推定）

### MVP 初期実装

**概要**: バックエンド・フロントエンドの基本機能を一通り実装した。

**変更内容:**
- バックエンド全機能実装（Docker管理、タスク/リポジトリ API、Claude Code実行、WebSocketログ配信、DB永続化）
- フロントエンド全機能実装（ダッシュボード、タスク作成、タスク詳細、ログビューア、要件確認フロー、プロンプト確認）
- `claude_service.py` の Claude Code実行をシミュレーションから実際のCLI（`--dangerously-skip-permissions` モード）に切り替え
- プロジェクト名を karakuri → Xolvien に変更
