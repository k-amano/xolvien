# Xolvien — Current Specification

**Last updated**: 2026-05-24 (keepalive thread, FAILED status on error, credentials copy fix)

This document records the specification as currently implemented. Unimplemented future features are described in `roadmap.md`.

---

## 1. System Overview

### 1.1 Purpose

Solves the following problems with GitHub Actions + Claude Code AI-driven development:

- No way to build and test locally — only repository-level operations are available.
- A new branch is created from master on every fix, preventing iterative work on the same branch.
- All commits are attributed to Claude; commits cannot be made under the developer's name.

### 1.2 Users

Single-user deployment for now. Multi-user support is described in the roadmap.

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

---

## 2. Data Model

### 2.1 Entity Relationships

```
User ──< Repository ──< Task ──< Instruction
                              └──< TestRun
                              └──< TaskLog
```

### 2.2 Task Status Transitions

```
PENDING → INITIALIZING → IDLE → RUNNING → TESTING → COMPLETED
                                                   → FAILED
                                                   → STOPPED
```

### 2.3 Key Table Definitions

**tasks**

| Column | Type | Description |
|---|---|---|
| id | INTEGER PK | |
| repository_id | INTEGER FK | |
| title | VARCHAR | Task title |
| branch_name | VARCHAR | Working branch name |
| status | ENUM | PENDING / INITIALIZING / IDLE / RUNNING / TESTING / COMPLETED / FAILED / STOPPED |
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

**test_case_items** (specification, immutable)

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
POST /api/v1/tasks/{id}/instructions/execute-stream                 ← streaming
POST /api/v1/tasks/{id}/instructions/clarify                        ← streaming
POST /api/v1/tasks/{id}/instructions/generate-prompt               ← streaming
POST /api/v1/tasks/{id}/instructions/generate-test-cases           ← streaming
POST /api/v1/tasks/{id}/instructions/run-unit-tests                ← streaming
POST /api/v1/tasks/{id}/instructions/generate-integration-test-cases  ← streaming
POST /api/v1/tasks/{id}/instructions/run-integration-tests         ← streaming
POST /api/v1/tasks/{id}/instructions/generate-e2e-test-cases       ← streaming
POST /api/v1/tasks/{id}/instructions/run-e2e-tests                 ← streaming
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
```

### 3.2 Authentication

All endpoints require the `Authorization: Bearer dev-token-12345` header.

---

## 4. Execution Flow

### 4.1 New Task Flow (current implementation)

```
1.  Enter instruction
2.  Requirement clarification (Claude ↔ user) ← can be skipped
3.  Prompt review → user approves
4.  Claude executes implementation (commits automatically)
5.  Claude auto-generates unit test case list (TC-001 format)
6.  User reviews unit test cases → approves
7.  Claude generates unit test code → runs tests
8.  Auto-fix loop on failure (up to 3 attempts)
9.  Unit tests pass → auto-advance to integration test step
10. Claude generates integration test case list (ITC-001 format, separate from unit TCs)
11. User reviews integration test cases → approves
12. Claude generates integration test code → starts server + DB → runs tests
13. Auto-fix loop on failure (up to 3 attempts)
14. Integration tests pass → auto-advance to E2E test step
15. Claude generates E2E test case list (E2E-001 format)
16. User reviews E2E test cases → approves
17. Claude generates Playwright test code → runs headless browser tests (with screenshots)
18. Auto-fix loop on failure (up to 3 attempts)
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

## 5. Frontend UI

### 5.1 Screen Layout

| Screen | Description |
|---|---|
| Dashboard | Task list. Status badges, create button. |
| Task creation modal | Repository selection (existing / new), title and branch name inputs. |
| Task detail screen | Left/right split pane (log area / control panel), resizable. |

### 5.2 Control Panel Design (ChatEntry append-only)

Replaced `PromptState`-based screen switching with an append-only chat history via a `ChatEntry` union type. All phases (requirement Q&A / prompt generation / implementation / test cases / test results / review / error / system notices) accumulate as persistent cards in the chat panel.

```
ChatEntry =
  | user_instruction               ← user's instruction
  | clarify_question               ← Claude's question
  | clarify_answer                 ← user's answer
  | clarify_streaming              ← streaming in progress
  | prompt_generating              ← prompt being generated
  | prompt_generated               ← generated prompt (with confirmed flag)
  | implementation_running
  | implementation_done
  | test_cases_generating
  | test_cases_ready               ← unit test case list (with approved flag)
  | integration_test_cases_generating
  | integration_test_cases_ready  ← integration test case list (with approved flag)
  | e2e_test_cases_generating
  | e2e_test_cases_ready          ← E2E test case list (with approved flag)
  | test_running
  | test_done                      ← test result summary
  | review                         ← implementation review (with resolved flag)
  | error
  | info                           ← system notice
```

The button set below the input area switches based on `selectedStep`:

