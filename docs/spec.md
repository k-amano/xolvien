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

> **Status (2026-07-02):** implemented, including binary documents. Excel/Word/PDF uploads are extracted to Markdown server-side (`services/document_converter.py`) so Claude Code can read them — see §5.1.

### 5.1 How files reach Claude

This project drives Claude via the **Claude Code CLI inside the task container**, not the Claude API. On each Claude run (`clarify_requirements()` / `execute_instruction()`), `DockerService.copy_uploads_to_container()` copies the **selected** uploads from the host volume into `/workspace/uploads/`, and `ClaudeCodeService._prepare_uploads()` injects an "Uploaded Reference Files" section into the prompt listing the paths. Claude reads the files with its `Read` tool. File content is **never embedded into prompts** — uploads are expected to be larger than the context window; Claude reads the relevant parts on demand.

Which uploads a message references is chosen per message (2026-07-26): the frontend sends `upload_ids` with clarify and execute requests (`None` = all uploads for backward compatibility, `[]` = none). A selected id that cannot be found or placed into the container raises `UPLOAD_NOT_AVAILABLE` — a run never quietly proceeds without its reference files.

The clarify flow runs without write-tool permissions, and `/workspace/uploads` is outside its working dir (`/workspace/repo`), so it is granted **read-only** access via `--add-dir /workspace/uploads` (runner flags `add_dirs`). With files selected, the clarify prompt requires reading them first and emitting a `[XOLVIEN_SPEC_READ]` marker as the first response line; the backend verifies the marker in the reconstructed assistant text and aborts with `SPEC_NOT_READ` if absent, so clarification can never interview the user without having read the spec. The marker is stripped from user-visible text.

Claude Code's `Read` tool rejects binary files, so binary documents are **converted to Markdown server-side** at upload time (`services/document_converter.py`, using `openpyxl`/`python-docx`/`pdfplumber`). The conversion is written as a sibling file `{stored_path}.md` on the host volume, copied into the container together with the original, and the prompt listing points Claude at the `.md` path (with an instruction not to read the binary). Conversion is also retried lazily on each Claude run (`_prepare_uploads()`), covering uploads that predate this feature or whose conversion failed; a failed conversion never rejects the upload itself.

| Type | Status |
|---|---|
| Markdown / plain text | ✅ Read directly by Claude Code. |
| Excel (.xlsx/.xlsm) | ✅ Converted to Markdown on upload — one section per sheet, rows as Markdown tables (cached formula values, not formulas). |
| Word (.docx) | ✅ Converted to Markdown on upload — headings, paragraphs, lists, tables in document order. |
| PDF | ✅ Converted to Markdown on upload — per-page text + detected tables (`pdfplumber`; scanned/image-only PDFs yield no text — no OCR). |
| PNG / JPG | Untested (Claude Code image support not yet verified in this path). |
| Other binaries | ❌ Not convertible; listed by path but unreadable by Claude Code. |

### 5.2 Storage

- Files are stored on the persistent `task_data` volume at `/data/uploads/repos/{repository_id}/{upload_id}_{filename}`, surviving container rebuilds, per-task volume removal, and Reset & Rebuild.
- File bytes live on the volume; metadata in the `uploads` table.
- Markdown conversions of binary documents are stored alongside as `{upload_id}_{filename}.md` (no DB column — naming convention only) and deleted together with the upload.
- Multiple files can be attached per repository; re-copied into the container on every Claude run.

### 5.3 Frontend Behavior

