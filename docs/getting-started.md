# Xolvien はじめてガイド
## 〜 翻訳アプリを作るまで 〜

このガイドでは、Xolvien を初めて使う方が、セットアップから翻訳アプリを完成させるところまでを説明します。
書いてある通りに操作すれば、実際に動く翻訳アプリが出来上がります。

---

## Xolvien とは

Xolvien は「Claude（クロード）」という AI に日本語で指示を出すと、自動的にプログラムのコードを書いてくれるツールです。プログラミングの知識がなくても、「翻訳アプリを作って」と指示するだけでアプリが完成します。

---

## 動作条件

Xolvien を使うには以下がすべて必要です。

| 条件 | 説明 |
|---|---|
| **Docker** | タスクごとの実行環境（コンテナ）を作るために使います |
| **Python 3.11以上** | バックエンドの動作に必要です |
| **Node.js 18以上** | フロントエンドの動作に必要です |
| **Claude Code CLI（認証済み）** | AI（Claude）を呼び出すために使います |
| **Claude Max Plan** | Claude Code CLI を通じて AI を利用するためのサブスクリプションです |
| **GitHubアカウント＋SSH鍵** | コードの保存先リポジトリへのアクセスに使います |

### Claude Code CLI と Max Plan について

Xolvien は AI との通信に Claude Code CLI（`claude` コマンド）を使います。
Claude Code CLI はインストール後にログインすると、認証情報が `~/.claude/` フォルダに保存されます。
Xolvien はこの認証情報をそのまま使うため、**APIキーの取得・設定は不要**です。

Max Plan に加入済みであれば、追加の費用なく AI を利用できます。

> Claude Code CLI のインストールと Max Plan への加入が事前に完了していることを前提として、このガイドを進めます。
> まだの場合は https://claude.ai/download からインストールしてログインしてください。

### GitHub SSH鍵について

Xolvien はホストの `~/.ssh/` フォルダをコンテナにマウントします。
ホストで GitHub へのSSH接続が設定済みであれば、コンテナ内からも同じ鍵でGitHubにアクセスできます。

SSH鍵の設定がまだの場合は、GitHubのドキュメント（Settings → SSH and GPG keys）を参照してください。
設定が完了したら以下で確認できます：

```bash
ssh -T git@github.com
# Hi username! You've successfully authenticated と表示されれば OK
```

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

## 手順1｜事前準備を確認する

「ターミナル」を開きます。

- **Windows（WSL）の場合**：スタートメニューで「Ubuntu」を検索して開きます
- **Mac の場合**：Launchpad で「ターミナル」を検索して開きます

### Claude Code CLI の認証確認

```bash
claude --version
```

以下のように表示されれば認証済みです。

```
2.1.87 (Claude Code)
```

バージョン番号が表示されず、ログインを求める画面が表示された場合は、画面の指示に従ってログインしてください。

### GitHub SSH鍵の確認

```bash
ssh -T git@github.com
```

以下のように表示されれば認証済みです。

```
Hi username! You've successfully authenticated, but GitHub does not provide shell access.
```

このメッセージが表示されない場合は、GitHubへのSSH鍵設定が必要です。GitHub の Settings → SSH and GPG keys で設定してください。

---

## 手順2｜リポジトリをクローンする

Xolvien のソースコードをダウンロードします。保存先は任意のディレクトリで構いません。

```bash
git clone git@github.com:k-amano/xolvien.git
cd xolvien
```

`xolvien/` ディレクトリが作成され、その中に移動します。
**以降の手順はすべてこの `xolvien/` ディレクトリの中で実行します。**

---

## 手順3｜環境変数ファイルを作る

以下を実行します。

```bash
cp .env.example backend/.env
```

何も表示されなければ成功です。設定はデフォルトのままで動作します。確認したい場合：

```bash
cat backend/.env
```

以下のような内容が表示されます。

