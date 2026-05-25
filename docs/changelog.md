# Changelog

---

## 2026-05-25

### Input Field Enhancement (Markdown Preview)

**Changes:**

- Frontend `pages/TaskDetail.tsx`: Replaced the plain textarea with a GitHub Issue-style input component.
  - Added **Write / Preview** tab toggle above the input area.
    - **Write** tab: editable textarea (monospace font, dark theme `#0d1117`).
    - **Preview** tab: inline Markdown render via `renderMarkdownPreview()` (headings `#`/`##`/`###`, bold `**`, italic `*`, inline code, fenced code blocks, unordered lists). Preview is disabled when the textarea is empty or in a disabled phase.
  - Added a **Markdown toolbar** visible in Write mode only (hidden when textarea is disabled):
    - **B** — wraps selection/cursor in `**…**`
    - *I* — wraps in `*…*`
    - `<>` — wraps in backtick inline code
    - ` ``` ` — wraps in fenced code block
    - `—` — inserts `\n---\n`
    - `•` — inserts `- ` at cursor
    - `insertMarkdown()` helper: inserts before/after selection, then restores focus and sets cursor after the inserted text.
  - Textarea minimum height raised from 60 px to 120 px; maximum height capped at 300 px (still resizable).
  - Tab key now inserts 2 spaces instead of moving focus.
  - Status message (container state) moved from below the textarea to the tab bar right edge.
  - No external library added; no `react-markdown` dependency.

- Frontend `styles.css`: Updated `.instruction-textarea` defaults to dark theme (`background: #0d1117`, `color: #e6edf3`, `border: none`, `border-radius: 0`, monospace font). Focus state no longer shows a blue box-shadow (border is handled by the container). Added `::placeholder` rule (`color: #6e7681`).

---

## 2026-05-24

### Bug Fixes: Stream Silence, Keepalive, Error Propagation

**Problem**: During `execute_instruction()`, Claude Code CLI could be silent for more than 60 seconds (e.g. during file reads or writes), causing a `StreamTimeoutError`. Worse, when a timeout occurred the task continued to the next step (e.g. test generation) instead of being aborted.

**Changes:**

- Backend `claude_service.py`: Added a keepalive daemon thread to `_RUNNER_SCRIPT` and `_RUNNER_SCRIPT_AGENT`.
  - Writes `[Claude] ...\n` to stdout every **3 seconds** while Claude is running.
  - Uses `sys.stdout.buffer.write()` + `flush()` to avoid buffering.
  - Thread is a daemon so it terminates automatically when Claude exits.
  - 3-second interval was chosen because users cannot tolerate silence longer than that.

- Backend `claude_service.py`: Fixed `SyntaxError` in generated runner script (`_RUNNER_SCRIPT` / `_RUNNER_SCRIPT_AGENT`).
  - **Cause**: The keepalive write used `b'[Claude] ...\n'` inside a Python triple-quoted string. The `\n` was interpreted as a literal newline by the outer string, producing an unterminated string literal in the generated script and a `SyntaxError` on startup — making Claude completely silent from the start.
  - **Fix**: Changed to `b'[Claude] ...\\n'` so the generated script contains the escape sequence `\n` rather than an actual newline.

- Backend `claude_service.py`: Fixed "Not logged in" error in agent mode (`_RUNNER_SCRIPT_AGENT`).
  - **Cause**: `_RUNNER_SCRIPT` set `HOME='/root'` at the top, but Claude credentials were copied to `/home/xolvien/.claude/`. Claude Code CLI looked in the wrong directory.
  - **Fix**: `HOME` is now set via `pwd.getpwnam('xolvien').pw_dir` so it resolves to the actual xolvien user's home directory.

- Backend `claude_service.py`: Increased `chunk_timeout` on long-running calls.
  - `clarify_requirements()`, `generate_prompt()`, and `execute_instruction()` now pass `chunk_timeout=120.0` (was 60.0 s default). The keepalive thread emits every 3 s so this timeout is now a backstop for true hangs, not normal inter-tool pauses.

