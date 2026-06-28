# Xolvien — Specification

**Last updated**: 2026-06-15

This document defines the complete intended specification of Xolvien. Implementation status is tracked separately in `roadmap.md`.

---

## 1. System Overview

### 1.1 Purpose

Solves the following problems with GitHub Actions + Claude Code AI-driven development:

- No way to build and test locally — only repository-level operations are available.
- A new branch is created from master on every fix, preventing iterative work on the same branch.
- All commits are attributed to Claude; commits cannot be made under the developer's name.

### 1.2 Users

Single-user deployment. Multi-user support is a future extension.

### 1.3 Tech Stack

| Area | Technology |
|---|---|
| Backend | Python 3.11 + FastAPI + SQLAlchemy 2.0 (async) |
| Database | PostgreSQL 16 (started via Docker Compose) |
| Container management | docker-py |
| AI execution | Claude Code CLI (Max Plan, `--dangerously-skip-permissions` mode) |
| Frontend | React 18 + Vite + TypeScript |
| Real-time communication | WebSocket (FastAPI) |
| Authentication | Fixed Bearer token (`dev-token-12345`) |
| Document rendering | Jinja2 (HTML templates), openpyxl (Excel templates) |
| File parsing | pdfplumber (PDF), python-docx (Word), openpyxl (Excel) — *planned; not yet wired (see §5)* |

---

## 2. Data Model

### 2.1 Entity Relationships

```
User ──< Repository ──< Task ──< Instruction
                              └──< TestRun
                              └──< TaskLog
                              └──< TaskDocument
                              └──< Upload
```

### 2.2 Task Status Transitions

```
PENDING → INITIALIZING → IDLE → RUNNING → TESTING → COMPLETED
```

Errors are logged as `TaskLog` entries with `source=SYSTEM`. On error or stop, the task returns to `IDLE` so work can continue without recreating the task.

### 2.3 Table Definitions

**tasks**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| repository_id | INTEGER FK | |
| title | VARCHAR | Task title |
| branch_name | VARCHAR | Working branch name |
| status | ENUM | PENDING / INITIALIZING / IDLE / RUNNING / TESTING / COMPLETED |
| container_id | VARCHAR | Docker container ID |
| container_name | VARCHAR | Docker container name |
| workspace_path | VARCHAR | Workspace path inside the container (`/workspace`) |

**instructions**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| content | TEXT | Executed prompt |
| status | ENUM | PENDING / RUNNING / COMPLETED / FAILED |
| output | TEXT | Claude's output |
| exit_code | INTEGER | |

**test_case_items** (specification, immutable per generation)

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| test_type | ENUM | UNIT / INTEGRATION / E2E (default: UNIT) |
| seq_no | INTEGER | Sequence number within test type (UNIT: TC-001, INTEGRATION: ITC-001, E2E: E2E-001) |
| target_screen | VARCHAR | Target screen (for E2E: target scenario name) |
| test_item | VARCHAR | Test item description |
| operation | TEXT | Operation steps (for E2E: browser operation steps) |
| expected_output | TEXT | Concrete expected output value |
| function_name | VARCHAR | Test function name (e.g. test_tc001_login / test_itc001_api_login / test_e2e001_login_flow) |

**test_case_results** (per-run records)

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| test_case_item_id | INTEGER FK | |
| test_run_id | INTEGER FK | |
| actual_output | TEXT | Actual output value |
| verdict | ENUM | PASSED / FAILED / ERROR / SKIPPED |
| executed_at | DATETIME | |

**test_runs**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| test_type | ENUM | UNIT / INTEGRATION / E2E |
| retry_count | INTEGER | Number of auto-fix attempts |
| report_path | VARCHAR | Path to the test report |
| passed | BOOLEAN | |
| summary | TEXT | Summary string |

**task_logs**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| source | ENUM | SYSTEM / DOCKER / CLAUDE / GIT / TEST |
| message | TEXT | |

