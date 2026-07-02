# Roadmap

**Last updated**: 2026-07-02 (session 7)

This document tracks **what is done** and **what is planned**.
- For the complete intended specification, see `spec.md`.
- For detailed change notes on completed work, see `changelog.md`.

---

## Planned

Work is grouped into **sprints** in priority order (Sprint 1 first). Each item lists its scope and the trigger that gates it. Detailed designs for the larger features remain in `spec.md`.

### Sprint 1 — Foundational reliability & UX

These are everyday pain points that affect every task. Do these first.

| # | Item | Summary |
|---|------|---------|
| 1.1 | **Error Display** ✅ Done (2026-06-18) | Cause-based error system. Errors surface as a prominent red banner fixed above the chat viewport showing **friendly copy looked up by error code** — title (what happened), cause (plain language), and concrete recovery actions. The **raw exception text is never shown** in the banner or chat; it goes only to the left log pane. The banner appears immediately for every execution error (clarify, prompt gen, implementation, test runs, test-case gen, git push, session restore); Git Push, the send button, and all action buttons stay disabled until the user dismisses it. Implemented together with 1.3 (shared error-code taxonomy). |
| 1.2 | **Always-available Message Sending** ✅ Done (2026-06-22) | The textarea is no longer disabled while busy — only a missing/initializing container disables it. A message sent during processing is **enqueued** (FIFO) and auto-sent one at a time as soon as the app is idle, via a flush effect keyed on the busy flags. Queued messages show as a removable list above the input; each is routed by the phase at send time (clarify answer vs new/modify instruction). The send button shows "Queue" while busy. Confirm/approve actions remain button-only and are not queued. |
| 1.3 | **Exception Handling Improvements** ✅ Done (2026-06-22) | Cause-based `ErrorCode` taxonomy is the source of truth. Backend: `app/errors.py` defines the enum + classifier; FastAPI `exception_handler`s standardize all non-streaming responses to `{ code, message, detail }`; streaming endpoints emit a terminal `[[XOLVIEN_ERROR:CODE]]` sentinel. Frontend: `src/errors.ts` mirrors the enum with a fallback classifier; `api.ts` resolves a code at the stream boundary; the i18n `errorCatalog` maps each code to user copy. A top-level React `ErrorBoundary` (`components/ErrorBoundary.tsx`) catches unhandled render exceptions and shows a self-contained recovery screen (Reload / Home) instead of a blank page. |

### Sprint 2 — File Upload for Requirements Analysis (large feature: input) ✅ Done (2026-07-02)

Upload spec/design documents and screen mockups so Claude can read them when generating and implementing code.

**Status:** complete. The upload pipeline (UI → API → volume → container → prompt reference) works, and the binary-file blocker is resolved: Excel/Word/PDF uploads are **converted to Markdown server-side** on upload (option 1 below) so Claude Code can read them. Images (PNG/JPG) remain untested in this path.

**Design decision (changed from the original task-scoped spec):** uploads are attached to the **Repository (project)**, not to a single task. A project's fixes each become a separate task, so task-scoped uploads would force re-uploading the same spec every time. Repository-scoped uploads are referenced repeatedly by every fix-task.

**Claude integration (changed from the original direct-API spec):** this project drives Claude via the **Claude Code CLI inside the task container**, not the Claude API. Uploads are copied from the host into `/workspace/uploads/` and referenced by path in the prompt. The assumption that Claude Code reads PDFs/Excel/Word natively turned out to be **false** for binary formats — resolved by server-side Markdown extraction (see below).

- **Storage**: persistent `task_data` volume at `/data/uploads/repos/{repository_id}/{upload_id}_{filename}` — survives container rebuilds, per-task volume removal, and Reset & Rebuild. Markdown conversions sit alongside as `{upload_id}_{filename}.md` (naming convention, no DB column).
- **Data model**: `Repository ──< Upload` (`uploads` table: `id, repository_id, filename, content_type, stored_path, size, created_at`). File bytes on the volume, metadata in DB.
- **Backend**: `POST/GET/DELETE /api/v1/repositories/{id}/uploads` (`multipart/form-data`, `aiofiles`). `DockerService.copy_uploads_to_container()` tars uploads into `/workspace/uploads/` on each Claude run. `ClaudeCodeService._prepare_uploads()` injects an "Uploaded Reference Files" section into the `clarify_requirements()` and `execute_instruction()` prompts. (`python-multipart` + `aiofiles` were already present.)
- **Binary conversion (resolved the 2026-06-22 blocker, option 1 — server-side extraction):** new `services/document_converter.py` extracts `.xlsx`/`.xlsm` (openpyxl, sheet → Markdown table), `.docx` (python-docx, headings/lists/tables in order), and `.pdf` (pdfplumber, per-page text + tables) into a `.md` sibling at upload time; `_prepare_uploads()` re-ensures conversions lazily (covers pre-existing uploads) and points the prompt at the `.md` path instead of the unreadable binary. Conversion failures are logged, never block the upload.
- **Frontend**: `RepositoryUploads` component (📎 attach, removable chips, upload-on-select) shown in TaskCreate (when an existing repo is selected) and TaskDetail (repo strip below the topbar).