> **Design decision (2026-07-09, changed from the original design):** the attach control originally lived in its own "Reference files" strip, separate from the instruction input. Per user feedback this did not read as an attachment operation — it looked disconnected from the message being composed. Reworked to mirror a GitHub Issue comment box: the 📎 control sits **in the instruction textarea's own Markdown toolbar** (with Bold/Italic/code/etc.), and the attached-file chips render **directly above the textarea**, i.e. where a comment box shows what you've dropped into it. The underlying attachment model is unchanged — files remain repository-scoped and persist across every task of the project (see §5.1–5.2); only the placement of the controls changed.
- `components/RepositoryUploads.tsx` now exports a hook (`useRepositoryUploads`) plus two small pieces of UI (`AttachFilesButton`, `AttachedFilesChips`) instead of one self-contained component, so the button and the chip list can be placed independently.
- **TaskDetail**: `AttachFilesButton` is the last icon in the Markdown toolbar above the instruction textarea (after a divider); `AttachedFilesChips` renders immediately above the textarea, labeled "Reference files".
- **TaskCreate**: unchanged placement (a labeled row below the repository dropdown, shown only once an existing repository is selected) — there is no per-message toolbar on this screen since no instruction is being composed yet, so the button and chips render together as before, just via the new shared hook.
- Attached filenames appear as chips; each chip has a remove (×) button.
- **Per-message selection (2026-07-26):** each chip is a toggle — ✓ with a solid border means "referenced by the next message", ○ with a dashed/dimmed style means "stored but not referenced". Defaults to all-on (new uploads included); the toggle state at send time is sent as `upload_ids` with clarify and execute requests. × deletes the file from the repository regardless of toggle state.
- Files are uploaded immediately on selection.
- The instruction textarea is not auto-populated — files are attached silently.

---

## 6. Document Generation

Documents are generated automatically at each phase transition. They are stored as YAML files on the host (see §6.4) and will be rendered into Excel or HTML via templates at download time (renderer planned — see roadmap Sprint 3).

> **Status (2026-07-09):** generation, YAML file storage, list/fetch API, and the HTML/Excel renderer + render endpoint are implemented; the frontend Documents panel and custom templates are not yet.

### 6.1 Document Types and Generation Timing

| Document | Generated when (trigger) | Source material |
|---|---|---|
| Requirements definition | Execution starts = prompt confirmed (step 3) | Confirmed prompt |
| External design | Implementation complete (step 4) | Confirmed prompt + the agent reads the actual code in `/workspace/repo` |
| Internal design | Implementation complete (step 4) | Confirmed prompt + the agent reads the actual code in `/workspace/repo` |
| Specification | E2E test run complete (= all tests complete, step 18) | Implementation prompt + all test case items |
| Test report | E2E test run complete (= all tests complete, step 18) | Latest test run per type + per-case results (UT / IT / E2E) |

Documents are written in the **UI language at the time of the triggering run** (2026-07-28): every flow forwards `lang` to `schedule_generation()` — including the implement flow, which previously hard-coded Japanese (`InstructionCreate.lang` → `/execute-stream` → `execute_instruction()`).

Generation runs as **fire-and-forget background tasks** (`asyncio.create_task`) scheduled from the user flows, so the streamed response the user is watching is never delayed. The docgen Claude run uses its own `/tmp` file names inside the container (`xolvien_docgen_*`), so it cannot clobber a concurrent user-facing run; the two share container CPU (accepted v1 limitation). A generation failure is logged and never surfaces into the user flow.

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

All document types share **one common, content-oriented YAML format** — a section tree (auto-numbered `1.` / `1.1` / `1.1.1`, max depth 3) whose sections hold ordered content blocks of five kinds: `text`, `table`, `list`, `figure` (Mermaid), and `image`, in any order. One generic renderer handles every doc type; per-type differences (which chapters, which blocks) are enforced by the generation prompt, not the schema.

The normative spec — field tables, JSON Schema, complete example, rendering/generation contracts — is **[document-format.md](document-format.md)**.

> **Design decision (2026-07-07, changed from the original design):** the original §6.3 called for a fixed schema per `doc_type` with named fields that templates reference directly. That couples every template to every doc type and makes adding a document type a schema+template+renderer change. The common block format keeps templates generic (page frame only) and makes new doc types a prompt-only addition.

