# Karakuri はじめてガイド
## 〜 翻訳アプリを作るまで 〜

このガイドでは、Karakuri を初めて使う方が、セットアップから翻訳アプリを完成させるところまでを説明します。
書いてある通りに操作すれば、実際に動く翻訳アプリが出来上がります。

---

## Karakuri とは

Karakuri は「Claude（クロード）」という AI に日本語で指示を出すと、自動的にプログラムのコードを書いてくれるツールです。プログラミングの知識がなくても、「翻訳アプリを作って」と指示するだけでアプリが完成します。

---

## 所要時間の目安

| 作業 | 時間 |
|---|---|
| 初回セットアップ | 15〜20分 |
| 毎回の起動 | 1〜2分 |
| 翻訳アプリの生成 | 3〜5分 |

初回セットアップは最初の1回だけです。2回目以降は「第2部：起動する」から始めます。

---

# 第1部：初回セットアップ

## 手順1｜Anthropic API キーを取得する

Karakuri が AI（Claude）と通信するためには「API キー」と呼ばれる認証コードが必要です。
Anthropic 社のウェブサイトで取得します。

### 1-1. アカウントを作る

1. ブラウザで **https://console.anthropic.com** を開きます
2. **「Sign up」**（新規登録）または **「Log in」**（既存アカウント）をクリックします
3. メールアドレスとパスワードでアカウントを作成します
4. 登録したメールアドレスに確認メールが届くので、メール内のリンクをクリックします

### 1-2. API キーを作成する

1. ログイン後、左側のメニューから **「API Keys」** をクリックします
2. 右上の **「Create Key」** ボタンをクリックします
3. キーの名前（例：`karakuri`）を入力して **「Create Key」** をクリックします
4. 画面に以下のような長い文字列が表示されます

```
sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789...
```

> ⚠️ **重要**: このキーは今しか表示されません。必ず今コピーしてください。

5. 表示されたキーの右にある **「Copy」** ボタンをクリックしてコピーします
6. コピーした文字列をメモ帳などに一時的に貼り付けて保存しておきます

---

## 手順2｜ターミナルを開いてプロジェクトフォルダに移動する

「ターミナル」はコマンド（命令）を文字で入力してコンピュータを操作するツールです。

- **Windows（WSL）の場合**：スタートメニューで「Ubuntu」を検索して開きます
- **Mac の場合**：Launchpad で「ターミナル」を検索して開きます

ターミナルが開いたら以下を入力して `Enter` を押します。

```bash
cd /home/administrator/Projects/karakuri
```

---

## 手順3｜環境変数ファイルを作る

以下を実行します。

```bash
cp .env.example backend/.env
```

何も表示されなければ成功です。次に `.env` ファイルを開いて編集します。

```bash
nano backend/.env
```

画面が切り替わり、以下のような内容が表示されます。

```
DATABASE_URL=postgresql+asyncpg://karakuri:karakuri@localhost:5433/karakuri
API_HOST=0.0.0.0
API_PORT=8000
FRONTEND_URL=http://localhost:5173
DEV_AUTH_TOKEN=dev-token-12345
DOCKER_SOCKET=/var/run/docker.sock
WORKSPACE_IMAGE=karakuri-workspace:latest
TASK_DATA_PATH=/tmp/karakuri/tasks
ANTHROPIC_API_KEY=your-api-key-here
ENVIRONMENT=development
```

キーボードの **↓ 矢印キー** を押して `ANTHROPIC_API_KEY=your-api-key-here` の行まで移動します。

その行の `your-api-key-here` の部分にカーソルを合わせて、**手順1でコピーした API キー**に書き換えます。

書き換え後の例：
```
ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789...
```

書き換えたら保存して閉じます。
1. `Ctrl` キーを押しながら `O` キーを押します → 画面下部に `File Name to Write:` と表示されます
2. そのまま `Enter` キーを押します → `[ Wrote X lines ]` と表示されます
3. `Ctrl` キーを押しながら `X` キーを押します → ターミナルに戻ります

---

## 手順4｜データベースを起動する

以下を実行します。

```bash
docker compose up -d db
```

以下のように表示されれば OK です。

```
[+] Running 1/1
 ✔ Container karakuri-db  Started                                                                    0.5s
```

