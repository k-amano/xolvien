# Changelog

---

## 2026-07-07

### Sprint 3 step 3.2 — document generation + YAML file storage

All five document types are now generated as YAML (per `document-format.md`)
and saved to host files. The renderer is deliberately deferred (user
decision): producing and persisting the documents comes first.

**Storage decisions:**
- Location: `{document_data_path}/tasks/{task_id}/` — default
  `backend/documents/tasks/{task_id}/` (config `document_data_path`;
  git-ignored; host-persisted in compose via the existing `./backend:/app`
  mount). **Changed from the planned `task_documents` DB table** — the YAML
  file is the deliverable itself, needs no migration, and keeps history.
- File name: `{doc_type}_{YYYYMMDD_HHMMSS}.yaml`. Every generation is kept;
  newest timestamp per doc_type = current version. Filesystem is the source
  of truth.
- Timing (background, fire-and-forget `asyncio.create_task` — never delays
  the user's stream): `requirements` at execution start (= prompt confirmed);
  `external_design` + `internal_design` at execution completion;
  `specification` + `test_report` at E2E test-run completion (= all tests
  done). Failures are logged, never surfaced into the user flow.

**Backend:**
- New `services/document_format.py` — the format's JSON Schema
  (mirrors document-format.md §4) + `extract_yaml_document()` (last fenced
  ```yaml block, fallback raw) + `validate_document()` (schema + row-width
  check, max 10 errors returned for retry prompts).
- New `services/document_service.py` — per-doc-type role/outline prompts
  (JA/EN, chapter outlines per spec §6.2) + a compact format-rules prompt
  block; runs Claude CLI non-streaming in the task container via a dedicated
  docgen runner (`/tmp/xolvien_docgen_*` — cannot clobber the user-flow
  runner's files; `claude -p --output-format text`, xolvien user, blocking
  exec wrapped in `asyncio.to_thread`); validate → retry with error feedback
  (3 attempts total) → save. `schedule_generation()` runs job lists
  sequentially in the background (one extra claude process at a time).
- `services/claude_service.py` — three trigger points (see timing above);
  `_build_test_doc_sources()` collects test-case items + latest run per type
  + per-case results into the specification / test-report source material.
- New `api/documents.py` — `GET /api/v1/tasks/{task_id}/documents` (list
  from filesystem, newest first) and `GET .../documents/{filename}` (raw
  YAML; strict filename regex doubles as path-traversal protection).
- `config.py`: `document_data_path` (default `documents`); `.gitignore`:
  `backend/documents/`; deps: `jsonschema` added (+ `pyyaml` made explicit).

**Verified:** unit tests for extraction (last-fence/fallback/empty),
validation (valid doc, row-width, unknown block type), prompt builders
(JA/EN), and app imports; then a **real end-to-end generation** against task
13's container — the requirements doc for a small feature came back as valid
YAML on the first attempt (10 KB, sections/tables per the outline, correctly
grounded in the repo's existing code) and was saved; list API returned it,
fetch API served the YAML, and a path-traversal probe got 404.
**Not verified live:** the three in-flow triggers (requirements at execute
start, designs at completion, spec/report at E2E completion) — they are thin
wrappers around the verified `generate_document()`; observe on the next real
task run.

### Sprint 3 step 1 — common document YAML format specified

Sprint 3 (automatic document generation) was split into six steps (see
roadmap). Step 3.1 delivers the normative format spec, `docs/document-format.md`:

- **One common format for all five doc types** (changed from the original
  per-doc-type fixed schemas): a section tree auto-numbered at render time
  (`1.` / `1.1` / `1.1.1`, max depth 3) whose sections hold **ordered,
  free-order content blocks** of five kinds — `text` (plain, escaped),
  `table` (header + scalar-cell rows, numbered caption), `list`
  (bullet/number, nested ≤ 3), `figure` (Mermaid source; HTML renders it,
  Excel emits preformatted source in v1), `image` (workspace-relative path,
  snapshotted into `backend/doc_assets/` at generation so documents outlive
  the container; missing images render a placeholder, never fail).
- System metadata (task, generated_at) stays in the storage layer (file
  location + timestamped name after step 3.2's file-storage decision) and is
  passed to templates as separate `meta` context — the YAML holds content
  only.
- Normative JSON Schema embedded in the spec (`format_version: 1`,
  `additionalProperties: false` everywhere); generation extracts a fenced
  YAML block, validates, and retries with error feedback up to 2 times.
- Per-type chapter outlines are a **prompt** concern (spec §6.2), not a
  schema constraint — adding a doc type is a prompt-only change.
- spec.md §6.3 rewritten to reference the new spec; roadmap Sprint 3 split
  into ordered steps with 3.1 marked done.

---

## 2026-07-05

### Sprint 4.2 — Progress indicator improvements

Fixed busy messages ("Thinking...", "Generating prompt...", "Running... (may
take 1–3 min)") are replaced with real progress on every busy chat card.
Frontend-only; no backend change.

**New:**
- `components/PhaseProgress.tsx` — status line rendered inside each busy card:
  phase label + live elapsed counter (1 s tick) + estimated remaining + a slim
  bar. Signal priority: real `done/total` counts → time-based estimate from
  past runs (bar capped at 95%, remaining hint dropped once exceeded, nothing
  claimed on the first run) → indeterminate sliding animation (CSS keyframes
  in `styles.css`).
- `services/phaseHistory.ts` — records each completed phase's duration in
  `localStorage` (`xolvien-phase-durations`, last 10 per flow) and estimates
  via the median. Tracked flows: `clarify`, `generate_prompt`, `execute`.

**TaskDetail.tsx:**
- Busy `ChatEntry` variants gained `startedAt` (and `progress` on
  `test_running`); completion callbacks record durations (errors don't).
- Test execution labels switched to `done / total complete` — the denominator
  is the approved test-case count (`plannedTotal = items.length`) for all
  three flows (unit / integration / E2E); auto-fix phases show an
  indeterminate bar.
- Test-case generation cards reuse the streamed `[XOLVIEN_PROGRESS]`
  `done/total` for a determinate bar (`tcGenProgress` state).

**i18n (ja/en):** `progressRunning` / `progressIntegration` / `progressE2E`
now take `(done, total, failed)`; new `phaseElapsed` / `phaseRemaining` keys.

**Verified:** `tsc --noEmit` + production build clean; browser-verified with
Playwright against a live clarify flow — first run showed the indeterminate
bar with `経過 0:09`, the duration (17.8 s) was recorded to localStorage, and
the second run showed `経過 0:09 ・ 残り約 0:09` with a time-estimate bar.
**Not verified live:** the test-execution `done / total` labels (same code
path as the previously working counts; needs a full test run to observe).

### Sprint 4.1 — Left-pane activity log persisted to host files

Everything the left pane shows (the raw `stream-json` conversation with Claude)
is now also written to host log files for later review. Since the 2026-06-28
raw-stream rework, all streamed flows pass through the streaming endpoints
unmodified, so logging was implemented **at the API layer** — the file is
guaranteed to match exactly what the left pane received, including the
`[SYSTEM]`/`[GIT]` header lines and the terminal `[[XOLVIEN_ERROR:CODE]]`
sentinel (which service-level logging would have missed).

**Backend:**
- New `services/activity_log.py` — `ActivityLog(task_id, flow)` appends to
  `{activity_log_path}/tasks/{task_id}/{flow}_{YYYYMMDD_HHMMSS}.log`, one line
  per stream line, each prefixed `[{ISO8601 with tz, ms}] `. Partial-line
  chunks are buffered until complete; `{"type":"_xolvien_keepalive"}` lines are
  filtered (the left pane drops them too); the file/directory is created
  lazily on first write (no empty files); any filesystem error disables
  logging for the rest of the run and never breaks the user-facing stream.
  Writes via `aiofiles` (non-blocking).
- `config.py`: `activity_log_path` (default `logs`, resolved against the
  backend cwd → `backend/logs/`). Already covered by `.gitignore` (`logs/`)
  and already host-persisted in compose via the existing `./backend:/app`
  bind mount — no compose change needed.
- `api/instructions.py`: the nine streaming endpoints' identical
  `generate()` + `StreamingResponse` blocks were deduplicated into a shared
  `_logged_stream(task_id, flow, source)` helper that mirrors every chunk into
  the `ActivityLog` while yielding it (flows: `execute`, `clarify`,
  `generate_prompt`, `generate_test_cases`, `generate_integration_test_cases`,
  `generate_e2e_test_cases`, `run_unit_tests`, `run_integration_tests`,
  `run_e2e_tests`). All streaming responses now also send
  `X-Content-Type-Options: nosniff` (previously execute-stream only).
- `api/tasks.py`: `git/push` streaming wrapped the same way (flow `git_push`).

**Deviation from the original 4.1 note:** filenames are
`{flow}_{YYYYMMDD_HHMMSS}.log`, not `instruction_{instruction_id}_...` — the
instruction row is created inside `execute_instruction()` after the stream
starts, so the ID isn't known at the API layer, and per-flow naming covers all
ten streamed flows (the original note predates the raw-stream rework and
covered only execute).

**Verified:** unit tests for chunk buffering across split lines, keepalive
filtering, timestamp format, unwritable-directory tolerance, and no-file-on-
empty-stream; then a real `POST /execute-stream` run against a live task
container — 206 lines logged end-to-end (`[SYSTEM]` header → `_xolvien_input`
echo → raw stream-json → `[GIT]` commit → `[SYSTEM] Done`), zero keepalives in
the file. **Not verified:** the test-flow and git-push paths against a real
run (same wrapper code path as execute).

---

## 2026-07-02

### Sprint 2 completed — binary uploads converted to Markdown server-side

Resolved the Sprint 2 blocker (Claude Code CLI's `Read` tool rejects binary
files) with **option 1 — server-side text extraction**: uploaded Excel/Word/PDF
documents are converted to a Markdown sibling file on the host volume, and the
prompt points Claude at the readable `.md` instead of the binary. No DB change
(naming convention `{stored_path}.md`), no new endpoints, no frontend change.

**Backend:**
- New `services/document_converter.py`:
  - `.xlsx`/`.xlsm` via `openpyxl` (`read_only=True, data_only=True` — cached formula values): one `## Sheet: {name}` section per sheet, non-empty rows as a Markdown table.
  - `.docx` via `python-docx` (`iter_inner_content()` preserves order): headings (`Heading N` → `#`×N), list paragraphs (`- `), plain paragraphs, tables.
  - `.pdf` via `pdfplumber`: `## Page N` + extracted text + detected tables. No OCR — scanned PDFs yield `(no extractable text)`.
  - `ensure_converted()` is idempotent (skips when the `.md` is newer than the source), failure-tolerant (logs a warning, removes any stale partial `.md`, returns `None` — never raises to callers), and sync (async callers use `asyncio.to_thread`).
- `api/repositories.py`: `upload_files` converts right after saving each file; `delete_upload` also removes the `.md` sibling.
- `services/claude_service.py` `_prepare_uploads()`: re-ensures conversions before each container copy (covers uploads that predate this feature or earlier failures), then lists converted binaries by their `/workspace/uploads/{stored}.md` path with an EN/JA note to read the conversion and not the binary original; the raw binary is not listed separately. Text/other uploads are listed as before. (`copy_uploads_to_container()` needed no change — the `.md` lives in the same host dir and is tarred in automatically.)
- `pyproject.toml`: added `openpyxl`, `python-docx`, `pdfplumber`.

**Verified:** end-to-end via the API — `POST /repositories/{id}/uploads` with
`sample-spec.xlsx` produced `{id}_sample-spec.xlsx.md` (Japanese 仕様書 sheet →
Markdown table) on the volume; DELETE removed both files. Generated `.docx`
(headings/lists/tables) and `.pdf` samples converted correctly; a corrupt
`.xlsx` logged a warning and returned `None` without failing the upload;
re-conversion is skipped when the `.md` is up to date. `_prepare_uploads()`
listing verified for JA/EN with mocked DB/Docker. **Not verified:** an actual
Claude run reading the converted spec inside a task container (requires a full
task flow).

### Sample specification shipped with the manual

New `docs/samples/` directory (referenced from the getting-started guides'
task-creation step): `sample-spec.xlsx` — a complete English specification for
an Expense Tracker REST API (6 sheets: overview, FR-001..010, data model, 10
API endpoints, VR-001..007 + error format, TP-001..010) sized to exercise the
full pipeline (clarify → code → test → docs), plus `README.md` describing the
sheets and usage. Replaces the throwaway Japanese greeting-app sample that sat
untracked at the repo root. Conversion of the new sample verified via
`document_converter` (~7k chars of structured Markdown).

---

## 2026-06-28

### Raw stream-json left pane across all Claude flows

The real-time log display had only ever been applied to the **execute** flow.
clarify, prompt generation, and the test flows still ran `--output-format text`
with a dummy `[Claude]...` keepalive, so their left pane showed almost nothing.
Reworked per a clarified spec: **the left pane is a console.log-equivalent RAW
view** — Claude Code CLI's `stream-json` lines flow through UNMODIFIED, with no
`[Thinking]`/`[Tool:]`/`[Result]` reformatting and no dummy keepalive. The right
pane is unchanged; the frontend reconstructs the text it needs.

**Backend (`claude_service.py`):**
- New unified `_RUNNER_SCRIPT_STREAM` used by all streamed flows. Streams raw `stream-json` verbatim; per-flow auth via a flags file (clarify: root + `HOME=xolvien` + no `--dangerously-skip-permissions`; others: drop-privs + skip). Keeps loop-detection. Emits a JSON keepalive `{"type":"_xolvien_keepalive"}` every 15s so the stream never goes silent.
- Echoes the prompt sent to Claude as `{"type":"_xolvien_input",...}` so the left pane shows the INPUT (incl. the user instruction) as well as the output.
- Removed dead `_RUNNER_SCRIPT` / `_RUNNER_SCRIPT_AGENT`; added `_write_runner` helper. Test code-gen `[XOLVIEN_TC_DONE]` counting reconstructs assistant text from `text_delta`. Auto-fix `chunk_timeout=120s`.

**Frontend:**
- New `createStreamJsonRouter()` in `api.ts`: raw chunk in → verbatim raw for the left pane + reconstructed assistant text (text_delta concat) for the right pane. Ignores keepalive/input/non-text events.
- clarify ×2 and prompt-gen ×2 handlers route via the router; right-pane render unchanged. Left-pane filter now only drops the injected keepalive line.
- Includes the earlier `pumpStream` fix (forward chunks immediately instead of buffering to end-of-stream — a 1.1 regression that had blanked the left pane).

**Verified** for clarify/execute (left pane streams raw JSON input+output in real time). **Not yet re-verified:** test-flow pass/fail counting against raw JSON.

### Sprint 2 file upload — reopened (binary files unreadable)

Marked Sprint 2 as **partially done / blocked**: Claude Code CLI's `Read` tool
rejects binary files (`This tool cannot read binary files` for `.xlsx`), so the
primary use case (read an uploaded Excel/Word/PDF spec) does not work. The upload
pipeline itself works; the binary-reading gap is a blocker tracked in `roadmap.md`
with three candidate fixes (server-side text extraction / Claude API document
blocks / in-container conversion).

---

## 2026-06-22

### Repository-scoped file uploads for requirements analysis (Roadmap Sprint 2)

Upload spec/design docs and screen mockups so Claude Code reads them when
generating and implementing code.

**Two design changes from the original spec:**
- **Scope:** uploads attach to the **Repository (project)**, not a task — a project's fixes each become a task, so task-scoped uploads would require re-uploading the same spec each time. Repository-scoped uploads are referenced repeatedly by every fix-task.
- **Claude integration:** files are passed via the **Claude Code CLI** (copied into the container, referenced by path) rather than the Claude API document/image blocks, matching this project's CLI architecture. `pdfplumber`/`python-docx`/`openpyxl` extraction was not needed.

**Backend:**
- New `models/upload.py` (`Upload`) + `Repository.uploads` relationship; `schemas/upload.py`; Alembic migration `f1a2b3c4d5e6` (`uploads` table, head was `e74383bc60a3`).
- `config.py`: `upload_data_path` (default `/tmp/xolvien/uploads`); `docker-compose.yml`: `UPLOAD_DATA_PATH=/data/uploads` and the persistent `task_data` volume now mounts at `/data` so both `/data/tasks` and `/data/uploads` survive rebuilds.
- `api/repositories.py`: `POST/GET/DELETE /api/v1/repositories/{id}/uploads` (`multipart/form-data`, streamed to disk with `aiofiles`). Files stored at `/data/uploads/repos/{repository_id}/{upload_id}_{filename}`.
- `services/docker_service.py`: `copy_uploads_to_container()` tars the repo's uploads into the container's `/workspace/uploads/` (re-copied each run, so it survives Reset & Rebuild).
- `services/claude_service.py`: `_prepare_uploads()` copies uploads + injects an "Uploaded Reference Files" section into the `clarify_requirements()` and `execute_instruction()` prompts (EN/JA).

**Frontend:**
- New `components/RepositoryUploads.tsx` (📎 attach, upload-on-select, removable chips); `Upload` type; `getRepositoryUploads` / `uploadRepositoryFiles` / `deleteRepositoryUpload` in `api.ts`.
- Wired into `TaskCreate.tsx` (when an existing repo is selected) and `TaskDetail.tsx` (repo strip below the topbar). i18n keys added (EN/JA).


### React ErrorBoundary for unhandled render exceptions (Roadmap Sprint 1.3)

- New `components/ErrorBoundary.tsx`: a class component catching render-time exceptions via `getDerivedStateFromError` / `componentDidCatch`. Shows a self-contained recovery screen (⛔, bilingual copy, **Reload** / **Home** buttons) instead of a blank page. The technical detail goes to the console only, never to the user. Kept context/i18n-free so it still renders if the surrounding tree is broken.
- `main.tsx`: wraps the app (outermost, around `BrowserRouter`) so it catches everything.
- Completes Sprint 1.3 (operational/API errors were already handled by the cause-based error banner; this covers render-time bugs).

### Always-available message sending with auto-send queue (Roadmap Sprint 1.2)

The input textarea is no longer disabled while an operation is running, and
messages typed during processing are queued and auto-sent when the app is idle.

**Frontend `pages/TaskDetail.tsx`:**
- Added `pendingMessages` (FIFO queue) state + `flushingQueueRef` re-entrancy guard.
- `isInputBusy` derived from the operation flags (streaming / generating / clarifying / generatingTestCases / runningTests).
- `sendOrQueue()`: sends immediately when idle, otherwise enqueues. `dispatchTextSend()` routes a queued message to the correct action for the phase at send time (clarify answer if the last entry is a `clarify_question`, otherwise a new/modify instruction). Confirm/approve actions stay button-only and are never queued.
- A `useEffect` flushes the queue one message at a time: when `isInputBusy` clears (and no active error / container idle), it dequeues the oldest message and dispatches it; the guard + the busy-flag toggle drive the next iteration.
- Textarea `disabled` now only true for a missing/initializing container; `canSend` no longer blocks on busy. Queued messages render as a removable, numbered list above the input. Send button label switches to "Queue" while busy.
- Test/review steps also expose a send button when free text is present, so input is available in every phase.
- Removed the now-unused `handleSendClarifyAnswer` (superseded by `sendOrQueue`).

**Frontend `i18n/en.ts` / `ja.ts`:** added `queueAndSend`, `queuedLabel(n)`, `queuedRemove`.

---

## 2026-06-18

### Cause-based error display + unified exception handling (Roadmap Sprint 1.1 + 1.3)

Replaced raw error messages with a **cause-based error-code system**. The backend
is the source of truth; the frontend looks up human-friendly copy by code and
shows a banner with *what happened + plain-language cause + concrete recovery
actions*. **The raw exception text is never shown to the user** — it goes only to
the left log pane.

**Error taxonomy (9 codes):** `CONTAINER_NOT_RUNNING`, `TIMEOUT`,
`CLAUDE_API_ERROR`, `CLAUDE_PERMISSION_LOOP`, `GIT_AUTH_FAILED`,
`GIT_PUSH_REJECTED`, `TEST_INFRA_ERROR`, `NETWORK_ERROR`, `UNKNOWN`.

**Backend:**
- NEW `app/errors.py`: `ErrorCode` enum, `XolvienError` typed exception, a string-heuristic `classify_exception` / `classify_text`, `error_payload`, and `error_sentinel_line`.
- `main.py`: registered FastAPI exception handlers (`XolvienError`, Starlette `HTTPException`, bare `Exception`) standardizing all **non-streaming** responses to `{ code, message, detail }`.
- `api/instructions.py` (8 streaming endpoints) + `api/tasks.py` (git push): on error, emit a terminal `[[XOLVIEN_ERROR:CODE]] detail` sentinel line instead of a plain `[ERROR]` line (streams have already committed HTTP 200).

**Frontend:**
- NEW `src/errors.ts`: mirrors the enum + a fallback `classifyError(status, text)` (status 0 ⇒ `NETWORK_ERROR`) + `extractSentinel` + `codeFromBody`. Kept in sync with the backend rules.
- NEW `src/i18n/errorCatalog.ts`: `Record<ErrorCode, {title, cause, actions[]}>` for JA + EN; wired into `useLang()` via `i18n/index.ts`.
- `services/api.ts`: added a shared `pumpStream()` helper that strips the sentinel before forwarding text to `onChunk`, resolves a code at the stream boundary, and classifies HTTP/network failures. All stream callbacks changed from `onError(err: string)` to `onError(code, detail)`. Git auth/reject failures (HTTP 200 with in-stream text) are classified client-side on completion.
- `pages/TaskDetail.tsx`: `activeError` is now an `ErrorCode`; `raiseError(code, detail)` raises the banner + appends a code-keyed chat entry + pushes `detail` to the left log pane via `logErrorDetail()`. The banner renders title/cause/actions from the catalog. All ~17 error sites (clarify ×2, prompt gen, regenerate, implementation, unit/integration/e2e test runs, test-case gen + fetch ×4, revision, git push, session restore, reset) updated to pass codes. Action buttons + Git Push stay gated on `activeError`.

**Risk notes:** the sentinel is detected only at end-of-stream and stripped before reaching `onChunk`, so clarify's `PROMPT_READY` detection and the test-progress parser never see it; `onDone` is skipped when a sentinel fires.

**Drive-by:** fixed two pre-existing unused-variable build errors (`runningTestType`, `testPhaseLabel`) so `npm run build` passes clean.

---

## 2026-06-14

### Clarify: One-question-at-a-time with option buttons

**Changes:**

- Backend `services/claude_service.py`: Updated clarify prompts (EN and JA) to ask **exactly one question per response**, each followed by a bulleted `Options:` / `選択肢:` block of concrete choices. Removed the "Other (please specify)" option from the framework question — free-text input is always available alongside the buttons.

- Frontend `pages/TaskDetail.tsx`:
  - Added `parseClarifyQuestion()` — splits a Claude response on the `Options:` / `選択肢:` header into question text and an option list.
  - `clarify_question` chat cards now render options as **vertically-stacked buttons** (one per line, left-aligned). Buttons are shown only on the latest question card and hidden while a response is streaming.
  - Clicking an option button sends that option text immediately as the answer — no typing required.
  - Free-text input via the textarea remains fully available; both paths call the shared `submitClarifyAnswer(userMsg)` helper.
  - Extracted `submitClarifyAnswer(userMsg: string)` from `handleSendClarifyAnswer()` so button clicks and textarea submit share identical send logic.

### Right-pane UI improvements

**Changes:**

- Frontend `pages/TaskDetail.tsx`:
  - Removed inner scroll boxes (`maxHeight` + `overflowY: auto`) from all right-pane chat cards: generated prompt text, unit / integration / E2E test case tables, test result table, and review prompt block. The right pane's own scroll now covers all content without nesting.
  - Raised message input area height: `minHeight 120 → 200 px`, `maxHeight 300 → 400 px` (applies to both the Write textarea and the Markdown Preview div).

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