### 6.4 Storage & API

> **Design decision (2026-07-07, changed from the original design):** documents are stored as **files on the host**, not in a `task_documents` DB table. Rationale: the YAML file is the deliverable itself, file storage needs no migration, keeps every generation as a browsable history, and matches the platform's existing host-artifact pattern (activity logs).

- Location: `{document_data_path}/tasks/{task_id}/` — default `documents` relative to the backend cwd, i.e. `backend/documents/tasks/{task_id}/` (git-ignored; host-persisted in compose via the `./backend:/app` bind mount).
- File name: `{doc_type}_{YYYYMMDD_HHMMSS}.yaml`. Every generation is kept; the newest timestamp per `doc_type` is the current version. The filesystem is the source of truth (no DB table).
- Validation: parsed and checked against the `document-format.md` JSON Schema (plus row-width check) before saving; on failure the generation retries with the validation errors appended to the prompt (3 attempts total).
- Image assets: at generation time, every referenced image is copied from the container into the per-task snapshot `documents/tasks/{task_id}/assets/{path}` (missing images are skipped — renderers show a placeholder). `..`/absolute paths are refused.
- API:
  - `GET /api/v1/tasks/{task_id}/documents` — list `{doc_type, filename, generated_at, size}`, newest first (filesystem scan).
  - `GET /api/v1/tasks/{task_id}/documents/{filename}` — raw YAML (`application/yaml`). Filenames are validated against the strict `{doc_type}_{timestamp}.yaml` pattern (also blocks path traversal).
  - `GET /api/v1/tasks/{task_id}/documents/{filename}/render?format=html|excel` — renders the stored YAML on the fly: self-contained HTML (images as base64 data URIs, Mermaid via CDN) or an `.xlsx` workbook. The stored document is re-validated before rendering (422 on failure); unknown formats are rejected. *(GET on a specific filename instead of the originally planned `POST .../{doc_type}/render` — downloads are naturally GETs and the filename pins an exact generation.)*

### 6.5 Renderer & Template System

- **Two output formats**: Excel (`.xlsx`, openpyxl) and HTML — one generic block renderer per format (`services/document_renderer.py`), doc-type-agnostic per `document-format.md` §6.
- **HTML** (adapted from the user-provided prototype): deliverable styling — cover page, revision-history page, green level-1 heading bands, bordered tables with `colspan`/`rowspan`, multi-row headers, row-header styling, print CSS page breaks, notes/code blocks, Mermaid via CDN, images embedded as base64 data URIs (self-contained file).
- **Excel**: same tree walk with `merge_cells()` for spans, header fills, manual page breaks, embedded images, preformatted Mermaid/code blocks.
- **Page frame is currently built in code**; externalizing it into default templates (`backend/templates/default/`) and per-user custom templates (`POST /api/v1/templates/{doc_type}`, stored under `backend/templates/{user_id}/{doc_type}/`, taking precedence) is planned — see roadmap Sprint 3 step 3.5.
- PDF export is performed by the user via browser print or Excel.

### 6.6 Frontend Behavior

Document generation is fully automatic — no button press required. The UI for browsing/downloading is **not yet implemented** (roadmap steps 3.4/3.5); until it ships, users access documents via the API (`GET .../documents`, `GET .../documents/{filename}/render?format=html|excel` — see §6.4) or the YAML files under `backend/documents/tasks/{task_id}/`. The getting-started guides describe the concrete commands.

Planned UI (steps 3.4/3.5):

- After each phase transition that triggers generation, a notice appears in the right pane chat history (e.g. "Requirements definition generated").
- A "Documents" panel in the task detail page lists all generated documents for the task with their `generated_at` timestamps.
- Each document row has two download buttons: `Excel` and `HTML`.
- A "Templates" section in settings allows uploading custom Excel/HTML templates per document type.

---

## 7. Left-Pane Activity Log