| selectedStep | Textarea | Buttons |
|---|---|---|
| implement (or none selected) | Enabled (instruction input) | Clarify requirements / Skip to generate prompt |
| implement (unconfirmed prompt present) | Enabled (feedback input) | Confirm & Execute / Regenerate |
| unit_test | Disabled | Generate test cases / Approve & run tests / Request revision / Re-run tests / Regenerate test cases |
| integration_test | Disabled | Generate integration test cases / Approve & run integration tests / Request revision / Re-run integration tests / Regenerate integration test cases |
| e2e_test | Disabled | Generate E2E test cases / Approve & run E2E tests / Request revision / Re-run E2E tests / Regenerate E2E test cases |
| review | Disabled | Approve / Send back |

### 5.3 Step Bar

Always visible at the top of the control panel. Steps: Implement → Unit Test → Integration Test → E2E Test → Review

| Color | Meaning |
|---|---|
| Green | Completed (test passed) |
| Red | Completed (test failed) |
| Blue (bold) | Current step |
| Yellow background, black text | Selected (navigated to by click) |
| Grey | Not yet started |

### 5.4 Real-time Progress Display

During test case generation (unit / integration / E2E), the right pane chat entry (`test_cases_generating` etc.) updates live as each batch completes:

- Shows `Generating test cases: done / total  (~mm:ss remaining)` (EN) or `テストケース生成中: done / total 件  (残り約mm:ss)` (JA).
- Remaining time is computed from elapsed time per batch × remaining batches and formatted as `mm:ss` (or `hh:mm:ss` if ≥ 1 hour).
- The same format is used for test code generation progress (`progressGenCode`) during test execution.
- Progress display also appears in the left-pane status banner.

### 5.5 Test Case Review Card Operations

- Review TC-ID, target screen, test item, operation, and expected output in the chat history card.
- Click "Approve & run tests" in the button area below the input to start testing.
- Click "Request revision" to expand an inline input field. Enter revision details and click "Send" to regenerate test cases.
- After test completion, both "Re-run tests" and "Regenerate test cases" are available.

### 5.6 Test Result Display

- Test result summary shows TC-count-based numbers (e.g. "45 passed, 5 failed").
- Test result table: TC-ID / test item / expected output / actual output / verdict / executed_at.
- Actual output is collected by the backend from each test function's `console.log('XOLVIEN_RESULT:{...}')` output (recorded for both PASSED and FAILED).
- Restored from DB `test_case_results` after page reload.

---

## 6. Backend Design

### 6.1 Directory Structure

```
backend/app/
├── main.py          # FastAPI app, router registration, CORS
├── config.py        # Pydantic Settings (loads from .env)
├── database.py      # Async SQLAlchemy engine + get_db()
├── models/          # SQLAlchemy ORM models
├── schemas/         # Pydantic request/response schemas
├── api/             # FastAPI routers (one file per resource)
├── services/
│   ├── docker_service.py   # Container lifecycle management
│   ├── claude_service.py   # Claude Code CLI execution & test running
│   └── test_service.py     # Test result parsing
└── websocket/
    └── manager.py          # Per-task WebSocket connection pool
```

### 6.2 ClaudeCodeService Key Methods

| Method | Description |
|---|---|
| `execute_instruction()` | Executes an arbitrary instruction via Claude Agent. Yields log lines as an AsyncGenerator. |
| `clarify_requirements()` | Requirement clarification Q&A. Asks questions until enough information is gathered. |
| `generate_prompt()` | Converts a brief instruction into an optimized prompt. |
| `generate_test_cases()` | Generates unit (`TC-NNN` / `test_tc001_`), integration (`ITC-NNN` / `test_itc001_`), or E2E (`E2E-NNN` / `test_e2e001_`) test cases based on the `test_type` argument. Deletes only existing TCs of the same `test_type` before saving. Uses batch generation via `--output-format json` + `--resume <session_id>` (10 cases per Claude call) to support large test suites. Yields `[XOLVIEN_PROGRESS] done/total elapsed_ms=N eta_ms=0` after each batch for real-time progress display. |
| `run_unit_tests()` | Wrapper passing `TestType.UNIT` to `_run_tests()`. |
| `run_integration_tests()` | Wrapper passing `TestType.INTEGRATION` to `_run_tests()`. |
| `run_e2e_tests()` | Wrapper passing `TestType.E2E` to `_run_tests()`. |
| `_run_tests()` | Shared implementation of: generate test code → run → auto-fix loop (up to 3 attempts). Switches behavior by `TestType`. Aborts immediately on infrastructure errors (EACCES etc.). |
| `_detect_test_command()` | Checks `package.json` first, then `pyproject.toml` / `setup.py` for Python. Does not infer Python from `requirements.txt` alone. Also verifies pytest is actually installed. |
| `_extract_result_for_function()` | Handles both Jest (`--verbose` `✓/✕ TC-xxx:` lines) and pytest verbose (`PASSED/FAILED` lines) to determine verdict. |