```
DATABASE_URL=postgresql+asyncpg://xolvien:xolvien@localhost:5433/xolvien
API_HOST=0.0.0.0
API_PORT=8000
FRONTEND_URL=http://localhost:5173
DEV_AUTH_TOKEN=dev-token-12345
DOCKER_SOCKET=/var/run/docker.sock
WORKSPACE_IMAGE=xolvien-workspace:latest
TASK_DATA_PATH=/tmp/xolvien/tasks
ANTHROPIC_API_KEY=
ENVIRONMENT=development
```

> `ANTHROPIC_API_KEY` は空のままで構いません。Claude Code CLI が Claude Max Plan のサブスクリプションを使用するため、APIキーは不要です。

---

## 手順4｜データベースを起動する

Xolvien のデータベース（PostgreSQL）は Docker コンテナとして起動します。
**PostgreSQL を別途インストールする必要はありません。**

```bash
docker compose up -d db
```

以下のように表示されれば OK です。

```
[+] Running 1/1
 ✔ Container xolvien-db  Started                                                                    0.5s
```

次に、データベースが正常に動いているか確認します。

```bash
docker compose ps
```

以下のように表示されます。

```
NAME          IMAGE                COMMAND                  SERVICE   CREATED        STATUS                   PORTS
xolvien-db   postgres:16-alpine   "docker-entrypoint.s…"   db        X minutes ago  Up X minutes (healthy)   0.0.0.0:5433->5432/tcp
```

`STATUS` の列に **`(healthy)`** と書かれていれば OK です。

**`(health: starting)` と表示された場合：** まだ起動中です。20〜30秒待ってから、もう一度 `docker compose ps` を実行してください。

---

## 手順5｜バックエンドをセットアップする

以下を **1行ずつ** 実行してください。1つ実行するたびに完了を確認してから次に進みます。

```bash
cd backend
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
(venv) administrator@owl:~/Projects/xolvien/backend$
```

先頭に `(venv)` が付いていれば OK です。ターミナルの表示例：

```
(venv) ユーザー名@コンピュータ名:~/xolvien/backend$
```

```bash
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles
```

たくさんの文字が流れます。最後に以下のどちらかが表示されれば OK です。

**初めてインストールする場合：**
```
Successfully installed ...（たくさんのパッケージ名）...
```

**すでにインストール済みの場合：**
```
Requirement already satisfied: fastapi in ./venv/...
Requirement already satisfied: sqlalchemy in ./venv/...
...（各パッケージについて同様の行が続く）
```
`Requirement already satisfied` はすでにインストール済みという意味です。問題ありません。

```bash
alembic upgrade head
```

以下のどちらかが表示されれば OK です。

**初めて実行する場合：**
```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> xxxxxxxx, Initial migration
```

**すでに適用済みの場合：**
```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
```
`Running upgrade` の行が出ない場合は、すでにデータベースが最新の状態になっています。問題ありません。

---

## 手順6｜Docker ワークスペースイメージをビルドする

Xolvien がコードを動かすための専用環境を作ります。**5〜10分かかります。**
たくさんの文字が流れますが、完了まで待ちます。

まずプロジェクトルートに戻ります（手順5で `backend/` に移動していた場合）：

```bash
cd ..
```

```bash
docker build -t xolvien-workspace:latest ./docker/workspace/
```

最後に以下のように表示されれば OK です。

```
=> => naming to docker.io/library/xolvien-workspace:latest
```

または

```
Successfully tagged xolvien-workspace:latest
```

---

## 手順7｜フロントエンドの依存パッケージをインストールする

```bash
cd frontend
```

```bash
npm install
```

最後に以下のどちらかが表示されれば OK です。

**初めてインストールする場合：**
```
added XXX packages, and audited XXX packages in Xs
```

