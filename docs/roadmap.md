# Roadmap

**Last updated**: 2026-06-14 (session 4)

See `spec.md` for currently implemented features.

---

## Priority: High (critical quality issues)

### ~~Real-time Log Display (Claude Code style)~~ ✅ Fixed (2026-06-07)

- `execute_instruction()` uses `_RUNNER_SCRIPT_EXECUTE`: Claude runs with `--output-format stream-json --include-partial-messages --verbose`.
- Stream events parsed line-by-line: thinking → `[Thinking] ...`, tool calls → `[Tool: X]`, results → `[Result] ...`, text deltas streamed directly.
- `clarify_requirements()` and `generate_prompt()` also add stream entries to the left pane so all Claude activity is visible in real time.
- Left pane is **append-only**: once displayed, content is never removed or replaced.
- `Starting Claude Code CLI...` header is always shown at the top of each stream entry and remains visible throughout (keepalive `[Claude] ...` lines are filtered out).
- Status banners removed from the left pane entirely — left pane shows Claude responses only.
- `[Thinking]`, `[Tool:]`, `[Result]`, `[Claude] ...` lines filtered from the right pane prompt display; only the final prompt text is shown there.
- WebSocket logs with `source == 'claude'` or `source == 'git'` are filtered out on the frontend to avoid duplication with the stream.

**Known issue (H4):** Fixed — see below.

---

### ~~H4: Permission errors loop indefinitely during execution~~ ✅ Fixed (2026-06-13)

During `execute_instruction`, Claude runs as root inside the container and hits permission errors on `/workspace/repo` (owned by the `xolvien` user). The error and git failure repeat in a loop with no automatic stop — the user must press Stop manually.

**Root cause:** `reset_workspace()` ran as root and left `/workspace/repo` owned by root, so the `xolvien` privilege drop inside `_RUNNER_SCRIPT_EXECUTE` could not write files.

**Fix:**
- `reset_workspace()` now calls `chown xolvien:xolvien /workspace/repo` before `git init` and `chown -R xolvien:xolvien /workspace/repo` after, so the freshly-reset repo is always owned by the correct user.
- `_RUNNER_SCRIPT_EXECUTE` now tracks consecutive identical tool results. After 5 consecutive identical `[Result]` lines, it kills the Claude process and emits `[ERROR] Identical error repeated 5 times — aborting to prevent infinite loop.`

---

### ~~H5: Clarify answers require full re-typing of question and answer~~ ✅ Fixed (2026-06-14)

When Claude asks a clarifying question with numbered options (e.g. `1. React  2. Vue`), the user must type the full answer. Single-option shortcuts (typing `1` or `2`) are not recognized. The core issue was that Claude asked multiple questions at once, making even numbered shortcuts insufficient.

**Fix:**
- **Backend** (`claude_service.py`): Updated both EN and JA clarify prompts to ask exactly **one question per response**, each with a bulleted `Options:` / `選択肢:` block.
- **Frontend** (`TaskDetail.tsx`): Added `parseClarifyQuestion()` — splits the Clauderesponse into question text and option list on the `Options:` / `選択肢:` header.
- Refactored `handleSendClarifyAnswer` to delegate to `submitClarifyAnswer(userMsg)` so both textarea input and button clicks share the same send logic.
- The latest `clarify_question` card renders each option as a clickable button; clicking sends that option text immediately without typing. Past question cards show options as plain text only.

---

### ~~Task resume after stop or error~~ ✅ Fixed (2026-06-13)

After a Stop or execution error, tasks were left in `stopped`/`failed` status, making all action buttons unavailable with no way to continue.

**Root cause:** `stopped` and `failed` were DB-persisted statuses. Once set, the frontend blocked all operations with `task?.status !== 'idle'`.

**Fix:**
- Removed `TaskStatus.FAILED` and `TaskStatus.STOPPED` from the enum entirely — these are transient runtime states, not persistent task states.
- DB migration removes `FAILED`/`STOPPED` from the PostgreSQL `taskstatus` enum and migrates any existing rows to `IDLE`.
- `execute_instruction` exceptions and `POST /stop` now both return the task to `IDLE`.
- `execute_instruction` status guard changed to only block `PENDING`/`INITIALIZING` (not `STOPPED`/`FAILED`).
- `ensure_container_running` already auto-restarts a stopped container on the next operation.

---

### ~~Reset & Rebuild flow broken~~ ✅ Fixed (2026-06-13)

`Reset & Rebuild` button was disabled when textarea was empty, and clicking it did not restart the clarify flow correctly.

**Fix:**
- Button `disabled` condition no longer requires textarea input.
- `handleResetAndRebuild` now fully resets frontend state to new-task initial values (`selectedStep`, `steps`, `confirmedPrompt`, `chatEntries`) before re-entering the clarify flow — identical to a new task.
- `handleStartClarify` accepts an optional `overrideMsg` so Reset & Rebuild can pass the previous instruction without requiring textarea input.
- `isClarifyMode` no longer requires `selectedStep === 'implement'`; it triggers whenever the last chat entry is `clarify_question`.

