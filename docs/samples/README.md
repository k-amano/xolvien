# Sample Files

Sample files for trying out Xolvien's file-upload feature, provided together
with the [Getting Started Guide](../getting-started.md).

## sample-spec.xlsx

A complete English software specification for a small **Expense Tracker REST
API** (Python 3.11 + FastAPI + SQLite + pytest). It is sized so that Xolvien
can take it through the whole pipeline — requirements clarification, coding,
automated testing, and document generation — in a single task.

The workbook contains six sheets:

| Sheet | Contents |
|---|---|
| Overview | Purpose, background, scope (in/out), technology stack, deliverables, acceptance criteria |
| Functional Requirements | FR-001..FR-010 with priorities (expense CRUD, categories, monthly summary report, health check) |
| Data Model | `Category` and `Expense` entities with types and constraints |
| API Endpoints | 10 endpoints under `/api/v1` with requests, responses, and error cases |
| Validation & Errors | VR-001..VR-007 plus the standard JSON error format |
| Test Perspectives | TP-001..TP-010 — the minimum test coverage the implementation must pass |

### How to use it

1. Create a task with a new (empty) repository, or select an existing repository.
2. Attach `sample-spec.xlsx` with the 📎 button (shown on the task-creation screen when an existing repository is selected, and in the repository strip on the task detail screen).
3. Send an instruction such as:

   ```
   Implement the application according to the attached specification.
   ```

Xolvien converts the Excel file to Markdown on upload (Excel/Word/PDF cannot be
read directly by Claude Code), places it in the task container, and references
it in the prompt, so Claude reads the specification when clarifying
requirements and implementing the code.