**task_documents**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | |
| doc_type | ENUM | REQUIREMENTS / EXTERNAL_DESIGN / INTERNAL_DESIGN / SPECIFICATION / TEST_REPORT |
| yaml_content | TEXT | Claude-generated YAML conforming to a fixed schema per doc_type |
| generated_at | DATETIME | |

Re-generating a document overwrites the existing row for the same `task_id` + `doc_type` combination.

**uploads** (attached to a **Repository**, not a task — see §5)

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| repository_id | INTEGER FK | Owning repository |
| filename | VARCHAR | Original filename |
| content_type | VARCHAR | MIME type as received |
| stored_path | VARCHAR | Absolute path on the persistent `task_data` volume (`/data/uploads/repos/{repository_id}/{upload_id}_{filename}`) |
| size | INTEGER | Byte size |
| created_at | DATETIME | |

---

## 3. API Endpoints

### 3.1 Endpoint List

```
GET  /health
GET  /docs  (Swagger UI)

# Repository management
GET    /api/v1/repositories
POST   /api/v1/repositories
GET    /api/v1/repositories/{id}
PATCH  /api/v1/repositories/{id}
DELETE /api/v1/repositories/{id}

# GitHub repository creation
POST   /api/v1/repositories/github

# Task management
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/{id}
PATCH  /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}/stop
DELETE /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}/git/push          ← streaming

# Instructions & execution
POST /api/v1/tasks/{id}/instructions
POST /api/v1/tasks/{id}/instructions/execute-stream                    ← streaming
POST /api/v1/tasks/{id}/instructions/clarify                           ← streaming
POST /api/v1/tasks/{id}/instructions/generate-prompt                   ← streaming
POST /api/v1/tasks/{id}/instructions/reset-workspace
POST /api/v1/tasks/{id}/instructions/generate-test-cases               ← streaming
POST /api/v1/tasks/{id}/instructions/run-unit-tests                    ← streaming
POST /api/v1/tasks/{id}/instructions/generate-integration-test-cases   ← streaming
POST /api/v1/tasks/{id}/instructions/run-integration-tests             ← streaming
POST /api/v1/tasks/{id}/instructions/generate-e2e-test-cases           ← streaming
POST /api/v1/tasks/{id}/instructions/run-e2e-tests                     ← streaming
GET  /api/v1/tasks/{id}/instructions
GET  /api/v1/tasks/{id}/instructions/{instruction_id}
GET  /api/v1/tasks/{id}/instructions/last-completed

# Tests
POST /api/v1/tasks/{id}/test-runs
GET  /api/v1/tasks/{id}/test-runs
GET  /api/v1/tasks/{id}/test-runs/{run_id}

# Test cases
GET  /api/v1/tasks/{id}/test-cases
GET  /api/v1/tasks/{id}/test-cases/{item_id}/results

# Logs
GET /api/v1/tasks/{id}/logs
WS  /api/v1/ws/tasks/{id}/logs    ← WebSocket
WS  /api/v1/ws/tasks/{id}/status  ← WebSocket

# File uploads (repository-scoped)
POST   /api/v1/repositories/{id}/uploads                              ← multipart/form-data, multiple files
GET    /api/v1/repositories/{id}/uploads                              ← list a repository's uploads
DELETE /api/v1/repositories/{id}/uploads/{upload_id}                  ← remove a file + metadata

# Document generation and rendering
POST /api/v1/tasks/{id}/documents/generate/{doc_type}                  ← called internally at phase transitions
POST /api/v1/tasks/{id}/documents/{doc_type}/render?format=excel|html  ← returns file download
GET  /api/v1/tasks/{id}/documents                                       ← list generated documents for a task

# Template management
GET  /api/v1/templates/{doc_type}                                       ← list default + custom templates
POST /api/v1/templates/{doc_type}                                       ← upload custom Excel or HTML template
```

### 3.2 Authentication

All endpoints require the `Authorization: Bearer dev-token-12345` header.

---

## 4. Execution Flow

### 4.1 Task Flow