### Sprint 3 — Automatic Document Generation (large feature: output)

Auto-generate structured documents at each phase transition (no button press). Documents are stored as YAML and rendered to Excel/HTML via templates at download time — separating data from presentation.

- **Documents & timing**: Requirements definition (clarify complete) · External/basic design (execution complete) · Internal/detailed design (execution complete) · Specification (test complete) · Test report (test complete).
- **Storage**: `task_documents` table (`id, task_id, doc_type, yaml_content, generated_at`). Claude outputs YAML conforming to a fixed per-type schema.
- **Templates**: Jinja2 (HTML) + openpyxl (Excel). Defaults bundled under `backend/templates/default/{doc_type}/`; user uploads under `backend/templates/{user_id}/{doc_type}/` take precedence. PDF left to the user (browser/Excel export).
- **Backend**: `POST .../documents/generate/{doc_type}` (internal, per phase) · `POST .../documents/{doc_type}/render?format=excel|html` · `POST/GET /api/v1/templates/{doc_type}`. Add `jinja2`, `openpyxl` deps.
- **Frontend**: No Generate button. Availability indicator per phase; collapsible "Documents" panel listing all docs with `Excel`/`HTML` download buttons; "Templates" settings section for custom uploads.

### Sprint 4 — Operability & observability

| # | Item | Summary |
|---|------|---------|
| 4.1 | **Left-Pane Activity Log (persistent file logging)** | Record everything shown in the left pane (`[Thinking]`, `[Tool: X]`, `[Result]`, text deltas, `[ERROR]`, the `Starting Claude Code CLI...` header) to host files for later review. One file per execution at `backend/logs/tasks/{task_id}/instruction_{instruction_id}_{YYYYMMDD_HHMMSS}.log`, format `[{ISO8601}] {line}`. Write via `aiofiles` in `execute_instruction()` without blocking the stream. Bind-mount `backend/logs/` and add to `.gitignore`. No UI change. |
| 4.2 | **Progress Indicator Improvements** | Replace hourglasses/spinners/fixed messages with real progress: "XX / YY complete" (e.g. `Running tests: 8 / 12 complete`), estimated remaining time from past run durations, indeterminate bar only where granular events are impossible (e.g. code generation). |

### Sprint 5 — GitHub workflow automation

| # | Item | Summary |
|---|------|---------|
| 5.1 | **Automatic PR Creation** | After tests pass and the user approves, create a GitHub PR. Extend `git/push` or add `POST /git/create-pr`; run `gh pr create` in the container; Claude generates title and body. Frontend: show a PR option after "Approve" on the review screen. |
| 5.2 | **GitHub Issue Integration** | Receive issues via GitHub Webhook and auto-create/run tasks. Add `POST /api/v1/webhooks/github`; use the issue body as the task instruction and start the automated flow. |

### Sprint 6 — Future extension

| # | Item | Summary |
|---|------|---------|
| 6.1 | **Multi-user Support** | Start only after all single-user features are complete. GitHub OAuth (`authlib`), per-user repository/task management, streaming-blocking resolution (`run_in_executor` thread pool), per-user resource limits. |

---

## Completed

Newest first. Full change notes are in `changelog.md`.

### 2026-07-02 (session 7)

- **Sprint 2 completed: binary uploads readable via server-side Markdown conversion** — New `services/document_converter.py` extracts `.xlsx`/`.xlsm`/`.docx`/`.pdf` uploads to a `.md` sibling file (openpyxl / python-docx / pdfplumber) at upload time; `_prepare_uploads()` re-ensures conversions on every Claude run and lists the `.md` path in the prompt instead of the unreadable binary. Delete removes both files. Verified end-to-end via the API with `sample-spec.xlsx` (Japanese sheet → Markdown table) plus generated `.docx`/`.pdf` samples; corrupt files log a warning and never block the upload.