---

### Error Display

When an error occurs (timeout, Claude failure, container error, etc.), it must be immediately visible to the user in an unmissable way.

**Requirements:**
- Display errors as a prominently styled banner (red background, large text) in the right pane, not buried in the log stream.
- The banner must appear immediately when the error occurs — not after a delay.
- The Git Push button and all other action buttons must be disabled until the error is resolved.
- The current `[ERROR]` line in the log stream is insufficient — users miss it and proceed with push anyway.

---

### ~~Implement Redo Flow (Modify / Reset & Rebuild)~~ ✅ Fixed (2026-06-07)

- When a prior completed instruction exists, the Implement step now shows two buttons instead of one: **Modify** and **Reset & Rebuild**.
- **Modify**: Keeps `/workspace/repo` intact and starts the clarify → prompt generation → execute flow so Claude makes targeted changes to existing code.
- **Reset & Rebuild**: Calls `POST /reset-workspace` to delete all files under `/workspace/repo` and reinitialise a bare git repo, then starts the same clarify flow from scratch.
- `handleStartClarify()` now resets `chatEntries` before starting, so the new instruction is not confused with the previous one.

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

### ~~CR-3: `generate_prompt()` runs with excess permissions in agent mode~~ ✅ Fixed (2026-06-07)

- Reverted `generate_prompt()` to use `_RUNNER_SCRIPT` (text mode, `--output-format text`, no tool execution).
- Root cause of the regression: agent mode caused Claude to emit tool execution logs (e.g. `ls -la` output) into the prompt text stream.
- File list, git log, and README are pre-fetched by the backend and embedded in the meta-prompt, so agent mode is not needed.

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

### ~~Right-pane UI: nested scroll removal and taller input area~~ ✅ Fixed (2026-06-14)

- Removed inner scroll boxes from all chat cards that had `maxHeight` + `overflowY: auto` (prompt text, unit/integration/E2E test case tables, test result table, review prompt block) — the right pane's own scroll covers all content.
- Raised message input area height: `minHeight 120 → 200 px`, `maxHeight 300 → 400 px` (applies to both the textarea and the Markdown preview div).

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

Allow uploading spec documents, design docs, and screen mockups as attachments to the instruction, covering content that cannot be expressed in text alone (tables, diagrams, embedded images, etc.).

**Primary use case:** Upload a PDF/Word/Excel specification or design document and say "implement according to this spec." The file is passed directly to Claude alongside the text instruction so Claude reads the full document — tables, diagrams, and all — without lossy conversion.

**Secondary use case:** Upload wireframes or UI screenshots (PNG/JPG) as visual supplements to a text instruction.

**File types and how each is passed to Claude:**

| Type | Handling |
|------|----------|
| PDF | Uploaded via Claude `files` API and passed as a `document` block — Claude reads text, tables, and embedded images natively. |
| PNG / JPG | Passed as `image` blocks via Claude Vision. |
| Word (.docx) | Text and table content extracted with `python-docx` (structure preserved as Markdown-style text). Embedded images extracted separately and passed as `image` blocks. Both combined into a single multimodal message. |
| Excel (.xlsx) | Each sheet extracted with `openpyxl` as a structured text table (column/row layout preserved). Embedded images extracted and passed as `image` blocks. |
| Markdown / plain text | Read as-is and included as a `text` block. |

**Backend:**
- Add `POST /api/v1/tasks/{id}/uploads` endpoint (`multipart/form-data`), accepting multiple files per request.
- Process each file according to the table above and store a serialized representation (file bytes for PDF/images; extracted content for Word/Excel) in `backend/uploads/{task_id}/` on the host.
- Files persist independently of container lifecycle (host-side directory, not inside the container).
- When `clarify_requirements()` and `execute_instruction()` are called, the stored uploads for the task are included as additional blocks in the Claude API message alongside the text instruction.
- Add `python-docx` and `openpyxl` to backend dependencies.

**Frontend:**
- Add a file attachment button (paperclip icon) to the instruction input area.
- Attached filenames are shown as chips above the textarea; each chip has a remove (×) button.
- Files are uploaded immediately on selection (not on send); a small spinner on the chip indicates upload in progress.
- No text is auto-populated into the textarea — the user writes their instruction text normally and the files are silently attached.

---

## Automatic Document Generation

Automatically generate structured documents at each phase of the development flow. Documents are stored as YAML (structured data) and rendered into Excel or HTML via templates at download time — separating data from presentation.

---

### Document types and generation timing