- Backend `claude_service.py`: `execute_instruction()` now sets `task.status = FAILED` on error.
  - Previously the status was left as `IDLE` after a stream timeout, allowing users to proceed to Git Push even after a failed implementation. Now status is `FAILED`, which disables the Git Push button until the issue is resolved.

- Backend `docker_service.py`: Fixed `put_archive` 404 error when copying Claude credentials into a new container.
  - **Cause**: `container.put_archive('/home/xolvien/.claude/', ...)` raised a 404 if the target directory did not exist yet.
  - **Fix**: Added `container.exec_run(["bash", "-c", "mkdir -p /home/xolvien/.claude"])` before `put_archive`. Also changed the subsequent `chown` to `chown -R xolvien:xolvien /home/xolvien/.claude` (recursive).

---

## 2026-05-09

### GitHub API: Automatic Repository Creation

**Changes:**

- Backend `config.py`: Added `github_token` setting (env var `GITHUB_TOKEN`).
- Backend `schemas/repository.py`: Added `GitHubRepoCreate` schema.
- Backend `api/repositories.py`: Added `POST /api/v1/repositories/github`.
  - Calls GitHub API `POST /user/repos` with `auto_init: true` (creates README on GitHub side).
  - Saves the SSH URL from GitHub response as the repository URL in Xolvien DB.
  - Error handling: 503 if token not set, 401 if token invalid, 502 for other GitHub errors.
- Backend `requirements`: Added `httpx` for async HTTP calls to GitHub API.
- Backend `.env`: Added `GITHUB_TOKEN=` placeholder.
- Frontend `services/api.ts`: Added `createGitHubRepository()`.
- Frontend `pages/TaskCreate.tsx`:
  - Added "GitHubで作成 / Create on GitHub" as a third tab in the repository mode toggle.
  - Input fields: name (required), description (optional), private checkbox.
  - Shows "GitHubに作成中... / Creating on GitHub..." on the submit button while creating.
  - User-friendly error messages for token-not-configured (503) and API errors.
- Frontend `i18n/en.ts` / `ja.ts`: Added `createOnGitHub`, `githubRepoName`, `githubRepoDesc`, `githubPrivate`, `githubCreating`, `githubTokenNotSet`, `githubError` strings.

---

## 2026-05-05

### Real-time Test Case Generation Progress

**Changes:**

- Backend `claude_service.py`: Rewrote `generate_test_cases()` to use batch generation.
  - Calls Claude CLI with `--output-format json` and `--resume <session_id>` to maintain context across batches.
  - Generates 10 cases per Claude call (BATCH_SIZE = 10). The first batch instructs Claude to decide the total count and output `[XOLVIEN_TC_TOTAL] <n>`.
  - Yields `[XOLVIEN_PROGRESS] done/total elapsed_ms=N eta_ms=0` after each batch, enabling frontend progress display.
  - Loop terminates when `done >= total` or the batch returns fewer than BATCH_SIZE items.
  - Applies to UNIT, INTEGRATION, and E2E test types via the shared `test_type` argument.

- Backend `docker_service.py`: Added `chunk_timeout` parameter to `execute_command_stream()`. Set to 90 seconds for test case generation and test execution calls to accommodate Claude's response time.

- Frontend `src/pages/TaskDetail.tsx`:
  - `test_cases_generating`, `integration_test_cases_generating`, and `e2e_test_cases_generating` chat entries now display live progress text (`tcGenLabel`) instead of a static message.
  - All four `[XOLVIEN_PROGRESS]` handlers (unit manual, unit revision, integration, E2E) now capture `elapsed_ms` and compute ETA as `ceil((elapsed_ms / done) * (total - done) / 1000)` seconds.
  - Added `fmtHms(sec)` helper: formats seconds as `mm:ss` (or `hh:mm:ss` if ≥ 1 hour).
  - ETA passed to `progressGenTC` and `progressGenCode` as formatted `hh:mm:ss` string.

- Frontend `src/i18n/en.ts` / `ja.ts`:
  - `progressGenTC`: added optional `etaHms` parameter. Displays `~mm:ss remaining` / `残り約mm:ss` when available.
  - `progressGenCode`: changed `etaSec: number` to `etaHms: string` parameter. Same hh:mm:ss format.