**すでにインストール済みの場合：**
```
up to date, audited 231 packages in 46s

48 packages are looking for funding
  run `npm fund` for details

9 vulnerabilities (3 moderate, 6 high)
...
```
`up to date` はすでにインストール済みという意味です。`vulnerabilities`（脆弱性）の警告が出ることがありますが、ローカル開発環境での使用では問題ありません。無視して進んでください。

表示が終わるとコマンドプロンプト（`$` で終わる行）に戻ります。これで手順7は完了です。

---

> ### ここまでの手順1〜7は初回セットアップです。完了しました。
> このターミナルは閉じても構いません。
> 次の「第2部：起動する」では新しいターミナルを2つ開いて使います。
> 2回目以降は手順3〜7は不要です。「第2部：起動する」から始めてください。

---

# 第2部：起動する（毎回行う）

2回目以降はここから始めます。

ターミナルウィンドウを **2つ** 用意します。

---

### ターミナル A：バックエンドを起動する

**新しいターミナルウィンドウを開いて**、以下を順番に実行します。

まず `xolvien/` ディレクトリに移動します（クローンした場所に合わせてください）：

```bash
cd xolvien   # クローンしたディレクトリ名（パスが違う場合は適宜変更）
```

```bash
docker compose up -d db
```

以下のように表示されれば OK です（すでに起動している場合は `Running` と表示されます）。

```
[+] Running 1/1
 ✔ Container xolvien-db  Started                                                                    0.5s
```

または

```
[+] Running 1/1
 ✔ Container xolvien-db  Running                                                                    0.0s
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
INFO:     Will watch for changes in these directories: ['/path/to/xolvien/backend']
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
cd xolvien/frontend   # クローンした場所に合わせて変更してください
```

```bash
npm run dev
```

以下のように表示されれば起動成功です。このターミナルも **閉じずに** そのままにしておきます。

```
> xolvien-frontend@0.1.0 dev
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
│  Xolvien          新しいタスク  │
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

## Xolvien の基本的な考え方

操作を始める前に、2つの用語を理解してください。

**リポジトリ**
コードの保存場所（GitHubのリポジトリ）です。一度 Xolvien に登録すると、次回からは登録済みのものを選ぶだけです。

**タスク**
ひとつの作業単位です。「翻訳アプリを作る」「ログイン機能を追加する」のように、やりたいことごとに1つ作ります。タスクを作るたびに専用の作業環境（コンテナ）が用意されます。

```
リポジトリ（GitHubのURL）
  └─ タスク1「翻訳アプリを作る」  → xolvien/task-1 ブランチ
  └─ タスク2「電卓アプリを作る」  → xolvien/task-2 ブランチ
  └─ タスク3「ログイン機能を追加」 → xolvien/task-3 ブランチ
