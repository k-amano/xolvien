# Xolvien Getting Started Guide
## — Building a Translation App from Scratch —

This guide walks a first-time Xolvien user through everything from initial setup to completing a working translation app.
Follow the steps exactly and you will have a real, runnable app at the end.

---

## What is Xolvien?

Xolvien is a tool that writes program code automatically when you give instructions to an AI called "Claude." You don't need programming knowledge — just say "build a translation app" and the app is created for you.

---

## Requirements

All of the following are required to use Xolvien.

| Requirement | Description |
|---|---|
| **Docker** | Used to create an isolated container environment for each task |
| **Python 3.11+** | Required to run the backend |
| **Node.js 18+** | Required to run the frontend |
| **Claude Code CLI (authenticated)** | Used to call the AI (Claude) |
| **Claude Max Plan** | Subscription required to use the AI through the Claude Code CLI |
| **GitHub account + SSH key** | Used to access the repository where code is stored |

### Claude Code CLI and Max Plan

Xolvien uses the Claude Code CLI (`claude` command) to communicate with the AI.
After installing and logging in, Claude Code CLI stores credentials in `~/.claude/`.
Xolvien uses these credentials directly — **no API key setup is needed**.

If you have an active Max Plan subscription, you can use the AI at no additional cost.

> This guide assumes Claude Code CLI is already installed and authenticated, and that you have a Max Plan subscription.
> If not, install and log in from https://claude.ai/download first.

### GitHub SSH Key

Xolvien mounts your host `~/.ssh/` folder into the container.
If you have SSH access to GitHub configured on your host, the container will use the same key.

If you haven't set up an SSH key yet, refer to GitHub's documentation (Settings → SSH and GPG keys).
Once configured, verify with:

```bash
ssh -T git@github.com
# "Hi username! You've successfully authenticated" means it's working
```

---

## Time Estimates

| Task | Time |
|---|---|
| First-time setup | 15–20 minutes |
| Starting up (each time) | 1–2 minutes |
| Generating the translation app | 3–5 minutes |

First-time setup only needs to be done once. From the second session onward, start from **Part 2: Starting Up**.

---

# Part 1: First-time Setup

## Step 1 — Verify prerequisites

Open a **Terminal**.

- **Windows (WSL)**: Search for "Ubuntu" in the Start menu and open it.
- **Mac**: Search for "Terminal" in Launchpad and open it.

### Verify Claude Code CLI authentication

```bash
claude --version
```

If it shows a version number like the following, you're authenticated:

```
2.1.87 (Claude Code)
```

If a login prompt appears instead, follow the on-screen instructions to log in.

### Verify GitHub SSH key

```bash
ssh -T git@github.com
```

If you see this, your SSH key is configured:

```
Hi username! You've successfully authenticated, but GitHub does not provide shell access.
```

If this message doesn't appear, you need to set up an SSH key in GitHub Settings → SSH and GPG keys.

---

## Step 2 — Clone the repository

Download the Xolvien source code. You can save it anywhere.

```bash
git clone git@github.com:k-amano/xolvien.git
cd xolvien
```

This creates an `xolvien/` directory and moves you into it.
**All subsequent steps are run from inside this `xolvien/` directory.**

---

## Step 3 — Create the environment file

Run the following:

```bash
cp .env.example backend/.env
```

No output means success. To verify:

```bash
cat backend/.env
```

You should see something like:

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

> Leave `ANTHROPIC_API_KEY` empty. Claude Code CLI uses your Max Plan subscription, so no API key is needed.

> **`GITHUB_TOKEN` (optional):** If you want to create GitHub repositories directly from the Xolvien task creation screen, set a GitHub Personal Access Token here. Go to GitHub → Settings → Developer settings → Personal access tokens → Generate new token, and grant the **`repo`** scope. Leave it empty if you prefer to create repositories on GitHub manually.
>
> ```
> GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
> ```

---

## Step 4 — Start the database

Xolvien's database (PostgreSQL) runs as a Docker container.
**You do not need to install PostgreSQL separately.**

```bash
docker compose up -d db
```

If you see the following, it worked:

```
[+] Running 1/1
 ✔ Container xolvien-db  Started                                                                    0.5s
```

