# Xolvien

Docker コンテナと Claude Code CLI を使い、コード生成・テスト・Git 操作を自動化する AI 駆動開発プラットフォームです。

[English README](README.md)

---

## 何ができるか

Xolvien は GitHub Actions + Claude Code 開発の以下の課題を解決します：

- **ローカル実行**: 隔離された Docker コンテナ内でビルド・テストを実行 — CI だけのフィードバックループから脱却
- **ブランチ継続性**: 1つのタスクの作業は、セッションをまたいでも同じブランチに蓄積
- **自分の名前でコミット**: Claude 名義ではなく、あなたの Git アイデンティティでコミット

---

## 使い方の流れ

1. 日本語または英語で簡潔な指示を入力
2. Claude が不明点を質問（スキップ可）
3. Claude が最適化されたプロンプトを生成 — あなたが承認
4. Claude が実装してコミット
5. Claude がテストケース一覧を生成 — あなたが確認・承認
6. Claude がテストコードを生成 → 単体テスト実行 → 失敗時は自動修正（最大3回）
7. あなたが実装を確認 → 承認 / 差し戻し
8. GitHub へ Git Push

タスクごとに独立した Docker コンテナとボリュームが割り当てられるため、複数のタスクが干渉しません。

---

## 技術スタック

| 領域 | 技術 |
|---|---|
| バックエンド | Python 3.11 + FastAPI + SQLAlchemy 2.0（async） |
| データベース | PostgreSQL 16（Docker Compose 経由） |
| コンテナ管理 | docker-py |
| AI 実行 | Claude Code CLI（Max Plan、エージェントモード） |
| フロントエンド | React 18 + Vite + TypeScript |
| リアルタイムログ | WebSocket（FastAPI） |

---

## 動作条件

| 条件 | 確認コマンド |
|---|---|
| Docker 20.10以上 | `docker --version` |
| Python 3.11以上 | `python3 --version` |
| Node.js 18以上 | `node --version` |
| Claude Code CLI（認証済み） | `claude --version` |
| Claude Max Plan | — |
| GitHub SSH 鍵（設定済み） | `ssh -T git@github.com` |

Anthropic API キーは不要です。Claude Code CLI が Max Plan のサブスクリプションを使用します。

---

## クイックスタート

```bash
# 1. クローン
git clone git@github.com:k-amano/xolvien.git
cd xolvien

# 2. 環境変数ファイルを作成
cp .env.example backend/.env

# 3. データベースを起動
docker compose up -d db

# 4. バックエンドをセットアップ
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles \
    openpyxl python-docx pdfplumber
alembic upgrade head
cd ..

# 5. ワークスペースイメージをビルド（5〜10分）
docker build -t xolvien-workspace:latest ./docker/workspace/

# 6. フロントエンドをセットアップ
cd frontend && npm install && cd ..

# 7. バックエンドを起動（ターミナルA）
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 8. フロントエンドを起動（ターミナルB）
cd frontend && npm run dev
```

ブラウザで `http://localhost:5173` を開きます。

詳細な手順は [docs/getting-started.md](docs/getting-started.md) を参照してください。

---

## 日常的な起動手順

```bash
docker compose up -d db
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# （別のターミナルで）
cd frontend && npm run dev
```

---

## API リファレンス

Swagger UI: `http://localhost:8000/docs`

認証: `Authorization: Bearer dev-token-12345`

---

## プロジェクト構造

```
xolvien/
├── backend/app/
│   ├── api/             # FastAPI ルーター
│   ├── models/          # SQLAlchemy ORM モデル
│   ├── schemas/         # Pydantic スキーマ
│   └── services/
│       ├── claude_service.py   # Claude Code CLI 実行・テスト自動化
│       ├── docker_service.py   # コンテナライフサイクル管理
│       └── test_service.py     # テスト結果パース
├── frontend/src/
│   ├── pages/TaskDetail.tsx    # メイン UI（ステップバー・プロンプトフロー・テストパネル）
│   └── services/api.ts         # API クライアント
├── docker/workspace/           # ワークスペース Docker イメージ
└── docs/
    ├── spec.md                 # 現行仕様
    ├── changelog.md            # 改修履歴
    ├── roadmap.md              # 改修計画
    └── getting-started.md      # 操作マニュアル
```

---

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/spec.md](docs/spec.md) | 現行仕様（データモデル・API・UI フロー） |
| [docs/changelog.md](docs/changelog.md) | 改修履歴 |
| [docs/roadmap.md](docs/roadmap.md) | 改修計画・改善バックログ |
| [docs/getting-started.md](docs/getting-started.md) | 操作マニュアル（初回セットアップから使い方まで） |

---

## ライセンス

MIT