```
1.  Enter instruction text (and optionally attach files)
2.  Requirement clarification (Claude ↔ user Q&A, one question at a time) ← can be skipped
3.  Prompt review → user approves
    → Requirements definition document auto-generated (YAML → task_documents)
4.  Claude executes implementation (commits automatically)
    → External design document auto-generated
    → Internal design document auto-generated
5.  Claude auto-generates unit test case list (TC-001 format)
6.  User reviews unit test cases → approves
7.  Claude generates unit test code → runs tests
8.  Auto-fix loop on failure (up to 3 attempts)
9.  Unit tests pass → auto-advance to integration test step
10. Claude generates integration test case list (ITC-001 format)
11. User reviews integration test cases → approves
12. Claude generates integration test code → starts server + DB → runs tests
13. Auto-fix loop on failure (up to 3 attempts)
14. Integration tests pass → auto-advance to E2E test step
15. Claude generates E2E test case list (E2E-001 format)
16. User reviews E2E test cases → approves
17. Claude generates Playwright test code → runs headless browser tests (with screenshots)
18. Auto-fix loop on failure (up to 3 attempts)
    → Specification document auto-generated
    → Test report document auto-generated
19. User reviews implementation → approve / send back
20. Git Push
```

### 4.2 User Decision Points

| Timing | What to review | On approve | On send back |
|---|---|---|---|
| Step 3 | Does the prompt match the intent? | Start implementation | Revise instruction and regenerate |
| Step 6 | Are unit test cases comprehensive? | Generate & run unit test code | Revise test cases and re-approve |
| Step 11 | Are integration test cases comprehensive? | Generate & run integration test code | Revise test cases and re-approve |
| Step 16 | Are E2E test cases comprehensive? | Generate & run Playwright test code | Revise test cases and re-approve |
| Step 19 | Does the implementation match intent? | Confirm commit → next phase or Push | Return to instruction input (previous instruction restored) |

### 4.3 Session Resume

When the task detail screen is opened, the backend fetches `TestRun` history and the last completed `Instruction` from the DB and reflects the state in the step bar. The screen automatically advances to the step after the last completed one.

Each completed step in the step bar can be clicked to navigate directly to that screen.

---

## 5. File Upload

Users can attach reference files (spec/design documents, screen mockups) when text alone is insufficient — for example, uploading a specification and writing "implement according to this spec."

Uploads are scoped to the **Repository (project)**, not to a single task. A project's fixes each become a separate task, so repository-scoped uploads are referenced repeatedly by every fix-task without re-uploading.

> **Status (2026-06-28):** the upload pipeline is implemented, but the primary use case is **blocked**: Claude Code CLI cannot read binary files (`.xlsx`/`.docx`/`.pdf`). See `roadmap.md` Sprint 2 for the candidate fixes. Plain-text/Markdown uploads work today.

### 5.1 How files reach Claude

This project drives Claude via the **Claude Code CLI inside the task container**, not the Claude API. On each Claude run (`clarify_requirements()` / `execute_instruction()`), `DockerService.copy_uploads_to_container()` copies the repository's uploads from the host volume into `/workspace/uploads/`, and `ClaudeCodeService._prepare_uploads()` injects an "Uploaded Reference Files" section into the prompt listing the paths. Claude reads the files with its `Read` tool.

| Type | Status |
|---|---|
| Markdown / plain text | ✅ Read directly by Claude Code. |
| PNG / JPG | Untested (Claude Code image support not yet verified in this path). |
| PDF / Word (.docx) / Excel (.xlsx) | ❌ Blocked — Claude Code's `Read` tool rejects binary files. Needs server-side text extraction (`pdfplumber`/`python-docx`/`openpyxl`) or a Claude API `document`/`image` path. |

### 5.2 Storage

- Files are stored on the persistent `task_data` volume at `/data/uploads/repos/{repository_id}/{upload_id}_{filename}`, surviving container rebuilds, per-task volume removal, and Reset & Rebuild.
- File bytes live on the volume; metadata in the `uploads` table.
- Multiple files can be attached per repository; re-copied into the container on every Claude run.

### 5.3 Frontend Behavior