Check that the database is healthy:

```bash
docker compose ps
```

You should see:

```
NAME          IMAGE                COMMAND                  SERVICE   CREATED        STATUS                   PORTS
xolvien-db   postgres:16-alpine   "docker-entrypoint.s…"   db        X minutes ago  Up X minutes (healthy)   0.0.0.0:5433->5432/tcp
```

**`(healthy)`** in the STATUS column means it's running. If it shows **`(health: starting)`**, wait 20–30 seconds and run `docker compose ps` again.

---

## Step 5 — Set up the backend

Run the following **one line at a time**, waiting for each to complete before continuing.

```bash
cd backend
```

No output = OK.

```bash
python3 -m venv venv
```

No output = OK.

```bash
source venv/bin/activate
```

After running, your prompt should show `(venv)` at the beginning:

```
(venv) user@computer:~/xolvien/backend$
```

```bash
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles
```

A lot of text will scroll. You're done when you see either:

**First install:**
```
Successfully installed ...
```

**Already installed:**
```
Requirement already satisfied: fastapi in ./venv/...
```

`Requirement already satisfied` just means it's already installed — no problem.

```bash
alembic upgrade head
```

You're done when you see either:

**First run:**
```
INFO  [alembic.runtime.migration] Running upgrade  -> xxxxxxxx, Initial migration
```

**Already up to date:**
```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
```

No `Running upgrade` line means the database is already current — no problem.

---

## Step 6 — Build the Docker workspace image

This creates the dedicated execution environment Xolvien uses to run code. **Takes 5–10 minutes.**
A lot of text will scroll. Just wait for it to finish.

Return to the project root first (if you moved to `backend/` in Step 5):

```bash
cd ..
```

```bash
docker build -t xolvien-workspace:latest ./docker/workspace/
```

When you see either of the following, it's done:

```
=> => naming to docker.io/library/xolvien-workspace:latest
```

or

```
Successfully tagged xolvien-workspace:latest
```

---

## Step 7 — Install frontend dependencies

```bash
cd frontend
```

```bash
npm install
```

Done when you see either:

**First install:**
```
added XXX packages, and audited XXX packages in Xs
```

**Already installed:**
```
up to date, audited 231 packages in 46s
```

`up to date` means everything is already installed. `vulnerabilities` warnings may appear — these are safe to ignore in a local development environment.

---

> ### Steps 1–7 are the one-time first-time setup. You're done.
> You can close this terminal.
> For **Part 2: Starting Up**, open two new terminal windows.
> From the second session onward, skip to **Part 2** — Steps 3–7 are not needed again.

---

# Part 2: Starting Up (every session)

Start here from the second session onward.

Open **2 terminal windows**.

---

### Terminal A: Start the backend

**Open a new terminal window** and run the following in order.

Navigate to the `xolvien/` directory (adjust the path to where you cloned it):

```bash
cd xolvien
```

```bash
docker compose up -d db
```

You should see (or `Running` if already started):

```
[+] Running 1/1
 ✔ Container xolvien-db  Started                                                                    0.5s
```

```bash
cd backend
```

```bash
source venv/bin/activate
```

`(venv)` at the start of your prompt means it's active.

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

If you see the following, the backend is running. **Leave this terminal open.**

```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Application startup complete.
```

---

### Restarting the backend (after updates)

After updating Xolvien (`git pull`), you need to restart the backend.
Without a restart, new features may not take effect or old bugs may remain.

**In Terminal A (the backend terminal), run the following in order.**

#### Step 1 — Stop the backend

```
Ctrl + C
```

You'll see shutdown messages and get your prompt back:

```
^CINFO:     Shutting down
INFO:     Application shutdown complete.
(venv) user@computer:~/xolvien/backend$
```

#### Step 2 — Apply database migrations

```bash
alembic upgrade head
```

**If new tables were added:**
```
INFO  [alembic.runtime.migration] Running upgrade xxxxxxxx -> yyyyyyyy, add_test_case_items_and_results
```

**Already up to date:**
```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
```

#### Step 3 — Start the backend

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

#### Step 4 — Reload the browser

After the backend restarts, press **F5** (or Ctrl+R / Cmd+R) to reload the page.

---

### Terminal B: Start the frontend