---

## 2026-05-03

### UI Bug Fixes & Input Design Improvements

**Changes:**

- **Unified to a single input field**: Removed multiple per-phase textareas (`feedback`, `revisionText`, etc.) in favor of a single persistent input field. Placeholder text and buttons switch based on the current phase.
  - Phase 1 (initial): "Enter instruction…" + **Send** button
  - Phase 2 (Q&A): "Enter answer…" + **Send Answer** / **Next** buttons
  - Phase 3 (prompt review): "Feedback (optional)" + **Confirm & Execute** / **Regenerate** buttons
  - Phase 4 (test / review): Action buttons only
- **Removed Enter-to-send**: The textarea now inserts a newline on Enter. Sending requires a button click.
- **Clarify language support**: The UI language (JA/EN) is now sent to the `/clarify` backend endpoint so Claude responds in the same language as the UI.
- **Always ask for programming language during clarify**: Even when the file list implies a language, Claude now explicitly confirms the programming language and framework.

### Task Branch Isolation Fix

**Changes:**

- **Always create a fresh branch from main**: After `git clone`, the task initialization always runs `git checkout -b {branch}` to create a new branch. This prevents unmerged work from another task on the same repository from leaking in.
- **Include title slug in branch name**: Auto-generated branch names changed from `xolvien/task-{id}` to `xolvien/{id}-{title-slug}` (e.g. `xolvien/5-translation-app`).

---

## 2026-05-02 (2)

### Japanese/English UI i18n

**Changes:**

- Frontend `src/i18n/ja.ts`: New Japanese translation map covering all UI strings. Dynamic strings (progress counters, error messages, etc.) use function-type keys.
- Frontend `src/i18n/en.ts`: Matching English translation map.
- Frontend `src/i18n/index.ts`: New `LangContext` / `useLang()` hook.
  - Language selection persisted to `localStorage` (key: `xolvien-lang`).
  - Default language: Japanese.
- Frontend `src/main.tsx`: App wrapped in `LangProvider`.
- Frontend `Dashboard.tsx` / `TaskCreate.tsx` / `TaskDetail.tsx`:
  - All hardcoded strings replaced with `t.xxx`.
  - `JA` / `EN` toggle button added to each page header.
  - Step bar labels resolved via `getStepLabel(step.id)` for instant switching.
  - `formatDate` locale switches between `ja-JP` and `en-US` based on `lang`.

---

## 2026-05-02

### E2E Tests: Fixed "undetermined" verdict bug

**Changes:**

- Backend `claude_service.py`: Fixed issue where all E2E test results showed as "undetermined".
  - **Cause 1**: `_detect_test_command()` returned `npm test` (Jest) for Node.js projects, which tried to run Playwright test files via Jest and failed/skipped them.
  - **Cause 2**: `--reporter=line` format only emits terminal control codes (`[1A[2K`) without `✓`/`✘`, so `_extract_result_for_function()` could not determine verdict.
  - **Fix 1**: Added `_detect_e2e_test_command()` to bypass `_detect_test_command()` for E2E runs and use `npx playwright test --reporter=list 2>&1`.
  - **Fix 2**: Switched to `--reporter=list` (outputs `✓`/`✘` per test).
  - **Fix 3**: Added Playwright `--reporter=list` pattern to `_extract_result_for_function()` (detects `✓`/`✘` on lines containing `function_name`).
  - **Fix 4**: TCs that emitted `XOLVIEN_RESULT:` are treated as "test ran" and verdict is finalized from exit code. TCs that produced no output are marked `FAILED` — "undetermined" is no longer a terminal state.
  - **Fix 5**: Auto-fix prompt now explicitly forbids silencing exceptions with `try/catch`, weakening `expect` conditions, and instructs use of `grantPermissions()` / `page.route()` to mock environment-dependent behavior.

- `docs/roadmap.md`: Added upcoming items.

---

## 2026-04-30

### Phase 3: E2E Tests (Playwright)

**Changes:**