- A `RepositoryUploads` component (paperclip button) is shown in **TaskCreate** (when an existing repository is selected) and **TaskDetail** (a repository strip below the topbar).
- Attached filenames appear as chips; each chip has a remove (×) button.
- Files are uploaded immediately on selection.
- The instruction textarea is not auto-populated — files are attached silently.

---

## 6. Document Generation

Documents are generated automatically at each phase transition. They are stored as YAML (structured data) in the `task_documents` table and rendered into Excel or HTML via templates at download time.

### 6.1 Document Types and Generation Timing

| Document | Generated when | Source material |
|---|---|---|
| Requirements definition | Prompt confirmed (step 3) | Clarified Q&A, confirmed prompt |
| External design | Implementation complete (step 4) | Confirmed prompt, repo file list |
| Internal design | Implementation complete (step 4) | Generated code, DB schema, class/method structure |
| Specification | All tests complete (step 18) | All of the above + test case items |
| Test report | All tests complete (step 18) | Test case results (UT / IT / E2E) |

### 6.2 Document Content Definitions

**Requirements definition**
- Feature requirements list (what the system does)
- Screen list and screen transition flow
- Use cases (who does what, under what conditions)
- Non-functional requirements (if any emerge from clarify)

**External design**
- Screen design: each screen's layout, fields, buttons, and validation rules
- Operation flows: user action → system response, per screen
- API list: endpoint, method, request/response schema
- External integrations (if any)

**Internal design**
- DB design: tables, columns, types, constraints, relationships
- Class design: class names, responsibilities, dependencies
- Method/property design: signatures, arguments, return types, processing summary

**Specification**
- All behaviors defined at minimum unit: input value → operation → expected result
- Each item linked to a test case ID (TC-NNN / ITC-NNN / E2E-NNN)

**Test report**
- Test execution summary (passed / failed counts per type: UT / IT / E2E)
- Per-test-case result: TC-ID, test item, expected output, actual output, verdict, executed_at

### 6.3 YAML Schema

Each document is stored as a YAML string conforming to a fixed schema per `doc_type`. The schema defines top-level keys, array structures, and field names so that templates can reliably reference them by name.

### 6.4 Template System

- **Two output formats**: Excel (`.xlsx`) and HTML (`.html`)
- **Template engines**: Jinja2 for HTML; openpyxl for Excel (cell-level data injection)
- **Standard templates**: bundled under `backend/templates/default/{doc_type}/` for both formats
- **Custom templates**: uploaded by the user via `POST /api/v1/templates/{doc_type}`; stored under `backend/templates/{user_id}/{doc_type}/` and take precedence over the default
- **Rendering**: `POST /api/v1/tasks/{id}/documents/{doc_type}/render?format=excel|html` loads YAML from DB, selects the appropriate template, renders, and returns the file as a download response
- PDF export is performed by the user via browser print or Excel

### 6.5 Frontend Behavior

- Document generation is fully automatic — no button press required.
- After each phase transition that triggers generation, a notice appears in the right pane chat history (e.g. "Requirements definition generated").
- A "Documents" panel in the task detail page lists all generated documents for the task with their `generated_at` timestamps.
- Each document row has two download buttons: `Excel` and `HTML`.
- A "Templates" section in settings allows uploading custom Excel/HTML templates per document type.

---

## 7. Left-Pane Activity Log

The left pane is a **console.log-equivalent raw view**: Claude Code CLI's `stream-json` output flows through **unmodified** (no `[Thinking]`/`[Tool:]`/`[Result]` reformatting). This raw activity is (planned to be) written to a host log file for later review.

### 7.1 What is shown / logged

Everything streamed during a Claude run, verbatim, as raw `stream-json` lines:
- `{"type":"_xolvien_input","prompt":...}` — the full prompt sent to Claude (input echo)
- `{"type":"system",...}`, `{"type":"stream_event",...}` (thinking/text/tool deltas), `{"type":"user",...}` tool results — Claude's raw output
- `{"type":"_xolvien_keepalive"}` — internal stream keepalive (filtered from the display, every 15s)