**Open another terminal window** and run:

```bash
cd xolvien/frontend
```

```bash
npm run dev
```

When you see the following, the frontend is running. **Leave this terminal open.**

```
  VITE v5.X.X  ready in XXX ms

  ➜  Local:   http://localhost:5173/
```

---

### Open in the browser

Enter the following in your browser's address bar:

```
http://localhost:5173
```

If you see a screen like this, you're up and running:

```
┌─────────────────────────────────┐
│  Xolvien          New task      │
├─────────────────────────────────┤
│  Task list                      │
│                                 │
│  No tasks yet.                  │
│  Create a new task.             │
└─────────────────────────────────┘
```

---

# Part 3: Repositories, Projects, Tasks, and Branches

This is the most important conceptual foundation for using Xolvien. Read this before you start.

---

## The four concepts

| Term | Meaning in Xolvien | GitHub equivalent |
|---|---|---|
| **Repository** | Where code is stored. One program = one repository. | GitHub repository |
| **Project** | Xolvien's name for a registered repository. Shows up in the list once registered. | (Xolvien management unit) |
| **Task** | One unit of work ("build a translation app", "add login feature", etc.) | Corresponds to one branch |
| **Branch** | The working branch automatically created for each task. | GitHub branch |

---

## Repository vs. Project

A "repository" is a code storage location on GitHub. A "project" is the registration record Xolvien uses to manage that repository.

**One program = one repository = one project** is the rule.

```
GitHub
  └─ repository "translation-app"  (translation app code)
  └─ repository "calculator-app"   (calculator app code)

Xolvien
  └─ project "Translation App" → linked to translation-app repository
  └─ project "Calculator App"  → linked to calculator-app repository
```

Once you register a repository in Xolvien (= create a project), you just select it from the list next time. **Registration is a one-time step.**

---

## Task vs. Branch

When you create a task, **a new working branch is automatically cut from `main`.** Each task maps one-to-one to a working branch.

```
main branch (completed code)
  ├─ xolvien/1-create-translation-app  ← working branch for task "Build translation app"
  ├─ xolvien/2-improve-design          ← working branch for task "Improve design"
  └─ xolvien/3-add-error-handling      ← working branch for task "Add error handling"
```

Each task runs on its own independent branch, so **work from one task never leaks into another.**

---

## The four usage patterns

### Pattern 1 — Build a brand-new program

> Example: "I want to build a translation app from scratch."

You have two options:

**Option A — Create the GitHub repository from Xolvien (recommended if `GITHUB_TOKEN` is set):**

```
Flow:
1. Xolvien → "New task"
2. "Create on GitHub" tab → enter name and description → Xolvien creates the repo on GitHub automatically
3. Enter task title (e.g. "Build translation app")
4. "Create task"
   ↓
   xolvien/1-create-translation-app is automatically created from main
   Work starts against the empty repository
```

**Option B — Create the repository on GitHub first, then register it:**

```
Flow:
1. Create a new (empty) repository on GitHub
2. Xolvien → "New task"
3. "Add new repository" tab → enter SSH URL and register
4. Enter task title (e.g. "Build translation app")
5. "Create task"
```

**Key points:**
- The repository can be **completely empty** (even without a README).
- Xolvien creates the branch and generates all code from scratch.
- "Create on GitHub" requires `GITHUB_TOKEN` in `backend/.env`.

---

### Pattern 2 — Add features or fix an existing program (2nd task onward)

> Example: "I want to add dark mode to the translation app."

**Confirm the previous task's changes are merged into main first**, then create a new task.

```
Flow:
1. Confirm the previous task's changes are merged into main
   (create a pull request on GitHub and merge, or merge the branch directly into main)
2. Xolvien → "New task"
3. "Select existing repository" tab → choose the translation app project from the list
4. Enter task title (e.g. "Add dark mode")
5. "Create task"
   ↓
   xolvien/2-add-dark-mode is automatically created from the latest main
   Work starts with the previous task's changes already included
```

**Key points:**
- **Always merge the previous task into main before** creating a new task.
- Since Xolvien picks up `main` at task creation time, an unmerged previous task will not be included.
- If the repository is already in the "Select existing repository" list, no re-registration is needed.