```

タスクごとに別々のブランチが作られるので、複数の作業が混在しません。

---

## 手順8｜新しいタスクを作成する

画面右上の青いボタン **「新しいタスク」** をクリックします。

「新しいタスクを作成」という画面が開きます。

---

### ステップ A｜リポジトリを選ぶ

画面には **「既存のリポジトリを選択」** と **「新しいリポジトリを追加」** の2つのタブがあります。

**「既存」「新しい」はGitHub上での話ではなく、Xolvienへの登録済みかどうかを指しています。**

| タブ | 意味 | 使うタイミング |
|---|---|---|
| **新しいリポジトリを追加** | GitHubのリポジトリをXolvienに初めて登録する | そのリポジトリを初めて使うとき |
| **既存のリポジトリを選択** | Xolvienにすでに登録済みのリポジトリから選ぶ | 2回目以降 |

#### 1回目（Xolvienにまだ登録していないリポジトリを使う場合）

> **事前準備：** 対象のリポジトリがGitHub上にあらかじめ作成されている必要があります。まだの場合はGitHubでリポジトリを作成してからこの手順を進めてください。

**「新しいリポジトリを追加」** タブをクリックして、以下の通り入力します。

| 項目 | 入力する内容 |
|---|---|
| リポジトリ URL | `git@github.com:ユーザー名/リポジトリ名.git` |
| リポジトリ名 | 任意の名前（例: `my-app`） |
| 説明 | 空白のまま（入力不要） |

**リポジトリ URL の確認方法：** GitHubのリポジトリページで、緑色の **「Code」** ボタン → **「SSH」** タブをクリックすると表示されます。

#### 2回目以降（Xolvienにすでに登録済みのリポジトリを使う場合）

**「既存のリポジトリを選択」** タブを開くと、過去に登録したリポジトリの一覧が表示されます。使いたいリポジトリをリストから選んでください。

> **どちらを選ぶか迷ったら：** 「既存のリポジトリを選択」タブを開いてリストにリポジトリ名が表示されていれば「既存のリポジトリを選択」、何も表示されていなければ「新しいリポジトリを追加」を選びます。

---

### ステップ B｜タスクの詳細を入力する

| 項目 | 入力する内容 |
|---|---|
| タイトル | `翻訳アプリを作る` |
| ブランチ名 | 空白のまま（入力不要） |
| 説明 | 空白のまま（入力不要） |

> **ブランチ名について：** 空白のままにすると `xolvien/task-{番号}` という名前のブランチが自動で作成されます。特定のブランチに作業を追加したい場合のみ入力してください。

---

### ステップ C｜作成する

青いボタン **「タスクを作成」** をクリックします。

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
[docker] Workspace container ready: xolvien-task-1
```

---

## 手順10｜Claudeに翻訳アプリを作るよう指示する

ステータスが「idle」になると、画面下部の入力欄が使えるようになります。

以下の文章を**まるごとコピー**して、入力欄に貼り付けます。

```
日本語と英語を相互に翻訳できる、シンプルな1ページのWebアプリを作ってください。
```

貼り付けたら、青いボタン **「要件を確認する」** をクリックします。

> 要件がすでに完全に決まっている場合は「スキップしてプロンプトを生成」をクリックしても構いません。その場合は手順11をとばして手順12へ進んでください。

---

## 手順11｜Claudeの質問に答える（要件確認）

「要件を確認する」をクリックすると、Claude がプロジェクトを分析して不明点を質問してきます。

```
┌──────────────────────────────────────────────┐
│ 要件確認 — Claudeが不明点を質問します          │
│                                              │
│ 指示: 日本語と英語を相互に翻訳できる...        │
│                                              │
│ Claude                                       │
│  以下の点を確認させてください。               │
│  1. 翻訳APIはどれを使いますか？               │
│  2. HTMLファイル1つにまとめますか？            │
│  3. デザインの要望はありますか？              │
└──────────────────────────────────────────────┘
```

質問が表示されたら、回答欄に答えを入力して **「回答を送信」** をクリックします（または Enter キー）。

```
1. https://api.mymemory.translated.net を使ってください（APIキー不要）
2. HTMLファイル1つにまとめてください。ファイル名は translator.html
3. シンプルで見やすければOKです
```

Claude が「十分な情報が揃った」と判断すると、自動的にプロンプト確認画面へ移行します。

**複数回のやりとりが発生することもあります。** 同様に回答を送信してください。

---

## 手順12｜プロンプトを確認して実行する

要件確認が完了すると、以下のような確認画面が表示されます。

```
┌──────────────────────────────────────────────┐
│ プロンプト確認                                 │
│                                              │
│ 元の指示                                      │
│  日本語と英語を相互に翻訳できる...              │
│                                              │
│ 生成されたプロンプト                           │
│  translator.html を作成してください。           │
│  - 日本語入力欄（id="japanese"）               │
│  - 英語入力欄（id="english"）                  │
│  - 翻訳API: https://api.mymemory.translated.net│
│  ...（詳細な実装指示）                         │
│                                              │
│ このプロンプトへの指摘・追加要望（任意）         │
│  ┌──────────────────────────────────────┐    │
│  │                                      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  [再生成]  [キャンセル]  [確定して実行]         │
└──────────────────────────────────────────────┘
```