The same raw stream is parsed on the frontend (`createStreamJsonRouter`) only to reconstruct the text the **right pane** needs (clarify question / `PROMPT_READY` / generated prompt); the left pane itself is never reformatted.

Persistent file logging is planned (Sprint 4.1): one file per run, each line `[{ISO8601 timestamp}] {raw line}`.

### 7.2 Storage

- Log files are written to `backend/logs/tasks/{task_id}/` on the host.
- One file per instruction execution: `instruction_{instruction_id}_{YYYYMMDD_HHMMSS}.log`
- Files are never deleted automatically.
- `backend/logs/` is bind-mounted from the host into the backend process so logs persist independently of container lifecycle.
- `backend/logs/` is listed in `.gitignore`.

### 7.3 Implementation

- `ClaudeCodeService.execute_instruction()` opens the log file before streaming starts and appends each yielded line using `aiofiles` (non-blocking).
- The log directory is created automatically if it does not exist.

---

## 8. Frontend UI

### 8.1 Screen Layout

| Screen | Description |
|---|---|
| Dashboard | Task list. Status badges, create button. |
| Task creation modal | Repository selection (existing / new / GitHub), title and branch name inputs. |
| Task detail screen | Left/right split pane (log area / control panel), resizable. |
| Settings | Custom template upload per document type. |

### 8.2 Control Panel Design (ChatEntry append-only)

An append-only chat history via a `ChatEntry` union type. All phases accumulate as persistent cards.

```
ChatEntry =
  | user_instruction               ← user's instruction (with attached file chips if any)
  | clarify_question               ← Claude's question (parsed into question text + option buttons)
  | clarify_answer                 ← user's answer
  | clarify_streaming              ← streaming in progress
  | prompt_generating              ← prompt being generated
  | prompt_generated               ← generated prompt (with confirmed flag)
  | implementation_running
  | implementation_done
  | test_cases_generating
  | test_cases_ready               ← unit test case list (with approved flag)
  | integration_test_cases_generating
  | integration_test_cases_ready   ← integration test case list (with approved flag)
  | e2e_test_cases_generating
  | e2e_test_cases_ready           ← E2E test case list (with approved flag)
  | test_running
  | test_done                      ← test result summary
  | review                         ← implementation review (with resolved flag)
  | error
  | info                           ← system notice (including document generation notices)
```

The button set below the input area switches based on `selectedStep`:

| selectedStep | Textarea | Buttons |
|---|---|---|
| implement — initial (no prior completed instruction) | Enabled | Send |
| implement — redo (prior completed instruction exists) | Enabled | Modify / Reset & Rebuild |
| implement — clarify in progress | Enabled | Send Answer / Skip to generate prompt (option buttons also shown in the question card) |
| implement — unconfirmed prompt present | Enabled | Confirm & Execute / Regenerate |
| unit_test | Disabled | Generate test cases / Approve & run tests / Request revision / Re-run tests / Regenerate test cases |
| integration_test | Disabled | Generate integration test cases / Approve & run integration tests / Request revision / Re-run integration tests / Regenerate integration test cases |
| e2e_test | Disabled | Generate E2E test cases / Approve & run E2E tests / Request revision / Re-run E2E tests / Regenerate E2E test cases |
| review | Disabled | Approve / Send back |

**Modify vs Reset & Rebuild**

When a prior completed instruction exists, the implement step shows two buttons:

- **Modify**: Starts the clarify → prompt generation → execute flow with the existing `/workspace/repo` intact. Claude makes targeted changes to existing code.
- **Reset & Rebuild**: Calls `POST /reset-workspace` to delete all files under `/workspace/repo` and reinitialise a bare git repo, then starts the clarify flow from scratch.

### 8.3 Step Bar

Always visible at the top of the control panel. Steps: Implement → Unit Test → Integration Test → E2E Test → Review

| Color | Meaning |
|---|---|
| Green | Completed (test passed) |
| Red | Completed (test failed) |
| Blue (bold) | Current step |
| Yellow background, black text | Selected (navigated to by click) |
| Grey | Not yet started |