---

### Pattern 3 — Modify code created outside Xolvien

> Example: "I want to refactor a calculator app I wrote myself."

Any code that lives in a GitHub repository can be handled the same way, even if it wasn't created with Xolvien. Registration is required on the first use.

```
Flow:
1. Xolvien → "New task"
2. "Add new repository" tab → enter the existing repository's SSH URL and register
3. Enter task title (e.g. "Refactor calculator app")
4. "Create task"
   ↓
   A working branch is created from the current state of main
   Work starts against the existing code
```

**Key points:**
- Any code with a GitHub repository can be modified through Xolvien.
- First time: use "Add new repository". Second time onward: use "Select existing repository".

---

### Pattern 4 — Build a separate new program

> Example: "I want to build a calculator app, separate from the translation app."

A different program goes in a **different repository**. Putting a calculator app inside the translation app's repository is not recommended.

```
Flow (with GITHUB_TOKEN set):
1. Xolvien → "New task"
2. "Create on GitHub" tab → enter the new repository name → created automatically
3. Enter task title (e.g. "Build calculator app")
4. "Create task"

Flow (without GITHUB_TOKEN):
1. Create a new repository for the calculator app on GitHub
2. Xolvien → "New task"
3. "Add new repository" tab → enter the new repository's SSH URL and register
4. Enter task title (e.g. "Build calculator app")
5. "Create task"
```

**Key points:**
- The number of repositories and projects grows with the number of programs.
- The existing translation app project is left untouched.

---

## Summary: which tab to pick

When the "select repository" screen appears during task creation:

| Situation | Tab to select |
|---|---|
| This repository was used in Xolvien before | **Select existing repository** |
| Repository already exists on GitHub, first time registering | **Add new repository** |
| Want to create a new GitHub repository and register it in one step | **Create on GitHub** |

If the repository name appears in the "Select existing repository" list, choose "existing."
If the repository already exists on GitHub but isn't registered yet, choose "Add new repository."
If you haven't created the repository on GitHub yet, use "Create on GitHub" to do both at once.

> **"Create on GitHub" requires `GITHUB_TOKEN`** to be set in `backend/.env`. See Step 3.

---

# Part 4: Building a Translation App

From here, all steps are done in the browser.

---

## Step 8 — Create a new task

Click the blue **"New task"** button in the top right of the screen.

A "Create new task" dialog opens.

---

### Step A — Select a repository

The dialog has three tabs: **"Select existing repository"**, **"Add new repository"**, and **"Create on GitHub"**.

> For guidance on which to choose, see Part 3.
> Since this is the first time using the translation app, use **"Create on GitHub"** (if `GITHUB_TOKEN` is set) or **"Add new repository"** (if you already created the repository on GitHub).

**If using "Create on GitHub"** — fill in the repository name and optional description, then proceed to Step B.

**If using "Add new repository"** — fill in the fields below:

> **Prerequisites:** The repository must already exist on GitHub. If not, create it on GitHub before continuing.

| Field | What to enter |
|---|---|
| Repository URL | `git@github.com:your-username/repository-name.git` |
| Repository name | Any name (e.g. `my-app`) |
| Description | Leave blank |

**How to find the Repository URL:** On your GitHub repository page, click the green **"Code"** button → **"SSH"** tab.

---

### Step B — Enter task details

| Field | What to enter |
|---|---|
| Title | `Build a translation app` |
| Branch name | Leave blank |
| Description | Leave blank |

> **About branch name:** Leaving it blank automatically creates a branch named `xolvien/{id}-{title-slug}` from `main` (e.g. `xolvien/1-translation-app`). Only fill this in if you need a specific branch name.

---

### Step C — Create

Click the blue **"Create task"** button.

---

## Step 9 — Wait for the container to be ready

After creating the task, you are automatically taken to the task detail screen.

The task status is shown at the top of the screen and progresses like this:

```
pending  →  initializing  →  idle
(waiting)   (preparing)      (ready)
```

Wait until **"idle"** appears. **No need to refresh the page** — it updates automatically in 30–60 seconds.

When you see the following in the log area, the container is ready:

```
[docker] Workspace container ready: xolvien-task-1
```

---

## Step 10 — Instruct Claude to build the translation app