生成されたプロンプトを読んで問題なければ **「確定して実行」** をクリックします。

内容が不十分な場合は、「このプロンプトへの指摘・追加要望」欄に修正してほしい点を書いて **「再生成」** をクリックします。何度でも繰り返せます。

---

## 手順13｜生成が完了するまで待つ

「確定して実行」をクリックすると、黒いログエリアに Claude の出力がリアルタイムで表示されます。

```
[SYSTEM] 指示を受け付けました

[Claude] Claude Code CLIを実行しています...

（ここに Claude の思考・作業ログが流れてきます）
（ファイルの読み込み、コード生成、ファイルへの書き込みが自動で行われます）

[GIT] 変更をコミットしています...
[main abc1234] 日本語と英語を相互に翻訳できる、シンプルな1ページのWebアプリを作ってください。

[SYSTEM] 完了しました
```

**「完了しました」** と表示され、ステータスが再び **「idle」** に戻ったら生成完了です。

生成・コミットまで自動で行われます。1〜3分かかります。その間はそのまま待っていてください。

---

## 手順14｜GitHubへ保存する

生成・コミットまでは自動で行われています。GitHubへ送信（push）するだけです。

タスク詳細画面で **「Git Push」** ボタンをクリックします。

ログエリアに以下のように表示されれば成功です。

```
[GIT] ブランチ 'xolvien/task-1' を push しています...
To git@github.com:ユーザー名/リポジトリ名.git
 * [new branch]      xolvien/task-1 -> xolvien/task-1
Branch 'xolvien/task-1' set up to track remote branch 'xolvien/task-1' from 'origin'.
[GIT] push 完了
```

GitHubのリポジトリページを開くと `xolvien/task-1` ブランチに `translator.html` が保存されています。

> **mainブランチへの反映：** GitHubのリポジトリページで **「Compare & pull request」** ボタンをクリックしてプルリクエストを作成し、mainブランチにマージしてください。

---

## 手順15｜翻訳アプリを手元で確認する

生成した `translator.html` をローカルで確認したい場合は以下で取り出せます。

**Windowsの場合：**
```bash
docker cp xolvien-task-1:/workspace/repo/translator.html ~/translator.html
explorer.exe ~/translator.html
```

**Macの場合：**
```bash
docker cp xolvien-task-1:/workspace/repo/translator.html ~/Desktop/translator.html
```

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

これで Xolvien を使って翻訳アプリを作ることができました。

---

# 2回目以降の使い方

2回目以降の起動と作業の流れをまとめます。

## 起動する（毎回）

「第2部：起動する」と同じ手順です。

1. ターミナル A でバックエンドを起動する
2. ターミナル B でフロントエンドを起動する
3. ブラウザで `http://localhost:5173` を開く

---

## 新しい作業を始める

前回作ったタスクは画面に残っています。**新しい作業をするたびに新しいタスクを作ります。**

1. **「新しいタスク」** をクリック
2. リポジトリ：**「既存のリポジトリを選択」** タブを開き、リストから選ぶ
3. タイトルに作業内容を入力（例：`電卓アプリを作る`）
4. ブランチ名は空白のまま → 自動で新しいブランチが作られる
5. **「タスクを作成」** をクリック

あとは手順9〜14と同じです。

---

## 過去のタスクを続ける

ダッシュボード（トップ画面）にタスクの一覧が表示されています。タスクをクリックするとタスク詳細画面に移動し、続きの指示を出せます。

ただし、**Xolvien を再起動するとコンテナも再起動されます**。再起動後に過去のタスクのコンテナが停止している場合は、タスクを削除して作り直してください。

---

## 別の指示を出す

同じタスクに対して何度でも指示を出せます。タスク詳細画面で新しい指示を入力して **「要件を確認する」** → **「確定して実行」** を繰り返すだけです。