### 8.4 Real-time Progress Display

During test case generation (unit / integration / E2E), the chat entry updates live:

- Shows `Generating test cases: done / total  (~mm:ss remaining)` (EN) or `テストケース生成中: done / total 件  (残り約mm:ss)` (JA).
- Remaining time computed from elapsed time per batch × remaining batches, formatted as `mm:ss` (or `hh:mm:ss` if ≥ 1 hour).
- The same format is used for test code generation progress during test execution.

### 8.5 Test Case Review Card Operations

- Review TC-ID, target screen, test item, operation, and expected output in the chat history card.
- Click "Approve & run tests" to start testing.
- Click "Request revision" to expand an inline input field. Enter revision details and click "Send" to regenerate test cases.
- After test completion, both "Re-run tests" and "Regenerate test cases" are available.

### 8.6 Test Result Display

- Test result summary shows TC-count-based numbers (e.g. "45 passed, 5 failed").
- Test result table: TC-ID / test item / expected output / actual output / verdict / executed_at.
- Actual output collected from each test function's `console.log('XOLVIEN_RESULT:{...}')` output (recorded for both PASSED and FAILED).
- Restored from DB `test_case_results` after page reload.

---

## 9. Backend Design

### 9.1 Directory Structure

```
backend/
├── app/
│   ├── main.py          # FastAPI app, router registration, CORS
│   ├── config.py        # Pydantic Settings (loads from .env)
│   ├── database.py      # Async SQLAlchemy engine + get_db()
│   ├── models/          # SQLAlchemy ORM models
│   ├── schemas/         # Pydantic request/response schemas
│   ├── api/             # FastAPI routers (one file per resource)
│   ├── services/
│   │   ├── docker_service.py    # Container lifecycle management
│   │   ├── claude_service.py    # Claude Code CLI execution & test running
│   │   ├── document_service.py  # Document YAML generation and template rendering (planned)
│   │   │                         # (uploads have no dedicated service — see §9.4)
│   │   └── test_service.py      # Test result parsing
│   └── websocket/
│       └── manager.py           # Per-task WebSocket connection pool
├── templates/
│   ├── default/                 # Bundled standard templates (Excel + HTML per doc_type)
│   └── {user_id}/               # User-uploaded custom templates
└── logs/
    └── tasks/
        └── {task_id}/           # Left-pane activity logs (host-side, persisted; planned)

Repository uploads are NOT under backend/; they live on the persistent
`task_data` volume at /data/uploads/repos/{repository_id}/.
```

### 9.2 ClaudeCodeService Key Methods

| Method | Description |
|---|---|
| `execute_instruction()` | Executes an arbitrary instruction via Claude Agent. Yields log lines as an AsyncGenerator. Writes each line to the activity log file via `aiofiles`. |
| `clarify_requirements()` | Requirement clarification Q&A. Asks one question at a time, each with a bulleted `Options:` / `選択肢:` block. Continues until the user clicks "Skip to generate prompt". |
| `generate_prompt()` | Converts a brief instruction into an optimized prompt. |
| `generate_test_cases()` | Generates UNIT (`TC-NNN`), INTEGRATION (`ITC-NNN`), or E2E (`E2E-NNN`) test cases based on `test_type`. Uses batch generation via `--output-format json` + `--resume` (10 cases per call). Yields `[XOLVIEN_PROGRESS] done/total elapsed_ms=N eta_ms=0` after each batch. |
| `run_unit_tests()` | Wrapper passing `TestType.UNIT` to `_run_tests()`. |
| `run_integration_tests()` | Wrapper passing `TestType.INTEGRATION` to `_run_tests()`. |
| `run_e2e_tests()` | Wrapper passing `TestType.E2E` to `_run_tests()`. |
| `_run_tests()` | Shared implementation: generate test code → run → auto-fix loop (up to 3 attempts). Aborts immediately on infrastructure errors (EACCES etc.). |
| `_detect_test_command()` | Checks `package.json` first, then `pyproject.toml` / `setup.py`. Does not infer Python from `requirements.txt` alone. |
| `_extract_result_for_function()` | Handles Jest (`--verbose` `✓/✕ TC-xxx:`) and pytest verbose (`PASSED/FAILED`) output to determine verdict. |