Once the status is "idle", the **"Instruction to Claude"** input field on the right becomes active.

**Copy and paste** the following text into the input field:

```
Please build a simple single-page web app that translates between Japanese and English.
```

Then click the blue **"Send"** button.

---

## Step 11 — Answer Claude's questions (requirement clarification phase)

After clicking "Send", Claude will ask clarifying questions:

```
┌──────────────────────────────────────────────────────┐
│ Claude                                               │
│  Please confirm the following:                       │
│  1. What programming language / framework to use?    │
│  2. Which translation API should I use?              │
│  3. Any design preferences?                          │
└──────────────────────────────────────────────────────┘
```

Type your answers in the input field and click **"Send Answer"**. **Enter key does not send** (it inserts a newline).

```
1. Plain HTML/CSS/JavaScript (no framework)
2. Please use https://api.mymemory.translated.net (no API key needed)
3. Simple and clean is fine
```

Claude may ask follow-up questions. Answer them the same way.

When Claude has enough information, click **"Next"** to move to the prompt generation phase.

---

## Step 12 — Review the prompt and execute

After clicking "Next", Claude generates a prompt and displays it in the chat panel:

```
┌──────────────────────────────────────────────────────┐
│ Generated Prompt                                     │
│  Create translator.html.                             │
│  - Japanese input field (id="japanese")              │
│  - English input field (id="english")                │
│  - Translation API: https://api.mymemory.translated.net│
│  ...                                                 │
└──────────────────────────────────────────────────────┘
```

If the prompt looks right, click **"Confirm & Execute"** without entering anything in the feedback field.

To revise, type your feedback (e.g. "Please also add X") and click **"Regenerate"**. You can repeat this as many times as you want.

---

## Step 13 — Wait for generation to complete

After clicking "Confirm & Execute", Claude's output streams into the log area in real time:

```
[SYSTEM] Instruction received

[Claude] Running Claude Code CLI...

(Claude's thinking and work logs appear here)
(File reading, code generation, and file writing happen automatically)

[GIT] Committing changes...
[main abc1234] Please build a simple single-page web app...

[SYSTEM] Done
```

When **"Done"** appears and the status returns to **"idle"**, generation is complete.
Everything including the commit is done automatically. Allow 1–3 minutes.

---

## Step 13-2 — Review and approve test cases

After implementation, the step bar moves to the "Unit Test" step. Click **"Generate test cases"** to have Claude generate test cases.

```
┌──────────────────────────────────────────────────────┐
│ Test Cases                                           │
│ — Approve to generate and run test code              │
│                                                      │
│ | Target screen | Test item | Operation | Expected  │
│ |----------------|----------|-----------|---------|   │
│ | Translation    | EN→JA    | Type text → Translate | Japanese appears |
│ | Translation    | Empty    | Submit with empty field | Error shown |
│ ...                                                  │
│                                                      │
│  [Request revision]  [Skip]  [Approve & run tests]   │
└──────────────────────────────────────────────────────┘
```

**Review the test cases.**

- **If they look good**: Click **"Approve & run tests"**.
- **To request revisions**: Type your request in the input field and click **"Request revision"**. Claude will regenerate the test cases.
- **To skip testing**: Click **"Skip"**.

After approving, Claude automatically:

1. Generates test code and saves it in the container
2. Installs required dependencies
3. Runs the tests
4. Auto-fixes on failure (up to 3 attempts)

Test progress streams into the log area in real time:

```
[TEST] Generating test code...
[TEST] Running tests: npm test -- --watchAll=false
[TEST] ✅ Tests passed
[GIT] test: add unit tests (pass)
[TEST] Report saved: /workspace/repo/test-reports/test-report-...-unit.md
[SYSTEM] Tests complete: 19 passed, 0 failed
```

If tests fail, auto-fix runs. After 3 failed attempts, you'll be notified.

---

## Step 13-3 — Review and approve the implementation

After tests complete, the step bar moves to "Review" and the review screen appears:

