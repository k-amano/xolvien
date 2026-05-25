# Roadmap

**Last updated**: 2026-05-25

See `spec.md` for currently implemented features.

---

## Priority: High (critical quality issues)

### Real-time Log Display (Claude Code style)

Currently the left pane only shows output after Claude emits a chunk. Between tool calls (file reads, writes, bash) Claude can be silent, leaving the user with no feedback.

**Requirements:**
- Stream every line of Claude's output to the left pane in real time, the same way Claude Code CLI displays it in the terminal — tool calls, file operations, thinking steps, and final output all visible as they happen.
- No silence longer than 3 seconds at any point during execution.

**Note:** The current keepalive `[Claude] ...\n` workaround emits a dot every 3s but does not show what Claude is actually doing. The goal is to show real activity, not a heartbeat.

---

### Error Display

When an error occurs (timeout, Claude failure, container error, etc.), it must be immediately visible to the user in an unmissable way.

**Requirements:**
- Display errors as a prominently styled banner (red background, large text) in the right pane, not buried in the log stream.
- The banner must appear immediately when the error occurs — not after a delay.
- The Git Push button and all other action buttons must be disabled until the error is resolved.
- The current `[ERROR]` line in the log stream is insufficient — users miss it and proceed with push anyway.

---

### ~~H1: Mojibake (character corruption)~~ ✅ Fixed (2026-04-19)

- Changed `execute_command_stream()` in `docker_service.py` to use `codecs.getincrementaldecoder`.
- Multi-byte characters split at chunk boundaries are now correctly reassembled before decoding.

### ~~H2: Test result summary not displayed~~ ✅ Fixed (2026-04-21)

- Added test result summary banner to the review panel (`reviewing`).
- Shows passed / failed counts with green / red backgrounds.
- Summary is also restored from DB on page reload.

### ~~H3: Test case revision UI broken~~ ✅ Fixed (2026-04-21)

- Replaced `window.prompt` with an inline input (textarea + Send / Cancel buttons) toggled by the "Request revision" button.
- Submitting regenerates the test cases.

---

## Code Review Findings (2026-04-21)

Results from an external agent code review.

### ~~CR-1: Switch `generate_test_cases()` to agent mode~~ ✅ Fixed (2026-04-21)

- Changed `_RUNNER_SCRIPT` → `_RUNNER_SCRIPT_AGENT`. Claude now reads relevant repo files before generating test cases.

### ~~CR-2: Improve `_detect_test_command()` detection logic~~ ✅ Fixed (2026-04-21)

- `package.json` check now runs before the Python check.
- `requirements.txt` alone no longer implies Python (`pyproject.toml` / `setup.py` take priority).

### CR-3: `generate_prompt()` runs with excess permissions in agent mode ❌ Won't fix

- **Finding**: `generate_prompt()` uses `_RUNNER_SCRIPT_AGENT` (file writes allowed), risking unintended file modifications.
- **Decision**: For large projects, Claude must be able to read relevant files to generate an accurate prompt — agent mode is required. Switching to `-p` mode would break this capability. Risk is acknowledged; no alternative available. Design decision documented in `spec.md` §6.5.

### CR-4: Dockerfile Node.js version ❌ N/A (already fixed)

- **Finding**: Node.js 18 is EOL; should upgrade to 20.
- **Decision**: Already on Node.js 20 (`docker/workspace/Dockerfile` lines 16–18). Finding was based on an outdated read.

---

## Priority: Medium (functional issues)

### ~~M1: Test type not shown in UI~~ ✅ Fixed (2026-04-22)

- Added `runningTestType` state (unit / integration / e2e).
- Running banner now shows type-specific text: "Running unit tests…" / "Running integration tests…" etc.

### ~~M2: No progress indication during processing~~ ✅ Fixed (2026-04-23)

- **Original plan**: Update banner text when each phase starts ("Generating test code", "Running tests", "Auto-fixing 1/3").
- **User feedback**: No spinner needed. Wants concrete progress: "how many out of how many tests have run."
- **Implementation**: Each chunk from the stream is parsed in real time, detecting pytest (`PASSED`/`FAILED`/dot format) and Jest (`✓`/`✕`) patterns and updating a running count.
  - Banner example: "Running tests (12 done / 2 failed)"
  - Auto-fix phase: "Auto-fixing 1/3"
  - Phase label managed via `testPhaseLabel` state; counter resets on test start.

### ~~M3: Test case structure & DB management~~ ✅ Fixed (2026-04-23)