### 2026-06-28 (session 6)

- **Left pane = raw stream-json across all flows** — The real-time log display (originally execute-only) was unified onto raw `stream-json` for clarify / prompt-gen / execute / test flows. The left pane now shows Claude's input (echoed prompt) + output verbatim (console.log-equivalent); the right pane is unchanged (a shared frontend parser reconstructs the text it needs). Removed the dummy `[Claude]...` keepalive (replaced with a JSON keepalive). **Verified for clarify/execute; test-flow pass/fail counting not yet re-verified against raw JSON.**

### 2026-06 (session 4)

- **Clarify: one-question-at-a-time with option buttons** (2026-06-14) — Clarify prompts ask exactly one question per response with a bulleted options block (`Options:` in EN, localized header in JA); the latest question card renders clickable option buttons (free-text still available). *(was H5)*
- **Right-pane UI: nested-scroll removal & taller input** (2026-06-14) — Removed inner scroll boxes from all chat cards; raised input height (min 120→200 px, max 300→400 px).
- **Real-time log display (Claude Code style)** (2026-06-07) — Stream-json execution parsed line-by-line (`[Thinking]` / `[Tool:]` / `[Result]` / text deltas); append-only left pane; right pane filtered to final prompt only.
- **H4: permission errors loop indefinitely** (2026-06-13) — `reset_workspace()` chowns `/workspace/repo` to `xolvien`; runner aborts after 5 identical `[Result]` lines.
- **Task resume after stop/error** (2026-06-13) — Removed `FAILED`/`STOPPED` from the status enum (now transient); errors and `POST /stop` return the task to `IDLE`.
- **Reset & Rebuild flow** (2026-06-13) — Button no longer requires textarea input; fully resets frontend state before re-entering the clarify flow.
- **Implement redo flow (Modify / Reset & Rebuild)** (2026-06-07) — Implement step offers **Modify** (keep repo) and **Reset & Rebuild** (wipe repo) when a prior instruction exists.

### 2026-05

- **GitHub API: automatic repository creation** (2026-05-09) — `POST /api/v1/repositories/github` creates a repo via GitHub API (`auto_init`), saves the SSH URL; "Create on GitHub" tab added to TaskCreate.
- **Input field: Markdown preview** (2026-05-25) — GitHub-Issue-style input with Write/Preview tabs, Markdown toolbar, inline renderer.
- **I18N-1: UI language toggle** (2026-05-02) — `ja.ts`/`en.ts` maps + `LangContext`/`useLang()`; JA/EN header toggle persisted to `localStorage`.
- **I18N-2: documentation i18n** (2026-05-04) — Developer docs in English; `getting-started.md` (EN) / `getting-started.ja.md` (JA).

### 2026-04

- **Phase 3: E2E tests (Playwright)** (2026-04-30) — `run_e2e_tests()` + `E2E-NNN` test cases; headless browser with screenshots; independent generate→review→run flow; auto-transition integration→E2E→review.
- **Phase 2: integration tests** (2026-04-28) — `run_integration_tests()` + `ITC-NNN` cases separated from unit cases (`test_type` column, migration `a1b2c3d4e5f6`); server-startup + HTTP testing.
- **L1: chat-style right-pane layout overhaul** (2026-04-26) — Append-only chat history (`ChatEntry` union); pinned input; action buttons in footer via `renderActionButtons()`.
- **Bug fixes** (2026-04-26) — Blank actual-output/verdict in results; TC-count vs function-count summary; infinite auto-fix loop on infra errors (EACCES/EPERM); `Karakuri`→`Xolvien` rename; misc button-visibility fixes.
- **M1–M4: test UI** (2026-04-22/23) — Test type shown in banner; concrete "X done / Y failed" progress; `test_case_items` + `test_case_results` DB tables (TC-ID, concrete input/expected); test result summary table (inline + Markdown report, DB-restored).
- **H2/H3: test result summary & revision UI** (2026-04-21) — Test summary banner with passed/failed counts; inline test-case revision input replacing `window.prompt`.
- **Code review CR-1/CR-2/CR-3** (2026-04-21..06-07) — `generate_test_cases()` agent mode; improved `_detect_test_command()`; reverted `generate_prompt()` to text mode. (CR-4 Node.js upgrade was N/A — already on Node 20.)
- **H1: mojibake** (2026-04-19) — `execute_command_stream()` uses `codecs.getincrementaldecoder` to reassemble multi-byte chars split at chunk boundaries.