次に、データベースが正常に動いているか確認します。

```bash
docker compose ps
```

以下のように表示されます。

```
NAME          IMAGE                COMMAND                  SERVICE   CREATED        STATUS                   PORTS
karakuri-db   postgres:16-alpine   "docker-entrypoint.s…"   db        X minutes ago  Up X minutes (healthy)   0.0.0.0:5433->5432/tcp
```

`STATUS` の列に **`(healthy)`** と書かれていれば OK です。

**`(health: starting)` と表示された場合：** まだ起動中です。20〜30秒待ってから、もう一度 `docker compose ps` を実行してください。

---

## 手順5｜バックエンドをセットアップする

以下を **1行ずつ** 実行してください。1つ実行するたびに完了を確認してから次に進みます。

```bash
cd /home/administrator/Projects/karakuri/backend
```

何も表示されなければ OK です。

```bash
python3 -m venv venv
```

何も表示されなければ OK です。

```bash
source venv/bin/activate
```

実行後、ターミナルの行頭が以下のように変わります。

```
(venv) administrator@owl:~/Projects/karakuri/backend$
```

先頭に `(venv)` が付いていれば OK です。

```bash
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles anthropic
```

たくさんの文字が流れます。1〜3分かかります。最後に以下のように表示されれば OK です。

```
Successfully installed ...（たくさんのパッケージ名）...
```

```bash
alembic upgrade head
```

以下のように表示されれば OK です。

```
INFO  [alembic.runtime.migration] Context impl PostgreSQLImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> xxxxxxxx, Initial migration
```

---

## 手順6｜Docker ワークスペースイメージをビルドする

Karakuri がコードを動かすための専用環境を作ります。**5〜10分かかります。**
たくさんの文字が流れますが、完了まで待ちます。

```bash
cd /home/administrator/Projects/karakuri
```

```bash
docker build -t karakuri-workspace:latest ./docker/workspace/
```

最後に以下のように表示されれば OK です。

```
=> => naming to docker.io/library/karakuri-workspace:latest
```

または

```
Successfully tagged karakuri-workspace:latest
```

---

## 手順7｜フロントエンドの依存パッケージをインストールする

```bash
cd /home/administrator/Projects/karakuri/frontend
```

```bash
npm install
```

文字が流れて、最後に以下のように表示されれば OK です。

```
added XXX packages, and audited XXX packages in Xs
```

---

# 第2部：起動する（毎回行う）

2回目以降はここから始めます。

ターミナルウィンドウを **2つ** 用意します。

---

### ターミナル A：バックエンドを起動する

**新しいターミナルウィンドウを開いて**、以下を順番に実行します。

```bash
cd /home/administrator/Projects/karakuri
```

```bash
docker compose up -d db
```

以下のように表示されれば OK です（すでに起動している場合は `Running` と表示されます）。

```
[+] Running 1/1
 ✔ Container karakuri-db  Started                                                                    0.5s
```

または

```
[+] Running 1/1
 ✔ Container karakuri-db  Running                                                                    0.0s
```

```bash
cd backend
```

```bash
source venv/bin/activate
```

行頭に `(venv)` が付いていれば OK です。

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

以下のように表示されれば起動成功です。このターミナルは **閉じずに** そのままにしておきます。

```
INFO:     Will watch for changes in these directories: ['/home/administrator/Projects/karakuri/backend']
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process [XXXXX] using StatReload
INFO:     Started server process [XXXXX]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

---

### ターミナル B：フロントエンドを起動する

**もう1つ別のターミナルウィンドウを開いて**、以下を実行します。

```bash
cd /home/administrator/Projects/karakuri/frontend
```

```bash
npm run dev
```

以下のように表示されれば起動成功です。このターミナルも **閉じずに** そのままにしておきます。

```
> karakuri-frontend@0.1.0 dev
> vite

  VITE v5.X.X  ready in XXX ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://XXX.XXX.XXX.XXX:5173/
  ➜  press h + enter to show help