- **User feedback**: "Test cases need IDs"; "can't re-run without concrete input values and expected outputs"; "test cases with no relation to the tests are pointless."
- **Design**: Separated `test_case_items` (specification, TC-ID) and `test_case_results` (per-run results) into distinct DB tables.
- `generate_test_cases()` outputs a JSON array (TC-ID / target screen / test item / operation with concrete input / expected output / function_name) and saves to `test_case_items`.
- `run_unit_tests()` generates test functions keyed by `function_name` from `test_case_items`, then saves results to `test_case_results` (actual output / verdict / executed_at).
- Test case review panel: replaced Markdown textarea with a table view (TC-ID / target screen / test item / operation / expected output).
- Review panel: shows test result table from DB `test_case_results` (TC-ID / test item / expected output / actual output / verdict / executed_at).
- New API endpoints: `GET /tasks/{id}/test-cases`, `GET /tasks/{id}/test-cases/{item_id}/results`.

### ~~M4: Test result summary table~~ ✅ Fixed (2026-04-22)

- Parses pytest verbose / short / Jest (`✓`/`✕`) output line by line and builds a summary table of test names and results.
- Displayed inline in the review panel (`<table>` element).
- Also written as a `## Test Result Summary` section in the Markdown test report under `/workspace/repo/test-reports/`.
- Reconstructed from `TestRun.output` in DB on page reload.

---

## Priority: Low (UX improvements)

### ~~L1: Chat-style right-pane layout overhaul~~ ✅ Fixed (2026-04-26)

- **User feedback**: "Without output staying visible, it's impossible to debug when something goes wrong. Persistent scroll-based display is mandatory." (bumped to high priority)
- **Implementation**: Append-only chat history via `ChatEntry` union type. All phases (Q&A / prompt generation / implementation / test cases / test results / review / error / system notices) persist as cards. Input area is always pinned to the bottom; Enter switches to send mode during clarify.
- **Additional fix (2026-04-26)**: Moved action buttons from inside chat cards to the footer below the input area. `renderActionButtons()` dynamically switches the button set based on `selectedStep`. Textarea is shown as disabled during unit-test and review steps. Removed auto-population of the input field on "Implement" step click. System notices shown as `info` entries appended to chat history.

---

## Bug Fixes (2026-04-26)

### "Actual output" and "verdict" were blank in test results ✅ Fixed

- **Cause 1**: `_extract_result_for_function()` only handled pytest verbose output; Jest `✓/✕ TC-xxx:` format was not recognized.
- **Cause 2**: No actual output was recorded for passing tests.
- **Fix**: Added `--verbose` to Jest. Each test function emits `console.log('XOLVIEN_RESULT:{tc_id, actual}')` for both PASSED and FAILED cases; backend parses stdout and saves to DB. Also added `appendFileSync`-style parsing for backward compatibility.
- **Fix**: Backend (root) pre-creates `/tmp/xolvien_tc_results.jsonl` with `chmod 777` before test execution to avoid EACCES when the xolvien user calls `appendFileSync`.

### Test result summary showed function count instead of TC count ✅ Fixed

- **Cause**: `_parse_test_summary()` read the "number of test functions" from Jest/pytest output (e.g. 50).
- **Fix**: Changed to aggregate verdicts from `test_case_results`, making the summary TC-count based.

### Auto-fix loop ran indefinitely on infrastructure errors ✅ Fixed

- **Cause 1**: Errors like EACCES that Claude cannot fix still triggered the auto-fix loop.
- **Cause 2**: The fix prompt instructed Claude to "re-run the tests", causing Claude to re-run them itself.
- **Fix**: Detect EACCES / EPERM / Cannot find module etc. and abort immediately. Removed "re-run tests" instruction from fix prompt — Claude now only fixes code; the backend handles re-running.

### Other fixes ✅ Fixed

- Replaced old name `Karakuri` with `Xolvien` in HTML title and TaskCreate header.
- Fixed "Generate test cases" button not appearing on first visit to unit test step (when `chatEntries` is empty).
- Added "Regenerate test cases" button alongside "Re-run tests" after test completion.

---

## ~~Phase 2: Integration Tests~~ ✅ Fixed (2026-04-28)

**2026-04-27 initial implementation:**
- Added `run_integration_tests()` to `claude_service.py` (wrapper passing `TestType.INTEGRATION` to `_run_tests()`).
- Added integration-test-specific prompt to `_run_tests()` (server startup + HTTP request testing).
- Added `POST /run-integration-tests` endpoint to `instructions.py`.
- Activated "Integration Test" step in step bar (removed `future: true`).
- Auto-transition: unit test pass → integration test; integration test pass → review.