```
┌──────────────────────────────────────────────────────┐
│ Review                                               │
│ — Tests passed. Please review the implementation.   │
│                                                      │
│ Executed prompt                                      │
│  Create translator.html...                           │
│                                                      │
│ Approved test cases                                  │
│  | Target screen | Test item | ...                  │
│                                                      │
│ Review the test results and changes in the log.     │
│ Click "Approve" if satisfied, or "Send back"        │
│ if revisions are needed.                            │
│                                                      │
│  [Send back]  [Approve]                              │
└──────────────────────────────────────────────────────┘
```

Review the test results and changes in the log area on the left.

- **If everything looks good**: Click **"Approve"** → proceed to Git Push.
- **If revisions are needed**: Click **"Send back"** → returns to the instruction input screen (previous instruction is restored).

> **Resuming**: If you reopen the task detail screen, the step bar shows your previous state and you can navigate to any completed step. See [Resuming from a previous session](#resuming-from-a-previous-session).

---

## Step 14 — Push to GitHub

Code generation and commits happen automatically. All that's left is to push to GitHub.

Click the **"Git Push"** button on the task detail screen.

When you see the following in the log area, the push was successful:

```
[GIT] Pushing branch 'xolvien/1-translation-app'...
To git@github.com:your-username/repository-name.git
 * [new branch]      xolvien/1-translation-app -> xolvien/1-translation-app
[GIT] Push complete
```

Open your GitHub repository page and you'll see `translator.html` on the `xolvien/1-translation-app` branch.

> **Merging to main**: On your GitHub repository page, click **"Compare & pull request"** to create a pull request and merge it into main.

---

## Step 15 — Verify the translation app locally

To open the generated `translator.html` locally:

**Windows:**
```bash
docker cp xolvien-task-1:/workspace/repo/translator.html ~/translator.html
explorer.exe ~/translator.html
```

**Mac:**
```bash
docker cp xolvien-task-1:/workspace/repo/translator.html ~/Desktop/translator.html
```

### Test it

**Japanese → English:**
1. Type `こんにちは、世界` in the top input field.
2. Click **"Translate to English"**.
3. If `Hello, World` appears in the bottom field, it works.

**English → Japanese:**
1. Type `I love programming` in the bottom input field.
2. Click **"Translate to Japanese"**.
3. If a Japanese translation appears in the top field, it works.

---

# Congratulations!

You've built a translation app using Xolvien.

---

# Continuing from the Second Session

## Starting up (every session)

Same steps as Part 2.

1. Start the backend in Terminal A
2. Start the frontend in Terminal B
3. Open `http://localhost:5173` in a browser

---

## Starting new work

Previous tasks remain on the screen. **Create a new task for each new piece of work.**

**To add features or fix an existing program:**

1. Click **"New task"**
2. Repository: open the **"Select existing repository"** tab and choose from the list
3. Enter a title describing the work (e.g. `Add error handling`)
4. Leave branch name blank → a new branch is automatically created from `main`
5. Click **"Create task"**

**To build a new program:**

1. **Create a new repository on GitHub** (if one doesn't exist yet)
2. Click **"New task"**
3. Repository: open **"Add new repository"** tab and enter the GitHub SSH URL
4. Enter a title
5. Click **"Create task"**

Then follow Steps 9–14 as before.

---

## Resuming a past task

The task list is shown on the dashboard (home screen). Click a task to open the task detail screen and continue giving instructions.

Note: **Restarting Xolvien also restarts containers.** If a past task's container is stopped after restarting, delete the task and recreate it.

---

## Resuming from a previous session

When you open the task detail screen, the previous test execution state is automatically detected.
The **step bar** at the top of the control panel shows which step you're on at a glance:

```
Implement → Unit Test → Integration Test* → E2E Test* → Review
    ✅           ✅             ✅
```

Step bar icon/color meanings:

| Display | Meaning |
|---|---|
| ✅ green | Completed (tests passed) |
| ❌ red | Completed (tests failed) |
| Blue (bold) | Current step |
| Grey | Not yet started |
| Grey italic (* suffix) | Future unimplemented step |

**Click any completed step** to switch to that screen.
For example, click "Unit Test" to review or re-edit the previously generated test cases.
Click "Implement" to return to the instruction input screen with your previous instruction restored.

On page load, Xolvien automatically moves to the screen after the last completed step.

### Resuming after backend restart or update

If you stopped Xolvien with `docker compose down` and restarted, or restarted the backend after an update:

1. **Restart the backend** (follow the "Terminal A: Start the backend" steps above).
   - If applying an update, run `alembic upgrade head` first.
2. **Reload the browser** (F5 or Ctrl+R).
3. Click the target task on the dashboard to open the task detail screen.
4. Select the step to continue from in the step bar.

**If "Unit Test" is selected but test cases are not displayed:**

If the test case storage format changed in an update, previous tasks may show "No test cases generated yet."
A **"Generate test cases"** button will appear — click it to restart from test case generation. No need to redo the implementation.

---

## Sending additional instructions

You can send instructions to the same task as many times as you want. After clicking "Approve" on the review screen, you return to the instruction input screen where you can enter a new instruction and repeat the whole flow.

```
Task "Build translation app"
  └─ Instruction 1: "Create translator.html"
       → Execute → Review test cases → Run tests → Review → Approve → Commit
  └─ Instruction 2: "Improve the design"
       → Execute → Review test cases → Run tests → Review → Approve → Commit
  └─ Instruction 3: "Add error handling"
       → Execute → Review test cases → Run tests → Review → Approve → Commit
```

All changes accumulate on the same branch. You can push everything at once with **"Git Push"**.

---

# Shutting Down

1. Press `Ctrl + C` in Terminal A to stop the backend.
2. Press `Ctrl + C` in Terminal B to stop the frontend.
3. Stop the database:

```bash
cd xolvien   # the directory you cloned into
docker compose down
```

Done when you see:

```
[+] Running 2/2
 ✔ Container xolvien-db  Removed
 ✔ Network xolvien_default  Removed
```

---

# Troubleshooting

## Status shows "failed"

Check the log area for error details.

**"Failed to clone repository":**

- Verify the repository URL is in `git@github.com:username/repo-name.git` format.
- Verify your SSH key is registered on GitHub (run `ssh -T git@github.com` — `Hi username!` means it works).

Delete the task and recreate it. To delete: click the red **"Delete"** button on the task card in the dashboard.

**"Failed to initialize container":**

The Docker workspace image hasn't been built. Run Step 6.

---

## Status stays "pending" and never changes

The backend may not be running. Check Terminal A for `Application startup complete.`

If it's not there, restart the backend:

```bash
cd xolvien/backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

## The "Send" button is grey and can't be clicked

The "Send" button is only active when the status is **"idle"** and there's text in the input field.

| Status shown | Meaning | Action |
|---|---|---|
| `pending` | Waiting | Wait |
| `initializing` | Preparing | Wait |
| `running` | Executing | Wait for completion |
| `failed` | Failed | See troubleshooting above |

After clicking "Send", the button changes to "Send Answer" / "Next" — this means the requirement clarification phase has started. Wait for Claude's questions to appear.

---

## Error on `docker cp`

**"No such container":**

The container name is wrong. Find it with:

```bash
docker ps --filter "name=xolvien-task"
```

You'll see something like:

```
CONTAINER ID   IMAGE                      COMMAND                NAMES
abc123def456   xolvien-workspace:latest  "/bin/sh -c 'tail -f…" xolvien-task-1
```

Use the name in the `NAMES` column (e.g. `xolvien-task-1`) in your `docker cp` command.

---

## Claude didn't generate `translator.html`

Depending on how the instruction was interpreted, the file may have a different name. Check the container:

(Replace `xolvien-task-1` with your actual container name)

```bash
docker exec xolvien-task-1 ls /workspace/repo/
```

Find the `.html` file and use that name in your `docker cp` command.

---

## Git Push fails with an error

**"Permission denied (publickey)":**

SSH key authentication failed. Verify on your host:

```bash
ssh -T git@github.com
```

If `Hi username!` appears, you're authenticated. If not, check your SSH key setup.

**"rejected" or "failed to push":**

Someone else may have pushed to the same branch. Delete the task and recreate it.

---

## Claude Code CLI authentication error in logs

If authentication-related errors appear in the log area, the host Claude Code CLI credentials may be the issue.

Verify on your host:

```bash
claude --version        # check that a version number appears
ls ~/.claude/           # check that credential files exist
```

If credentials are missing, run `claude` and log in again.