```
タスク「翻訳アプリを作る」
  └─ 指示1「translator.html を作って」 → 実行 → コミット
  └─ 指示2「デザインを改善して」       → 実行 → コミット
  └─ 指示3「エラー処理を追加して」     → 実行 → コミット
```

すべての変更は同じブランチに積み重なっていきます。まとめて **「Git Push」** でGitHubに保存できます。

---

# 毎回の終了方法

1. ターミナル A で `Ctrl + C` を押します（`Shutdown...` と表示されてバックエンドが停止します）
2. ターミナル B で `Ctrl + C` を押します（フロントエンドが停止します）
3. 以下を実行してデータベースを停止します

```bash
cd xolvien   # クローンしたディレクトリ
docker compose down
```

以下のように表示されれば OK です。

```
[+] Running 2/2
 ✔ Container xolvien-db  Removed                                                                    0.3s
 ✔ Network xolvien_default  Removed                                                                 0.1s
```

---

# トラブルシューティング

## ステータスが「failed」になった

ログエリアにエラーの詳細が表示されています。

**「Failed to clone repository」と表示されている場合：**
以下を確認してください。

- リポジトリ URL が `git@github.com:ユーザー名/リポジトリ名.git` の形式になっているか
- GitHubにSSH鍵が登録されているか（ターミナルで `ssh -T git@github.com` を実行し、`Hi username!` と表示されれば認証済み）

確認後、タスクを削除して作り直してください。タスクの削除は、ダッシュボード画面（「← 戻る」をクリック）でタスクカードの右にある赤い **「削除」** ボタンをクリックします。

**「Failed to initialize container」と表示されている場合：**
Docker ワークスペースイメージがビルドされていません。手順6を実行してください。

---

## ステータスが「pending」のままで変わらない

バックエンドが起動していない可能性があります。ターミナル A に `Application startup complete.` と表示されているか確認します。

表示されていない場合はターミナル A で以下を実行して再起動します。

```bash
cd xolvien/backend   # クローンしたディレクトリ
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

## 「要件を確認する」ボタンがグレーになっていて押せない

「要件を確認する」ボタンはステータスが **「idle」** かつ指示欄に文字が入力されているときだけ押せます。

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
docker ps --filter "name=xolvien-task"
```

以下のように表示されます。

```
CONTAINER ID   IMAGE                      COMMAND                NAMES
abc123def456   xolvien-workspace:latest  "/bin/sh -c 'tail -f…" xolvien-task-1
```

`NAMES` 列に表示された名前（例：`xolvien-task-1`）を使って `docker cp` を実行します。

---

## Claude が `translator.html` を生成しなかった

指示の解釈によっては別のファイル名で生成されることがあります。コンテナの中を確認します。

（`xolvien-task-1` は実際のコンテナ名に変えてください）

```bash
docker exec xolvien-task-1 ls /workspace/repo/
```

以下のように表示されます。

```
README  translator.html
```

`.html` のファイルを探して、そのファイル名で `docker cp` を実行します。

---

## Git Push ボタンを押してもエラーになる

ログエリアにエラーの詳細が表示されています。

**「Permission denied (publickey)」と表示された場合：**
SSH鍵の認証に失敗しています。ホストマシンで以下を確認します。

```bash
ssh -T git@github.com
```

`Hi username!` と表示されれば認証済みです。表示されない場合はSSH鍵の設定を確認してください。

**「rejected」または「failed to push」と表示された場合：**
別の場所から同じブランチにpushされた可能性があります。タスクを削除して作り直してください。

---

## Claude Code CLI の認証エラーが表示された

ログエリアに認証関連のエラーが表示される場合、ホストの Claude Code CLI の認証情報が問題の可能性があります。

ホストマシンで以下を確認します。

```bash
claude --version        # バージョンが表示されるか確認
ls ~/.claude/           # 認証情報ファイルが存在するか確認
```

認証情報がない場合は `claude` コマンドを実行してログインし直してください。