### 9.3 DocumentService

| Method | Description |
|---|---|
| `generate_document(task_id, doc_type)` | Calls Claude to generate a YAML document of the given type. Saves to `task_documents`. Called internally at phase transitions. |
| `render_document(task_id, doc_type, format)` | Loads YAML from DB, selects the appropriate template (custom if available, otherwise default), renders via Jinja2 (HTML) or openpyxl (Excel), returns file bytes. |

### 9.4 Uploads (repository-scoped)

There is no standalone UploadService; the logic spans the repository API and the existing services:

| Location | Responsibility |
|---|---|
| `api/repositories.py` | `POST/GET/DELETE /repositories/{id}/uploads` — streams files to the volume with `aiofiles`, manages the `uploads` table. |
| `DockerService.copy_uploads_to_container()` | Tars a repository's uploads into the container's `/workspace/uploads/` on each Claude run. |
| `ClaudeCodeService._prepare_uploads()` | Copies uploads + injects an "Uploaded Reference Files" prompt section into `clarify_requirements()` / `execute_instruction()`. |

*(Binary text-extraction — `pdfplumber`/`python-docx`/`openpyxl` — is planned but not yet wired; see §5 status.)*

### 9.5 Docker Workspace

- Image: `xolvien-workspace:latest` (`docker/workspace/Dockerfile`)
- Contents: Python 3.11-slim + Git + Node.js 20 + Claude Code CLI
- Per-task volume: `xolvien-task-{task_id}-data` (mounted at `/workspace`)
- SSH keys: host `~/.ssh/` mounted into the container (for GitHub auth)
- Claude credentials: only `~/.claude/.credentials.json` copied into `/home/xolvien/.claude/`

### 9.6 Test Execution Details

- Node.js projects: `npm test -- --watchAll=false --verbose 2>&1`; Python: `python -m pytest -v 2>&1`
- Before test execution, the backend pre-creates JSONL result files with `chmod 777`: `/tmp/xolvien_tc_results.jsonl` (unit), `/tmp/xolvien_itc_results.jsonl` (integration), `/tmp/xolvien_e2e_results.jsonl` (E2E)
- Test code logs actual output via `console.log('XOLVIEN_RESULT:{"tc_id":"TC-001","actual":"..."}')` for both PASSED and FAILED
- `test_run.summary` aggregated from `test_case_results` verdicts (TC-count based)
- Auto-fix loop: up to 3 attempts; fix prompt instructs "fix only, do not re-run tests"; backend handles re-running
- EACCES / EPERM / Cannot find module abort the loop immediately
- Test report path: `/workspace/repo/test-reports/test-report-{datetime}-{type}.md`
- E2E screenshots saved to `/workspace/repo/test-reports/screenshots/{E2E-NNN}.png`

### 9.7 Design Decisions

**Keepalive thread prevents stream silence**

`_RUNNER_SCRIPT` and `_RUNNER_SCRIPT_AGENT` spawn a daemon thread that writes `[Claude] ...\n` to stdout every 3 seconds while Claude is running. This ensures the `execute_command_stream` chunk timeout (120 s) is never hit during normal inter-tool pauses.

**Errors are logged, not persisted as task status**

When `execute_instruction()` raises an error, the task status is reset to `IDLE` and the error is appended to `task_logs` with `source=SYSTEM`. `FAILED` and `STOPPED` statuses do not exist — they would block all UI operations without providing a recovery path.

**Prompt generation runs in agent mode**

For large projects it is impossible to pre-embed all file contents. Claude Agent must select and read relevant files from the repository itself to generate an accurate prompt.

**Streaming uses synchronous blocking**

`execute_command_stream` uses the synchronous docker-py API and simulates async with `asyncio.sleep(0.01)`. This is acceptable for single-user use. Multi-user support will move this to a thread pool via `run_in_executor`.