**2026-04-28 test case separation (Plan A):**
- **Problem**: Unit and integration tests shared test cases (same cases, different targets).
- Added `test_type` column to `test_case_items` (UNIT / INTEGRATION).
- Added DB migration (`a1b2c3d4e5f6`).
- Unit TCs: `TC-NNN` / `test_tc001_` format. Integration TCs: `ITC-NNN` / `test_itc001_` format.
- Updated `generate_test_cases()` to accept `test_type` (integration prompt targets API / DB operations).
- Added `POST /generate-integration-test-cases` endpoint.
- Added `GET /test-cases?test_type=unit|integration` filter support.
- Added independent integration test case generation → review → approval → run flow to frontend.
- Session resume now restores unit and integration test cases separately from DB.

**2026-04-28 quality improvements (post-verification):**
- **Problem 1**: `EACCES: permission denied, open '/tmp/xolvien_itc_results.jsonl'` on integration test runs. Fixed by switching `results_file` path by `is_integration`.
- **Problem 2**: Integration test cases were identical to unit test cases (localStorage/DOM operations). Fixed by strengthening the prompt to specify HTTP method/URL/body/status.
- **Problem 3**: `XOLVIEN_RESULT:` log samples in integration test code generation prompt still used `TC-001`/`test_tc001_xxx`. Fixed by switching to `ITC-001`/`test_itc001_xxx` based on `is_integration`.

---

## ~~Phase 3: E2E Tests (Playwright)~~ ✅ Fixed (2026-04-30)

**Backend:**
- Added `run_e2e_tests()` and E2E-specific `generate_test_cases(TestType.E2E)` to `claude_service.py`.
- `test_case_item.py` updated so `tc_id` property generates `E2E-NNN` format.
- Playwright prompt: headless browser, screenshots saved to `/workspace/repo/test-reports/screenshots/`.
- Results file at `/tmp/xolvien_e2e_results.jsonl`.
- Added `POST /generate-e2e-test-cases` and `POST /run-e2e-tests` to `instructions.py`.
- Added `RunE2ETestsRequest` to `schemas/instruction.py`.

**Frontend:**
- Activated "E2E Test" step in step bar (removed `future: true`).
- Added `generateE2ETestCasesStream()` / `runE2ETestsStream()` to `api.ts`.
- Added `e2e_test_cases_generating` / `e2e_test_cases_ready` to `ChatEntry` type (cyan `#06b6d4`).
- Auto-transition: integration test pass → E2E; E2E pass → review.
- Session resume restores E2E test cases and results from DB.
- Added independent E2E test case generation → review → approval → run flow.

---

## Japanese/English i18n

### ~~I18N-1: UI language toggle~~ ✅ Fixed (2026-05-02)

- No external library. `src/i18n/ja.ts` / `en.ts` hold translation maps; `LangContext` + `useLang()` hook manages selection.
- All labels, buttons, and messages replaced with `t.xxx`.
- `JA` / `EN` toggle added to each page header.
- Selection persisted to `localStorage` (key: `xolvien-lang`).

### ~~I18N-2: Documentation i18n~~ ✅ Fixed (2026-05-04)

- Developer docs (`spec.md`, `roadmap.md`, `changelog.md`) rewritten in English.
- User-facing docs: `getting-started.md` is the English version; `getting-started.ja.md` is the Japanese version.

---

## ~~GitHub API: Automatic Repository Creation~~ ✅ Fixed (2026-05-09)

**Backend:**
- `config.py`: Added `github_token` setting (reads `GITHUB_TOKEN` from `.env`).
- `schemas/repository.py`: Added `GitHubRepoCreate` schema (`name`, `description`, `private`).
- `api/repositories.py`: Added `POST /api/v1/repositories/github` endpoint.
  - Calls GitHub API `POST /user/repos` with `auto_init: true`.
  - Returns SSH URL (`ssh_url`) from GitHub and saves it as the repository URL.
  - Returns 503 if `GITHUB_TOKEN` is not set; 401 if token is invalid; 502 for other GitHub errors.

**Frontend:**
- `services/api.ts`: Added `createGitHubRepository()`.
- `pages/TaskCreate.tsx`: Added "GitHubで作成 / Create on GitHub" third tab to the repository toggle.
  - Fields: repository name (required), description (optional), private checkbox.
  - Shows "GitHubに作成中... / Creating on GitHub..." while the API call is in progress.
  - Displays user-friendly error messages for token-not-set (503) and other API errors.