### 6.3 Docker Workspace

- Image: `xolvien-workspace:latest` (`docker/workspace/Dockerfile`)
- Contents: Python 3.11-slim + Git + Node.js 20 + Claude Code CLI
- Per-task volume: `xolvien-task-{task_id}-data` (mounted at `/workspace`)
- SSH keys: host `~/.ssh/` mounted into the container (for GitHub auth)
- Claude credentials: only `~/.claude/.credentials.json` is copied into `/home/xolvien/.claude/` (not the full directory). The target directory is created with `mkdir -p` before copying via `put_archive`, and ownership is set to `xolvien:xolvien`.

### 6.4 Test Execution Details

- `_detect_test_command()` checks `package.json` (Node.js) → `pyproject.toml` / `setup.py` (Python) in that order. `requirements.txt` alone does not imply Python.
- Node.js projects run `npm test -- --watchAll=false --verbose 2>&1`; Python runs `python -m pytest -v 2>&1`.
- Before test execution, the backend (root) pre-creates JSONL files with `chmod 777`: unit: `/tmp/xolvien_tc_results.jsonl`, integration: `/tmp/xolvien_itc_results.jsonl`, E2E: `/tmp/xolvien_e2e_results.jsonl`. Test code logs actual output via `console.log('XOLVIEN_RESULT:{"tc_id":"TC-001","actual":"..."}')` / `ITC-001` / `E2E-001`.
- Backend parses `XOLVIEN_RESULT:` lines from test output and saves to `test_case_results.actual_output`.
- `test_run.summary` is generated by aggregating verdicts from `test_case_results` (TC-count based, not test function count).
- Auto-fix loop (up to 3 attempts): fix prompt instructs "fix only, do not re-run tests"; the backend handles re-running.
- EACCES / EPERM / Cannot find module etc. abort the loop immediately without attempting auto-fix.
- Missing dependencies are detected and installed by Claude Agent.
- Test report path: `/workspace/repo/test-reports/test-report-{datetime}-{type}.md`.

**Integration test specifics**

- `[ITEST]` tag used in log output.
- Test case generation prompt is integration-specific (validates API endpoints, DB operations, cross-component interaction). `ITC-NNN` / `test_itc001_` format.
- Test code generation prompt includes server startup instructions (supertest / pytest + httpx) and HTTP-request-based test patterns.
- Uses independent `test_case_items` with `test_type=INTEGRATION`.
- Results saved to the same `test_case_results` table, linked by `test_run_id`.
- `GET /test-cases?test_type=unit|integration|e2e` filtering supported.

**E2E test specifics**

- `[E2E]` tag used in log output.
- Test case generation prompt is E2E-specific (validates browser operation scenarios). `E2E-NNN` / `test_e2e001_` format.
  - Concrete URL, click operations, input values, and expected on-screen text are required.
  - Targets ~8–12 user scenario cases.
- Playwright-specific instructions added to test code generation prompt:
  - Run `npm install --save-dev @playwright/test` or `pip install playwright && playwright install chromium`.
  - Start the app in the background before running Playwright tests.
  - Run in headless mode (`headless: true`).
  - Save a screenshot to `/workspace/repo/test-reports/screenshots/{E2E-NNN}.png` after each test.
- Uses independent `test_case_items` with `test_type=E2E`.

### 6.5 Design Decisions

**Keepalive thread prevents stream silence**

`_RUNNER_SCRIPT` and `_RUNNER_SCRIPT_AGENT` both spawn a daemon thread that writes `[Claude] ...\n` to stdout every 3 seconds while Claude is running. This ensures the `execute_command_stream` chunk timeout (120 s) is never hit during normal inter-tool pauses. The 3-second interval is the maximum acceptable silence from a UX standpoint. The thread is a daemon so it terminates automatically when Claude exits.

**Task status is set to FAILED on execution error**

When `execute_instruction()` raises an error (e.g. stream timeout), the task status is set to `FAILED` rather than `IDLE`. This keeps the Git Push button disabled until the issue is resolved, preventing users from pushing incomplete or broken code.

**Why prompt generation also runs in agent mode**

For large projects it is impossible to pre-embed all file contents. Claude Agent must be able to select and read relevant files from the repository itself to generate an accurate prompt — agent mode is required. Switching to `-p` mode would break this for large projects.

**Streaming uses synchronous blocking**

`execute_command_stream` uses the synchronous docker-py API and simulates async with `asyncio.sleep(0.01)`. This may delay other requests during concurrent task execution, but is acceptable for single-user use. Multi-user support will move this to a thread pool via `run_in_executor`.

---

## 7. Known Limitations

| Item | Details |
|---|---|
| Authentication | Fixed token (`dev-token-12345`). GitHub OAuth not implemented. |
| Concurrency | Single-user design. Streaming may be delayed with multiple concurrent tasks. |
| Test report format | Markdown only. Excel format is a future item. |