- Backend `claude_service.py`: Added `run_e2e_tests()` method.
  - Wrapper that passes `TestType.E2E` to `_run_tests()`.
  - `generate_test_cases(TestType.E2E)` generates TC IDs in `E2E-NNN` format, function names in `test_e2e001_` format.
  - Added E2E test code generation prompt: installs Playwright, starts app in background, runs headless, saves screenshots to `/workspace/repo/test-reports/screenshots/`.
  - Result file managed at `/tmp/xolvien_e2e_results.jsonl` (independent from unit/integration).
  - Logs tagged with `[E2E]`.

- Backend `claude_service.py`: E2E support in `generate_test_cases()`.
  - Added E2E-specific test case generation prompt (browser operation scenarios: URL, click, input, expected display). Targets 8–12 cases.
  - Changed `is_integration` boolean branching to direct `test_type` reference to correctly handle UNIT / INTEGRATION / E2E.

- Backend `models/test_case_item.py`: Added `E2E` type to `tc_id` property (`E2E-NNN` format).

- Backend `schemas/instruction.py`: Added `RunE2ETestsRequest`.

- Backend `api/instructions.py`: Added E2E endpoints.
  - `POST /generate-e2e-test-cases` (streaming)
  - `POST /run-e2e-tests` (streaming)

- Frontend `services/api.ts`: Added E2E API client functions.
  - `generateE2ETestCasesStream()`
  - `runE2ETestsStream()`
  - Added `'e2e'` to `getTestCaseItems()` type argument.

- Frontend `pages/TaskDetail.tsx`: Implemented E2E test flow.
  - Added `e2e_test_cases_generating` / `e2e_test_cases_ready` to `ChatEntry` type (cyan `#06b6d4`).
  - Removed `future: true` flag from "E2E Test" step in the step bar.
  - Restored E2E test cases (`getTestCaseItems(taskId, 'e2e')`) and latest E2E TestRun from DB on session resume.
  - Updated step transitions: integration test pass → E2E, E2E pass → review.
  - Added `handleApproveE2ETestCases()` / `handleGenerateE2ETestCasesManual()` handlers.
  - Added E2E test step button group to `renderActionButtons()`.
  - Added `e2e_test` to `renderInputArea()` disabled condition.

- Docs `docs/spec.md` and `docs/roadmap.md` updated.

---

## 2026-04-28

### Integration Test Quality Improvements & Bug Fixes

**Changes:**

- Backend `claude_service.py`: Fixed EACCES error during integration test runs.
  - Only `/tmp/xolvien_tc_results.jsonl` (unit test file) was pre-created, so writing to `/tmp/xolvien_itc_results.jsonl` failed for all integration test cases.
  - Added `results_file` variable to `_run_tests()`, switching the JSONL path by `is_integration` flag. Both creation and reading now use the correct path.

- Backend `claude_service.py`: Improved integration test case generation prompt.
  - Added section explicitly differentiating from unit tests (HTTP request → API → DB flow rather than DOM/localStorage).
  - Enforced HTTP method, URL, request body, and response status in `target_screen`, `operation`, and `expected_output`.
  - Capped test case count at 10–15 (down from the larger unit test count).

- Backend `claude_service.py`: Fixed `XOLVIEN_RESULT:` sample in integration test code generation prompt.
  - Sample used `TC-001`/`test_tc001_xxx`; switched to `ITC-001`/`test_itc001_xxx`.

### Phase 2: Integration Test Case Separation (Plan A)

**Changes:**

- Backend `claude_service.py`: Added `test_type` argument to `generate_test_cases()`.
  - UNIT: `TC-NNN` / `test_tc001_` format. INTEGRATION: `ITC-NNN` / `test_itc001_` format.
  - Deletes only existing TCs of the same `test_type` before saving (other types are preserved).
- Backend `instructions.py`: Added `POST /generate-integration-test-cases` and `POST /run-integration-tests` endpoints.
- DB migration `a1b2c3d4e5f6`: Added `test_type` column to `test_case_items` table (reuses existing `testtype` PG enum with `create_type=False`).
- Frontend `TaskDetail.tsx`: Added independent flow for integration test case generation → review → approval → run.
- Frontend `api.ts`: Added `test_type` query parameter support to `getTestCaseItems(taskId, testType?)`.
- Session resume now restores unit and integration test cases separately from DB.
- API errors now displayed in chat panel (silent swallowing removed).

