# Karakuri はじめてガイド
## 〜 翻訳アプリを作るまで 〜

このガイドでは、Karakuri を初めて使う方が、セットアップから翻訳アプリを完成させるところまでを手順通りに説明します。書いてある通りに操作すれば、実際に動く翻訳アプリが出来上がります。

---

## 所要時間の目安

| フェーズ | 時間 |
|---|---|
| 初回セットアップ | 15〜20分 |
| 起動 | 1〜2分 |
| 翻訳アプリ作成 | 5〜10分 |

---

# フェーズ1：初回セットアップ（最初の1回だけ）

## 手順1｜環境変数ファイルを作る

ターミナルを開き、以下を1行ずつ実行してください。

```bash
cd /home/administrator/Projects/karakuri
cp .env.example backend/.env
```

次に `.env` ファイルを開きます。

```bash
nano backend/.env
```

ファイルの中に以下の行があります。

```
ANTHROPIC_API_KEY=your-api-key-here
```

`your-api-key-here` の部分を、あなたの Anthropic API キーに書き換えます。

```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxx...（実際のキー）
```

書き換えたら保存します（`Ctrl+O` → `Enter` → `Ctrl+X`）。

---

## 手順2｜データベースを起動する

```bash
cd /home/administrator/Projects/karakuri
docker compose up -d db
```

起動を確認します。

```bash
docker compose ps
```

以下のように `healthy` と表示されれば OK です。

```
NAME          STATUS
karakuri-db   Up (healthy)
```

`healthy` になるまで10〜20秒かかることがあります。表示が違う場合は少し待ってから再度実行してください。

---

## 手順3｜バックエンドをセットアップする

以下を上から順に実行してください。

```bash
cd /home/administrator/Projects/karakuri/backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles anthropic
alembic upgrade head
```

最後に以下のように表示されれば OK です。

```
INFO  [alembic.runtime.migration] Running upgrade  -> xxxx, Initial migration
```

---

## 手順4｜Docker ワークスペースイメージをビルドする

Karakuri がコードを動かすための Docker イメージを作ります。**5〜10分かかります。**

```bash
cd /home/administrator/Projects/karakuri
docker build -t karakuri-workspace:latest ./docker/workspace/
```

最後に以下のように表示されれば OK です。

```
Successfully tagged karakuri-workspace:latest
```

---

## 手順5｜フロントエンドの依存パッケージをインストールする

```bash
cd /home/administrator/Projects/karakuri/frontend
npm install
```

---

# フェーズ2：起動する（毎回行う）

ターミナルウィンドウを **2つ** 用意します。

### ターミナル A（バックエンド）

```bash
cd /home/administrator/Projects/karakuri
docker compose up -d db
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

以下が表示されれば起動成功です。このターミナルは開いたままにします。

```
INFO:     Application startup complete.
```

### ターミナル B（フロントエンド）

```bash
cd /home/administrator/Projects/karakuri/frontend
npm run dev
```

以下が表示されれば起動成功です。このターミナルも開いたままにします。

```
  VITE v5.x.x  ready in xxx ms
  ➜  Local:   http://localhost:5173/
```

ブラウザで **http://localhost:5173** を開くと、Karakuri の画面が表示されます。

---

# フェーズ3：翻訳アプリを作る

ここからはすべてブラウザ上の操作です。

---

## 手順6｜新しいタスクを作成する

画面右上の **「新しいタスク」** ボタンをクリックします。

タスク作成画面が表示されます。

### リポジトリを設定する

「新しいリポジトリを追加」タブをクリックし、以下を入力します。

| 項目 | 入力値 |
|---|---|
| リポジトリ URL | `https://github.com/octocat/Hello-World.git` |
| リポジトリ名 | `hello-world` |
| 説明 | （空白でOK） |

### タスクの詳細を設定する

| 項目 | 入力値 |
|---|---|
| タイトル | `翻訳アプリを作る` |
| ブランチ名 | `main` |
| 説明 | （空白でOK） |

すべて入力したら **「タスクを作成」** ボタンをクリックします。

---

## 手順7｜コンテナの準備が完了するまで待つ

タスクを作成すると、自動的にタスク詳細画面に移動します。

画面上部にタスクの状態（ステータス）が表示されます。

```
pending → initializing → idle
```

**「idle」** になるまで待ちます。30秒〜1分程度かかります。ページを更新する必要はありません。自動で更新されます。

ログエリア（画面の黒い部分）に以下のようなメッセージが流れれば準備完了です。

```
[docker] Workspace container ready: karakuri-task-1
```

> **ポイント**: ステータスが「idle」になって初めて、Claudeへの指示ができるようになります。

---

## 手順8｜Claudeに翻訳アプリを作るよう指示する