```

---

### ブラウザで開く

Chrome や Firefox などのブラウザのアドレスバーに以下を入力して開きます。

```
http://localhost:5173
```

以下のような画面が表示されれば起動成功です。

```
┌─────────────────────────────────┐
│  Karakuri          新しいタスク  │
├─────────────────────────────────┤
│  タスク一覧                      │
│                                 │
│  タスクがありません。             │
│  新しいタスクを作成してください。  │
└─────────────────────────────────┘
```

---

# 第3部：翻訳アプリを作る

ここからはすべてブラウザの画面で操作します。

---

## 手順8｜新しいタスクを作成する

画面右上の青いボタン **「新しいタスク」** をクリックします。

「新しいタスクを作成」という画面が開きます。

### リポジトリを設定する

「リポジトリ」とは、コードを置く場所のことです。今回は練習用に公開されているリポジトリを使います。

「新しいリポジトリを追加」というタブをクリックして、以下の通り入力します。

| 項目 | 入力する内容 |
|---|---|
| リポジトリ URL | `https://github.com/octocat/Hello-World.git` |
| リポジトリ名 | `hello-world` |
| 説明 | 空白のまま（入力不要） |

### タスクの詳細を設定する

| 項目 | 入力する内容 |
|---|---|
| タイトル | `翻訳アプリを作る` |
| ブランチ名 | `main` |
| 説明 | 空白のまま（入力不要） |

すべて入力したら、青いボタン **「タスクを作成」** をクリックします。

---

## 手順9｜コンテナの準備が完了するまで待つ

タスクを作成すると、自動的にタスクの詳細画面に移動します。

画面上部にタスクの状態が表示されています。以下の順番で変わります。

```
pending  →  initializing  →  idle
（準備待ち）  （準備中）     （準備完了）
```

**「idle」** と表示されるまで待ちます。**ページを更新する必要はありません。** 30秒〜1分で自動的に更新されます。

画面中央の黒い領域（ログエリア）に以下のようなメッセージが表示されれば準備完了です。

```
[docker] Workspace container ready: karakuri-task-1
```

---

## 手順10｜Claudeに翻訳アプリを作るよう指示する

ステータスが「idle」になると、画面下部の入力欄が使えるようになります。

以下の文章を**まるごとコピー**して、入力欄に貼り付けます。

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

貼り付けたら、入力欄の右下にある青いボタン **「実行」** をクリックします。

（キーボードの `Ctrl` キーを押しながら `Enter` キーを押しても実行できます）

---

## 手順11｜生成が完了するまで待つ

実行すると、黒いログエリアに Claude の出力がリアルタイムで表示されていきます。

```
[SYSTEM] 指示を受け付けました
[SYSTEM] 翻訳アプリを作る
[SYSTEM] ワークスペース確認完了

[Claude] コードを生成しています...

（ここに Claude が書いたコードが流れてきます）

=== FILE: translator.html ===
<!DOCTYPE html>
<html lang="ja">
...
=== END FILE ===

[SYSTEM] ファイルをワークスペースに書き込んでいます...
[SYSTEM] 1 個のファイルを作成しました:
  ✓ translator.html
[SYSTEM] 完了しました
```

**「完了しました」** と表示され、ステータスが再び **「idle」** に戻ったら生成完了です。

生成には1〜3分かかります。その間はそのまま待っていてください。

---

## 手順12｜コンテナ名を確認する

生成されたファイルは Docker コンテナの中に保存されています。取り出すために、まずコンテナ名を確認します。

タスク詳細画面の上部（タスクのタイトルの近く）に、以下のような文字が表示されています。

```
karakuri-task-1
```

この文字がコンテナ名です。数字の部分はタスクごとに異なる場合があります（`karakuri-task-2` など）。この名前をメモしておきます。

---

## 手順13｜生成されたファイルを取り出す

ターミナル（A か B、どちらでも OK）で以下を実行します。

`karakuri-task-1` の部分は、手順12で確認した **実際のコンテナ名** に変えてください。

```bash
docker cp karakuri-task-1:/workspace/repo/translator.html ~/Desktop/translator.html
```

実行後、何も表示されなければ成功です。デスクトップに `translator.html` が保存されました。

---

## 手順14｜翻訳アプリを開いて動かす

デスクトップに保存された `translator.html` をダブルクリックします。ブラウザが開いて翻訳アプリが表示されます。

### 動作確認