The left pane is a **console.log-equivalent raw view**: Claude Code CLI's `stream-json` output flows through **unmodified** (no `[Thinking]`/`[Tool:]`/`[Result]` reformatting). This raw activity is also written to a host log file for later review (Sprint 4.1, implemented 2026-07-05).

### 7.1 What is shown / logged

Everything streamed during a Claude run, verbatim, as raw `stream-json` lines:
- `{"type":"_xolvien_input","prompt":...}` — the full prompt sent to Claude (input echo)
- `{"type":"system",...}`, `{"type":"stream_event",...}` (thinking/text/tool deltas), `{"type":"user",...}` tool results — Claude's raw output
- `{"type":"_xolvien_keepalive"}` — internal stream keepalive (filtered from the display, every 15s; also filtered from the log file)
- `[SYSTEM]`/`[GIT]` header lines and the terminal `[[XOLVIEN_ERROR:CODE]]` sentinel

The same raw stream is parsed on the frontend (`createStreamJsonRouter`) only to reconstruct the text the **right pane** needs (clarify question / `PROMPT_READY` / generated prompt); the left pane itself is never reformatted.

### 7.2 Storage

- Log files are written to `{activity_log_path}/tasks/{task_id}/` — default `logs` relative to the backend cwd, i.e. `backend/logs/tasks/{task_id}/` on the host.
- One file per streamed execution, named by flow: `{flow}_{YYYYMMDD_HHMMSS}.log` where flow is one of `execute`, `clarify`, `generate_prompt`, `generate_test_cases`, `generate_integration_test_cases`, `generate_e2e_test_cases`, `run_unit_tests`, `run_integration_tests`, `run_e2e_tests`, `git_push`.
- Each completed stream line becomes one file line: `[{ISO8601 timestamp}] {raw line}`.
- Files are never deleted automatically.
- In `docker compose --profile full`, `./backend` is bind-mounted at `/app`, so `backend/logs/` persists on the host independently of container lifecycle.
- `logs/` is covered by `.gitignore`.

### 7.3 Implementation

- `services/activity_log.py` — `ActivityLog(task_id, flow)`: buffers partial-line chunks and appends completed lines with `aiofiles` (non-blocking), creating the directory on first write; no file is created for an empty stream. Any filesystem error disables logging for the rest of the run without breaking the user-facing stream.
- `api/instructions.py` — all nine streaming endpoints route through a shared `_logged_stream()` helper that mirrors every chunk (including the terminal error sentinel) into the `ActivityLog` while yielding it to the client. `api/tasks.py` does the same for `git/push`.
- Logging at the API layer guarantees the file matches exactly what the left pane received.

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

Every busy chat card renders a `PhaseProgress` status line (roadmap 4.2, implemented 2026-07-05): the phase label, a live elapsed-time counter (1-second tick), an estimated remaining time when one can be computed, and a slim progress bar. The bar picks the best available signal, in order:

1. **Determinate** — real `done / total` counts when granular events exist (test-case generation, test-code generation, test execution). Remaining time is extrapolated from the observed pace of the current run.
2. **Time-estimated** — for phases with no granular events (clarify, prompt generation, implementation), the bar advances against the **median of the last 10 runs of that phase**, recorded per browser in `localStorage` (`xolvien-phase-durations`); capped at 95% and the remaining-time hint is dropped once the estimate is exceeded. No estimate is shown on the very first run.
3. **Indeterminate** — a sliding animation when neither signal exists yet.

Label formats:

- Test case / test code generation: `Generating test cases: done / total  (~mm:ss remaining)` (EN) / `テストケース生成中: done / total 件  (残り約mm:ss)` (JA). Remaining time computed from elapsed time per batch × remaining batches.
- Test execution: `Running tests: done / total complete (n failed)` (EN) / `テストを実行中: done / total 件完了 (n件失敗)` (JA) — the denominator is the number of approved test cases; counts are parsed from pytest/jest output (auto-fix re-runs reset the counter and show an indeterminate bar).
- Elapsed/remaining: `m:ss elapsed ・ ~m:ss remaining` (EN) / `経過 m:ss ・ 残り約 m:ss` (JA).

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
│   │   ├── document_service.py  # Document YAML generation + file storage + image asset snapshot
│   │   ├── document_format.py   # Document YAML JSON Schema + validation/extraction helpers
│   │   ├── document_renderer.py # Generic YAML -> HTML / Excel block renderer (i18n fixed strings)
│   │   ├── document_converter.py # Binary upload (xlsx/docx/pdf) → Markdown extraction (see §9.4)
│   │   └── test_service.py      # Test result parsing
│   └── websocket/
│       └── manager.py           # Per-task WebSocket connection pool
├── templates/
│   ├── default/                 # Bundled standard templates (Excel + HTML per doc_type)
│   └── {user_id}/               # User-uploaded custom templates
└── logs/
    └── tasks/
        └── {task_id}/           # Left-pane activity logs (host-side, persisted — see §7)