画面下部の入力欄に以下をコピーして貼り付けます。

```
日本語と英語を相互に翻訳できる、シンプルな1ページのWebアプリを作ってください。

要件：
- ファイル名は translator.html とすること
- 日本語の入力欄と英語の入力欄を縦に並べる
- 「英語に翻訳」ボタンと「日本語に翻訳」ボタンを設置する
- 翻訳には https://api.mymemory.translated.net を使うこと（APIキー不要）
- HTML・CSS・JavaScriptをひとつのファイルにまとめること
- デザインはシンプルで見やすくすること
```

入力欄の右下にある **「実行」** ボタンをクリックします（または `Ctrl+Enter`）。

---

## 手順9｜生成を待つ

ログエリアに Claude の出力がリアルタイムで流れてきます。

```
[SYSTEM] 指示を受け付けました
[SYSTEM] ワークスペース確認完了

[Claude] コードを生成しています...

=== FILE: translator.html ===
<!DOCTYPE html>
...
=== END FILE ===

[SYSTEM] ファイルをワークスペースに書き込んでいます...
[SYSTEM] 1 個のファイルを作成しました:
  ✓ translator.html
[SYSTEM] 完了しました
```

**「完了しました」** と表示されれば生成完了です。ステータスが再び「idle」に戻ります。

> 生成には1〜3分かかります。ログが流れている間はそのまま待ちます。

---

## 手順10｜生成されたファイルを取り出す

生成されたファイルはDockerコンテナの中に保存されています。コンテナからファイルを取り出します。

まず、コンテナ名を確認します。タスク詳細画面の上部に表示されています（例：`karakuri-task-1`）。

ターミナルで以下を実行します（`karakuri-task-1` の部分は実際のコンテナ名に変えてください）。

```bash
docker cp karakuri-task-1:/workspace/repo/translator.html ~/Desktop/translator.html
```

> デスクトップに保存します。保存先は任意で変えて構いません。

---

## 手順11｜翻訳アプリを開いて動かす

ファイルマネージャーでデスクトップの `translator.html` をダブルクリックするか、ブラウザに直接ドラッグ&ドロップします。

翻訳アプリが表示されます。

### 動作確認

1. 日本語の入力欄に `こんにちは、世界` と入力します
2. **「英語に翻訳」** ボタンをクリックします
3. 英語の入力欄に `Hello, World` と表示されれば成功です

今度は逆方向を試します。

1. 英語の入力欄に `I love programming` と入力します
2. **「日本語に翻訳」** ボタンをクリックします
3. 日本語の入力欄に翻訳結果が表示されれば成功です

---

# 完成！

これで Karakuri を使って翻訳アプリを作ることができました。

Karakuri でできることはこれだけではありません。同じ手順で、Claude に別の指示を出せば別のアプリも作れます。たとえば：

- `簡単な計算機アプリを calculator.html という名前で作ってください`
- `TODO リストアプリを todo.html という名前で作ってください`
- `既存のコードにダークモードを追加してください`

---

# 毎回の起動・終了

## 起動手順（2回目以降）

```bash
# ターミナル A
cd /home/administrator/Projects/karakuri
docker compose up -d db
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# ターミナル B
cd /home/administrator/Projects/karakuri/frontend
npm run dev
```

## 終了手順

```bash
# ターミナル A, B でそれぞれ Ctrl+C を押す

# データベースを停止
cd /home/administrator/Projects/karakuri
docker compose down
```

---

# トラブルシューティング

## ステータスが「failed」になった

タスクのログエリアにエラーの詳細が表示されています。

よくある原因：
- **ブランチ名が間違っている** → タスクを削除して作り直す。ブランチ名を `master` に変えて試す
- **Docker イメージがない** → 手順4のイメージビルドを実行する

タスクを削除するにはダッシュボード画面のタスクカードにある **「削除」** ボタンをクリックします。

## ステータスが「pending」のまま変わらない

バックエンドが起動しているか確認します。

```bash
curl http://localhost:8000/health
```

`{"status":"healthy"}` が返ってくれば起動しています。返ってこない場合はターミナルAの手順をやり直します。

## 「実行」ボタンが押せない

ステータスが「idle」のときだけ実行できます。「pending」や「initializing」はコンテナの準備中なので待ちます。

## `docker cp` でエラーが出た

コンテナ名が違う可能性があります。以下でコンテナ名を確認します。

```bash
docker ps --filter "name=karakuri-task"
```

表示されたコンテナ名を使って `docker cp` を実行します。

## Claude が `translator.html` を生成しなかった

指示の内容によっては別のファイル名で生成されることがあります。コンテナの中を確認します。

```bash
docker exec karakuri-task-1 ls /workspace/repo/
```

表示されたファイル名を使って `docker cp` を実行します。