**日本語 → 英語の翻訳：**
1. 上側の入力欄に `こんにちは、世界` と入力します
2. **「英語に翻訳」** ボタンをクリックします
3. 下側の欄に `Hello, World` と表示されれば成功です

**英語 → 日本語の翻訳：**
1. 下側の入力欄に `I love programming` と入力します
2. **「日本語に翻訳」** ボタンをクリックします
3. 上側に日本語の翻訳結果が表示されれば成功です

---

# 完成おめでとうございます！

これで Karakuri を使って翻訳アプリを作ることができました。

同じ手順で、Claude に別の指示を出せば別のアプリも作れます。

- `シンプルな電卓アプリを calculator.html という名前で作ってください`
- `TODOリストアプリを todo.html という名前で作ってください。追加・削除ができること`
- `サイコロを振るアプリを dice.html という名前で作ってください`

---

# 毎回の終了方法

1. ターミナル A で `Ctrl + C` を押します（`Shutdown...` と表示されてバックエンドが停止します）
2. ターミナル B で `Ctrl + C` を押します（フロントエンドが停止します）
3. 以下を実行してデータベースを停止します

```bash
cd /home/administrator/Projects/karakuri
docker compose down
```

以下のように表示されれば OK です。

```
[+] Running 2/2
 ✔ Container karakuri-db  Removed                                                                    0.3s
 ✔ Network karakuri_default  Removed                                                                 0.1s
```

---

# トラブルシューティング

## ステータスが「failed」になった

ログエリアにエラーの詳細が表示されています。

**「Failed to clone repository」と表示されている場合：**
リポジトリ URL の入力ミスです。タスクを削除して作り直してください。
タスクの削除は、ダッシュボード画面（「← 戻る」をクリック）でタスクカードの右にある赤い **「削除」** ボタンをクリックします。

**「Failed to initialize container」と表示されている場合：**
Docker ワークスペースイメージがビルドされていません。手順6を実行してください。

---

## ステータスが「pending」のままで変わらない

バックエンドが起動していない可能性があります。ターミナル A に `Application startup complete.` と表示されているか確認します。

表示されていない場合はターミナル A で以下を実行して再起動します。

```bash
cd /home/administrator/Projects/karakuri/backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

## 「実行」ボタンがグレーになっていて押せない

「実行」ボタンはステータスが **「idle」** のときだけ押せます。

| 表示されているステータス | 意味 | 対処 |
|---|---|---|
| `pending` | 準備待ち | そのまま待つ |
| `initializing` | 準備中 | そのまま待つ |
| `running` | 実行中 | 完了を待つ |
| `failed` | 失敗 | 上の対処法を確認 |

---

## `docker cp` でエラーが出た

**「No such container」と表示された場合：**
コンテナ名が違います。以下でコンテナ名を確認します。

```bash
docker ps --filter "name=karakuri-task"
```

以下のように表示されます。

```
CONTAINER ID   IMAGE                      COMMAND                NAMES
abc123def456   karakuri-workspace:latest  "/bin/sh -c 'tail -f…" karakuri-task-1
```

`NAMES` 列に表示された名前（例：`karakuri-task-1`）を使って `docker cp` を実行します。

---

## Claude が `translator.html` を生成しなかった

指示の解釈によっては別のファイル名で生成されることがあります。コンテナの中を確認します。

（`karakuri-task-1` は実際のコンテナ名に変えてください）

```bash
docker exec karakuri-task-1 ls /workspace/repo/
```

以下のように表示されます。

```
README  translator.html
```

`.html` のファイルを探して、そのファイル名で `docker cp` を実行します。

---

## API キーのエラーが表示された

ログエリアに `AuthenticationError` や `Invalid API key` と表示される場合、API キーの設定に問題があります。

以下を実行して `.env` ファイルを開き確認します。

```bash
nano /home/administrator/Projects/karakuri/backend/.env
```

以下の点を確認してください。
- `ANTHROPIC_API_KEY=your-api-key-here` のままになっていないか
- キーが `sk-ant-api03-` で始まっているか
- コピー時に余分なスペースや改行が入っていないか

修正後は、ターミナル A でバックエンドを再起動します（`Ctrl+C` を押してから再度 `uvicorn ...` を実行します）。