---

## 2026-04-21

### Test Result Summary Display & Revision UI Improvement (H2, H3)

**Changes:**

- Frontend `TaskDetail.tsx`: Added test result summary banner to the review panel (H2).
  - Shows passed / failed counts in green / red banners after test completion and on page reload.
  - Managed via `testResultSummary` state; populated both on test completion and page load.

- Frontend `TaskDetail.tsx`: Replaced `window.prompt` with inline revision input for test case editing (H3).
  - "Request revision" button toggles an inline textarea + Send / Cancel buttons.
  - Submitting regenerates the test cases; Cancel closes the input.

---

## 2026-04-19

### Container Auto-restart, Step Bar Improvements, Mojibake Fix

**Summary**: Fixed the inability to resume work after restarting; improved step bar UI; fixed streaming character corruption.

**Changes:**

- Backend `docker_service.py`: Added `ensure_container_running()` method.
  - Checks container state before each `execute_command()` / `execute_command_stream()` call and restarts it if stopped.
  - Allows resuming tasks after `docker compose down` without recreating them.

- Backend `docker_service.py`: Fixed UTF-8 mojibake in streaming (H1).
  - Changed `chunk.decode("utf-8", errors="replace")` to `codecs.getincrementaldecoder`.
  - Correctly reassembles multi-byte characters split across chunk boundaries before decoding.

- Frontend `TaskDetail.tsx`: Step bar UI improvements.
  - Selected step highlighted with yellow background and black text.
  - Merged "Test Cases" and "Unit Test" steps into a single "Unit Test" step (they had no behavioral difference).
  - Removed test result counts from step bar buttons (avoids mixing data into action buttons).
  - The auto-resumed step is shown as selected on page load.

---

## 2026-04-14

### Resume from Previous Session (Step Bar)

**Summary**: Added a step bar to the task detail screen to resume from a completed step.

**Changes:**

- Added step bar UI to frontend `TaskDetail.tsx` (Implement → Test Cases → Unit Test → Integration Test* → E2E Test* → Review).
- On page load, fetches DB history via `GET /instructions/last-completed` and `GET /test-runs` to restore step state.
- Clicking a completed step switches to that screen. The "Implement" step restores the previous instruction into the input field.
- Removed the old banner approach (`isResumed` flag + blue banner).
- Added `GET /last-completed` endpoint to backend `instructions.py`.

---

## 2026-04-12

### Phase 1: Unit Test Automation

**Summary**: Implemented test case generation, unit test execution, and auto-fix loop.

**Changes:**

- Backend `claude_service.py`: Added `generate_test_cases()` and `run_unit_tests()`.
  - Test command auto-detected by Claude Agent from `package.json` / `pyproject.toml` etc.
  - If pytest is not installed, Claude Agent handles dependency installation.
  - Auto-fix loop: up to 3 attempts. Failed test names, error messages, and stdout fed back as context.
  - Test report saved to `/workspace/repo/test-reports/test-report-{datetime}-unit.md`.
- Backend `instructions.py`: Added endpoints:
  - `POST /generate-test-cases` (streaming)
  - `POST /run-unit-tests` (streaming)
- DB migration: Added `test_type` (UNIT/INTEGRATION/E2E), `test_cases`, `retry_count`, `report_path` columns to `TestRun` model.
- Frontend: Added test case review panel and implementation review panel.
- Extended `PromptState`: added `test_cases` / `running_tests` / `reviewing`.

---

## 2026-04-07 (estimated)

### MVP Initial Implementation

**Summary**: Implemented the full backend and frontend feature set.

**Changes:**

- Backend full implementation (Docker management, task/repository API, Claude Code execution, WebSocket log delivery, DB persistence).
- Frontend full implementation (dashboard, task creation, task detail, log viewer, requirement clarification flow, prompt confirmation).
- Switched `claude_service.py` Claude Code execution from simulation to real CLI (`--dangerously-skip-permissions` mode).
- Renamed project from karakuri → Xolvien.