Repository uploads are NOT under backend/; they live on the persistent
`task_data` volume at /data/uploads/repos/{repository_id}/.
```

### 9.2 ClaudeCodeService Key Methods

| Method | Description |
|---|---|
| `_stream_runner_checked()` | Single choke point for every streamed Claude CLI run (2026-07-26). Streams raw chunks through unmodified while verifying the terminal `result` line: an `is_error:true` result, the runner's `_xolvien_error` loop-abort, or a stream ending with **no** result line all raise `XolvienError` (→ `[[XOLVIEN_ERROR:CODE]]` sentinel → error banner). Success must be proven; a run can never end silently. Optional `text_sink` collects `text_delta` fragments for callers that verify response content (clarify's proof-of-read marker). |
| `execute_instruction()` | Executes an arbitrary instruction via Claude Agent. Yields log lines as an AsyncGenerator. On failure, re-raises after DB cleanup so the error sentinel reaches the client. (Activity-log file writing happens at the API layer — see §7.3.) |
| `clarify_requirements()` | Requirement clarification Q&A. Asks one question at a time, each with a bulleted `Options:` / `選択肢:` block. Continues until the user clicks "Skip to generate prompt". With reference files selected, gets read-only upload access (`--add-dir`) and must emit `[XOLVIEN_SPEC_READ]` proving it read them (else `SPEC_NOT_READ`) — see §5.1. |
| `generate_prompt()` | Converts a brief instruction into an optimized prompt. |
| `generate_test_cases()` | Generates UNIT (`TC-NNN`), INTEGRATION (`ITC-NNN`), or E2E (`E2E-NNN`) test cases based on `test_type`. Uses batch generation via `--output-format json` + `--resume` (10 cases per call). Yields `[XOLVIEN_PROGRESS] done/total elapsed_ms=N eta_ms=0` after each batch. |
| `run_unit_tests()` | Wrapper passing `TestType.UNIT` to `_run_tests()`. |
| `run_integration_tests()` | Wrapper passing `TestType.INTEGRATION` to `_run_tests()`. |
| `run_e2e_tests()` | Wrapper passing `TestType.E2E` to `_run_tests()`. |
| `_run_tests()` | Shared implementation: generate test code → run → auto-fix loop (up to 3 attempts). Aborts immediately on infrastructure errors (EACCES etc.). |
| `_detect_test_command()` | Checks `package.json` first, then `pyproject.toml` / `setup.py` / `requirements*.txt`. All checks (including the pytest-installed probe) run as `AGENT_USER` so detection sees exactly what test execution sees — see §9.6. |
| `_extract_result_for_function()` | Handles Jest (`--verbose` `✓/✕ TC-xxx:`) and pytest verbose (`PASSED/FAILED`) output to determine verdict. |

### 9.3 DocumentService

| Method | Description |
|---|---|
| `generate_document(task_id, container_id, doc_type, source_material, lang)` | Runs Claude CLI in the task container (dedicated `xolvien_docgen_*` temp files, non-streaming), extracts the fenced YAML, validates against the format schema with up to 3 attempts (validation errors fed back), saves to `documents/tasks/{task_id}/{doc_type}_{ts}.yaml`. Returns the path or None (failure is logged, never raised). |
| `schedule_generation(task_id, container_id, jobs, lang)` | Module-level fire-and-forget scheduler: runs a list of `(doc_type, source_material)` jobs sequentially in a background asyncio task. Called from `execute_instruction()` (requirements at start; external/internal design at completion) and `_run_tests()` (specification + test report at E2E completion, sources built by `ClaudeCodeService._build_test_doc_sources()`). |
| `document_renderer.render_document(doc, fmt, assets_dir, generated_at)` | Renders a parsed document dict to a self-contained HTML string or `.xlsx` bytes (`HtmlDocumentRenderer` / `ExcelDocumentRenderer`). Exposed via `GET .../documents/{filename}/render?format=html\|excel`. Template selection (custom over default) comes with step 3.5. |

### 9.4 Uploads (repository-scoped)

There is no standalone UploadService; the logic spans the repository API and the existing services:

| Location | Responsibility |
|---|---|
| `api/repositories.py` | `POST/GET/DELETE /repositories/{id}/uploads` — streams files to the volume with `aiofiles`, manages the `uploads` table, triggers Markdown conversion on upload and deletes the `.md` sibling on delete. |
| `services/document_converter.py` | Extracts binary documents (`.xlsx`/`.xlsm`/`.docx`/`.pdf`) to a Markdown sibling file via `openpyxl`/`python-docx`/`pdfplumber`. `ensure_converted()` is idempotent (mtime-checked) and failure-tolerant (returns `None`, never raises to callers). Sync functions; async callers use `asyncio.to_thread`. |
| `DockerService.copy_uploads_to_container()` | Tars a repository's uploads (including `.md` conversions) into the container's `/workspace/uploads/` on each Claude run. |
| `ClaudeCodeService._prepare_uploads()` | Ensures conversions exist, copies uploads + injects an "Uploaded Reference Files" prompt section into `clarify_requirements()` / `execute_instruction()`; converted binaries are listed by their `.md` path. |

### 9.5 Docker Workspace

- Image: `xolvien-workspace:latest` (`docker/workspace/Dockerfile`)
- Contents: Python 3.11-slim + Git + Node.js 20 + Claude Code CLI
- Per-task volume: `xolvien-task-{task_id}-data` (mounted at `/workspace`)
- SSH keys: host `~/.ssh/` mounted into the container (for GitHub auth)
- Claude credentials: only `~/.claude/.credentials.json` copied into `/home/xolvien/.claude/` — and **re-copied at the start of every Claude flow** (`DockerService.refresh_claude_credentials()`, 2026-07-26), because host OAuth tokens rotate and the creation-time snapshot goes stale in long-lived containers (401 "token has been revoked"). A genuinely dead host token surfaces as the `CLAUDE_AUTH_FAILED` banner.

### 9.6 Test Execution Details

- **Single container-side user (2026-07-28):** framework detection, test execution, and app-side git commits all run as `AGENT_USER` (`xolvien`) — the same user Claude agent mode runs as and installs dependencies as (`pip install --user` lands in `/home/xolvien/.local`, invisible to root; a root-side check once produced "No test framework found" against a perfectly runnable suite). `DockerService.execute_command()` takes a `user` parameter (sets matching `HOME`). `_normalize_repo_ownership()` chowns any non-agent-owned repo files at the start of every flow, healing older tasks and preventing root-created `.git` objects from breaking later agent-side git operations. An undetectable test framework raises `TEST_INFRA_ERROR` (error banner) instead of ending quietly.
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