- `i18n/en.ts` / `ja.ts`: Added GitHub creation strings.
- `backend/.env`: Added `GITHUB_TOKEN=` placeholder.

---

## ~~Input Field Enhancement (Markdown Preview)~~ ✅ Fixed (2026-05-25)

- Replaced the single textarea with a GitHub Issue-style input area.
- Added **Write / Preview** tab toggle. Preview renders the input as Markdown (headings, bold/italic, inline code, code blocks, lists).
- Added a **Markdown toolbar** (Write mode only): Bold, Italic, Inline code, Code block, Divider, List item. Each button wraps the selected text or inserts at the cursor.
- Textarea minimum height raised to 120 px (max 300 px, resizable). Tab key inserts 2 spaces.
- Status message moved to the tab bar right edge to reduce visual noise.
- No external library; inline renderer implemented in `renderMarkdownPreview()` in `TaskDetail.tsx`.

---

## File Upload for Requirements Analysis

Allow uploading spec documents, design docs, screen mockups, etc. instead of typing requirements as text.

**Backend:**
- Add `POST /api/v1/tasks/{id}/uploads` endpoint (`multipart/form-data`).
- Accept PDF / Word / Markdown / images (PNG, JPG); extract and analyze text with Claude.
- Use extracted text as the base for `Instruction.content`.

**Frontend:**
- Add file drop zone / file select button to the requirements input area.
- Progress bar during upload.
- Show uploaded file names above the input field.

---

## Automatic Document Generation

Automatically generate various documents from the artifacts produced in each implementation and test phase.

**Documents to generate:**
- Requirements definition
- Basic design
- Detailed design
- Test reports (separate for unit / integration / E2E)

**Backend:**
- Add `POST /api/v1/tasks/{id}/documents/generate` endpoint.
- Pass implementation prompt, test cases, and test results to Claude to generate Markdown.
- Save generated documents to DB (`task_documents` table).

**Frontend:**
- Add "Generate documents" button to the review screen.
- Preview and download (Markdown / PDF) of generated documents.

---

## Progress Indicator Improvements

Replace hourglasses, spinners, and fixed messages with real-time specific progress.

**Current problems:**
- Some areas show a fixed "Processing…" message during streaming.
- No indication of what overall step the process is at or how long it will take.

**Implementation plan:**
- Show processing in "XX / YY complete" format (e.g. `Running tests: 8 / 12 complete`).
- Estimate remaining time from past run durations and show "~N seconds remaining".
- Remove all fixed hourglass/spinner icons.
- Use an indeterminate progress bar for phases that can't emit granular stream events (e.g. code generation).

---

## Always-available Message Sending

Currently the textarea is `disabled` in some steps, preventing the user from sending additional instructions.

**Implementation plan:**
- Remove `disabled` from the textarea entirely; always allow input.
- If a message is sent while processing, enqueue it and auto-send on completion.
- Alternatively, provide an option to interrupt streaming and apply the additional instruction immediately.

---

## Exception Handling Improvements

Replace individual `try/catch` blocks with a single error surface.

**Frontend:**
- Introduce React `ErrorBoundary` to catch unhandled exceptions and redirect to a unified error screen.
- Handle API errors (4xx / 5xx) via a global axios interceptor.
- Remove per-component `try/catch` + local `errorMessage` state.

**Backend:**
- Use FastAPI `exception_handler` to unify error response format across the app.
- Standardize error responses to `{ code, message, detail }`.

---

## Automatic PR Creation

Automatically create a GitHub PR after tests pass and the user approves.

**Backend:**
- Extend the `git/push` endpoint or add a new `POST /git/create-pr` endpoint.
- Run `gh pr create` inside the container.
- Claude generates the PR title and body.

**Frontend:**
- Show a PR creation option after "Approve" on the review screen.

---

## GitHub Issue Integration

Receive issues via GitHub Webhook and automatically create and run tasks.

**Backend:**
- Add `POST /api/v1/webhooks/github` endpoint.
- Use the issue body as the task instruction and start the automated flow.

---

## Multi-user Support

Start after all single-user features are complete.

- GitHub OAuth authentication (`authlib` etc.)
- Per-user repository and task management
- Streaming blocking resolution (move to thread pool via `run_in_executor`)
- Per-user resource limits
