# Xolvien

AI-driven development platform that automates code generation, testing, and Git operations using Docker containers and Claude Code CLI.

[日本語版 README はこちら](README.ja.md)

---

## What it does

Xolvien solves the key pain points of GitHub Actions + Claude Code workflows:

- **Local execution**: Run builds and tests inside isolated Docker containers — no more CI-only feedback loops
- **Branch continuity**: All work for a task stays on one branch across sessions
- **Your name on commits**: Commits are made under your Git identity, not Claude's

---

## How it works

1. Enter a brief instruction in Japanese or English
2. Claude clarifies requirements through Q&A (skippable)
3. Claude generates an optimized prompt — you approve it
4. Claude implements the code and commits
5. Claude generates test cases — you review and approve
6. Claude writes test code, runs unit tests, and auto-fixes failures (up to 3 retries)
7. You review the implementation and approve or reject
8. Git push to GitHub

Each task runs in its own Docker container with its own volume, so multiple tasks never interfere.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11 + FastAPI + SQLAlchemy 2.0 (async) |
| Database | PostgreSQL 16 (via Docker Compose) |
| Container management | docker-py |
| AI execution | Claude Code CLI (Max Plan, agent mode) |
| Frontend | React 18 + Vite + TypeScript |
| Real-time logs | WebSocket (FastAPI) |

---

## Requirements

| Requirement | Check command |
|---|---|
| Docker 20.10+ | `docker --version` |
| Python 3.11+ | `python3 --version` |
| Node.js 18+ | `node --version` |
| Claude Code CLI (authenticated) | `claude --version` |
| Claude Max Plan | — |
| GitHub SSH key (configured) | `ssh -T git@github.com` |

No Anthropic API key needed — Xolvien uses the Claude Code CLI with your Max Plan subscription.

---

## Quick start

```bash
# 1. Clone
git clone git@github.com:k-amano/xolvien.git
cd xolvien

# 2. Environment variables
cp .env.example backend/.env

# 3. Start the database
docker compose up -d db

# 4. Backend setup
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi "uvicorn[standard]" sqlalchemy asyncpg psycopg2-binary \
    alembic python-dotenv docker pydantic pydantic-settings \
    python-multipart websockets aiofiles \
    openpyxl python-docx pdfplumber
alembic upgrade head
cd ..

# 5. Build the workspace image (5–10 min)
docker build -t xolvien-workspace:latest ./docker/workspace/

# 6. Frontend setup
cd frontend && npm install && cd ..

# 7. Start backend (Terminal A)
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 8. Start frontend (Terminal B)
cd frontend && npm run dev
```

Open `http://localhost:5173` in your browser.

For detailed setup instructions, see [docs/getting-started.md](docs/getting-started.md) (Japanese).

---

## Daily use

```bash
docker compose up -d db
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
# (new terminal)
cd frontend && npm run dev
```

---

## API reference

Swagger UI: `http://localhost:8000/docs`

Authentication: `Authorization: Bearer dev-token-12345`

---

## Project structure

```
xolvien/
├── backend/app/
│   ├── api/             # FastAPI routers
│   ├── models/          # SQLAlchemy ORM models
│   ├── schemas/         # Pydantic schemas
│   └── services/
│       ├── claude_service.py   # Claude Code CLI execution & test automation
│       ├── docker_service.py   # Container lifecycle management
│       └── test_service.py     # Test result parsing
├── frontend/src/
│   ├── pages/TaskDetail.tsx    # Main UI (step bar, prompt flow, test panels)
│   └── services/api.ts         # API client
├── docker/workspace/           # Workspace Docker image
└── docs/
    ├── spec.md                 # Current specification
    ├── changelog.md            # Change history
    ├── roadmap.md              # Planned improvements
    └── getting-started.md      # User guide (Japanese)
```

---

## Documentation

| Document | Description |
|---|---|
| [docs/spec.md](docs/spec.md) | Current specification (data model, API, UI flow) |
| [docs/changelog.md](docs/changelog.md) | Change history |
| [docs/roadmap.md](docs/roadmap.md) | Planned features and improvements |
| [docs/getting-started.md](docs/getting-started.md) | Step-by-step user guide (Japanese) |

---

## License

MIT
