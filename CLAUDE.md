# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Karakuri** is an AI-driven development platform that automates code generation using Docker containers and Claude Code CLI. It provides isolated workspaces per task, real-time log streaming via WebSocket, and a task/instruction management system.

Stack: Python 3.11 + FastAPI + SQLAlchemy 2.0 (async) + PostgreSQL 16 + Docker + React 18 + Vite + TypeScript.

## Commands

### Backend

```bash
# Start only the database (default profile)
docker compose up -d db

# Build the workspace Docker image used for task containers
docker build -t karakuri-workspace:latest ./docker/workspace/

# Run the backend (activate venv first)
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Run database migrations
cd backend
source venv/bin/activate
alembic upgrade head

# Create a new migration after model changes
alembic revision --autogenerate -m "description"
```

### Frontend

```bash
cd frontend
npm install
npm run dev    # Runs on port 5173
npm run build
npm run lint
```

### Full stack via Docker Compose

```bash
docker compose --profile full up
```

### Install backend dependencies (if venv not set up)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn sqlalchemy asyncpg psycopg2-binary alembic \
    python-dotenv docker pydantic pydantic-settings python-multipart websockets aiofiles
```

### Linting / formatting (configured in pyproject.toml, not yet automated)

```bash
cd backend
ruff check app/
black app/
mypy app/
```

## Environment Setup

Copy `.env.example` to `.env` in the backend directory. Key variables:

- `DATABASE_URL` — `postgresql+asyncpg://karakuri:karakuri@localhost:5433/karakuri`
- `DEV_AUTH_TOKEN` — Bearer token for MVP auth (default: `dev-token-12345`)
- `WORKSPACE_IMAGE` — Docker image for task containers (default: `karakuri-workspace:latest`)
- `ANTHROPIC_API_KEY` — Required when replacing the Claude Code simulation with the real CLI
- `DOCKER_SOCKET` — Path to Docker daemon socket

API docs available at `http://localhost:8000/docs` (Swagger UI).

## Architecture

### Backend Structure

```
backend/app/
├── main.py          # FastAPI app, router registration, CORS
├── config.py        # Pydantic Settings (loads from .env)
├── database.py      # Async SQLAlchemy engine + get_db() dependency
├── models/          # SQLAlchemy ORM models
├── schemas/         # Pydantic request/response schemas
├── api/             # FastAPI routers (one file per resource)
├── services/        # Business logic (singletons)
└── websocket/
    └── manager.py   # Per-task WebSocket connection pool
```

### Services (Business Logic)

All three services use a lazy-initialized singleton pattern:

- **`DockerService`** (`services/docker_service.py`) — Container lifecycle: creates a volume and container per task, clones the git repo inside, streams command output via `exec_run()`.
- **`ClaudeCodeService`** (`services/claude_service.py`) — Executes instructions inside the task container. Currently uses a Python simulation; replace with the actual Claude Code CLI by updating `execute_instruction()`.
- **`TestService`** (`services/test_service.py`) — Runs test commands in the container and parses output for pytest/jest/go test formats.

### Task Lifecycle

Tasks move through these statuses:
`PENDING → INITIALIZING → IDLE → RUNNING → TESTING → COMPLETED / FAILED / STOPPED`

When a task is created via `POST /api/v1/tasks`, a `BackgroundTask` calls `initialize_task_container()`, which calls `DockerService.create_workspace_container()`. The API returns immediately; clients poll `GET /api/v1/tasks/{id}` until status reaches `IDLE`.

### Data Model Relationships

```
User ──< Repository ──< Task ──< Instruction
                              └──< TestRun
                              └──< TaskLog (source: SYSTEM | DOCKER | CLAUDE | GIT | TEST)
```

Each `Task` stores its `container_id`, `container_name`, and `workspace_path`. Each `Instruction` tracks its own status (PENDING → RUNNING → COMPLETED/FAILED), output, exit code, and timestamps.

### Real-time Communication

- **`GET /api/v1/tasks/{id}/logs`** — Paginated historical logs (HTTP)
- **`WS /api/v1/ws/tasks/{id}/logs`** — Real-time log streaming (WebSocket)
- **`WS /api/v1/ws/tasks/{id}/status`** — Task status updates (WebSocket)

`ConnectionManager` in `websocket/manager.py` is a singleton that maintains per-task sets of active WebSocket connections and broadcasts to all listeners.

### Streaming Instruction Execution

`POST /api/v1/tasks/{task_id}/instructions/execute-stream` returns a `StreamingResponse`. `ClaudeCodeService.execute_instruction()` is an async generator that yields log lines as they arrive from the container.

### Docker Workspace Image

`docker/workspace/Dockerfile` — Python 3.11-slim + Git + Node.js 18 + build tools + Claude Code CLI (npm install). The entrypoint configures git globals; the container stays alive with `tail -f /dev/null`. Each task gets its own volume `karakuri-task-{task_id}-data` mounted at `/workspace`.

## Implementation Status

- **Backend**: Fully implemented (all endpoints, services, models, migrations, WebSocket).
- **Frontend**: Scaffolded (React + Vite + TypeScript) but not implemented — use Swagger UI at `/docs` for testing.
- **Claude Code CLI**: Currently a Python simulation in `claude_service.py`; real CLI integration is the next major step.
- **Auth**: Simple Bearer token (`DEV_AUTH_TOKEN`); GitHub OAuth is planned.
- **Multi-user**: Single auto-created default user; multi-user is planned.