| Document | Generated when | Source material |
|---|---|---|
| Requirements definition | clarify complete → prompt confirmed (auto) | Clarified Q&A, confirmed prompt |
| External design (basic design) | Instruction execution complete (auto) | Confirmed prompt, repo file list |
| Internal design (detailed design) | Instruction execution complete (auto) | Generated code, DB schema, class/method structure |
| Specification | Test complete (auto) | All of the above + test case items |
| Test report | Test complete (auto) | Test case results (UT / IT / E2E) |

All documents are generated automatically at the appropriate phase transition — no button press required.

---

### Document content definitions

**Requirements definition**
- Feature requirements list (what the system does)
- Screen list and screen transition flow
- Use cases (who does what)
- Non-functional requirements (if any emerge from clarify)

**External design (basic design)**
- Screen design: each screen's layout, fields, buttons, and validation
- Operation flows: user action → system response, per screen
- API list: endpoint, method, request/response schema
- External integrations (if any)

**Internal design (detailed design)**
- DB design: tables, columns, types, constraints, relationships
- Class design: class names, responsibilities, dependencies
- Method/property design: signatures, arguments, return types, processing summary

**Specification**
- All behaviors defined at minimum unit: input → operation → expected result
- Linked to test case IDs (TC-NNN / ITC-NNN / E2E-NNN)

**Test report**
- Test execution summary (passed / failed counts per type)
- Per-test-case result: TC-ID, test item, expected output, actual output, verdict, executed_at

---

### YAML schema (stored in DB)

Each document is stored as a YAML string in the `task_documents` table:

```
task_documents
  id, task_id, doc_type (enum), yaml_content (text), generated_at
```

Claude is prompted to output valid YAML conforming to a fixed schema per document type. The schema defines top-level keys, array structures, and field names so templates can reliably reference them.

---

### Template system

- **Two output formats**: Excel (`.xlsx`) and HTML (`.html`)
- **Template engine**: `Jinja2` for HTML; `openpyxl` for Excel (cell-level data injection)
- **Standard templates**: bundled with the system under `backend/templates/default/{doc_type}/` for both formats
- **Custom templates**: users can upload their own templates via `POST /api/v1/templates/{doc_type}` (Excel or HTML file); stored under `backend/templates/{user_id}/{doc_type}/` and take precedence over the default
- **Rendering**: `POST /api/v1/tasks/{id}/documents/{doc_type}/render?format=excel|html` — loads YAML from DB, selects the appropriate template, renders, and returns the file as a download
- PDF export is left to the user (browser print / Excel export)

---

### Backend

- `POST /api/v1/tasks/{id}/documents/generate/{doc_type}` — called internally at each phase transition; Claude generates YAML, saved to `task_documents`
- `POST /api/v1/tasks/{id}/documents/{doc_type}/render?format=excel|html` — renders YAML into the selected template and returns a file download response
- `POST /api/v1/templates/{doc_type}` — upload a custom template (Excel or HTML); replaces existing custom template for that doc type
- `GET /api/v1/templates/{doc_type}` — list available templates (default + custom) for a doc type
- Add `jinja2` and `openpyxl` to backend dependencies (both already available in most Python environments)

---

### Frontend

- No explicit "Generate" button — generation is automatic at each phase transition
- After each phase completes, a document availability indicator appears in the right pane (e.g. "Requirements definition generated")
- A "Documents" panel (collapsible) in the task detail page lists all generated documents for the task
- Each document row shows: doc type, generated_at, and two download buttons: `Excel` and `HTML`
- A "Templates" section in settings allows uploading custom Excel/HTML templates per document type

---

## Left-Pane Activity Log (Persistent File Logging)

Automatically record all Claude activity displayed in the left pane to a log file on the host so it can be reviewed at any time after the fact.

**What is logged:**
- Everything that appears in the left pane during an instruction execution: `[Thinking]`, `[Tool: X]`, `[Result]`, text deltas, `[ERROR]` lines, and the `Starting Claude Code CLI...` header.
- Each log entry includes a timestamp (`ISO 8601`), the task ID, the instruction ID, and the raw log line.

**Storage:**
- Log files are written to `backend/logs/tasks/{task_id}/` on the host (bind-mounted directory, not inside the container).
- One file per instruction execution: `instruction_{instruction_id}_{YYYYMMDD_HHMMSS}.log`
- Files are plain text (UTF-8), one log line per line, with the format: `[{timestamp}] {line}`
- Logs are never deleted automatically; rotation / archiving is out of scope for now.

**Backend:**
- In `ClaudeCodeService.execute_instruction()`, open the log file before streaming starts and write each yielded line to it as it is emitted.
- Use Python's built-in `logging` module or direct file I/O with `aiofiles` to avoid blocking the async stream.
- Create `backend/logs/tasks/{task_id}/` automatically if it does not exist.
- Ensure the `backend/logs/` directory is bind-mounted into the container via `docker-compose.yml` (so logs land on the host, not inside the container).
- Add `backend/logs/` to `.gitignore`.

**Frontend:**
- No UI changes required — logging is fully automatic and transparent.

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
