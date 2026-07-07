"""FastAPI application."""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from app.config import get_settings
from app.errors import XolvienError, classify_exception, error_payload
from app.api import auth, repositories, tasks, instructions, logs, test_runs, test_cases, documents

settings = get_settings()

app = FastAPI(
    title="Xolvien API",
    description="AI-driven development platform powered by Docker and Claude Code",
    version="0.1.0",
)


# ── Unified error responses ──────────────────────────────────────────────────
# All non-streaming errors are returned as {code, message, detail}. The frontend
# looks up human-friendly copy by `code`; `detail` is for logs only. Streaming
# endpoints (which have already committed a 200) emit a sentinel line instead.

@app.exception_handler(XolvienError)
async def handle_xolvien_error(_request: Request, exc: XolvienError):
    return JSONResponse(
        status_code=exc.status,
        content=error_payload(exc.code, exc.detail or exc.code.value, exc.detail),
    )


@app.exception_handler(StarletteHTTPException)
async def handle_http_exception(_request: Request, exc: StarletteHTTPException):
    detail = str(exc.detail)
    code = classify_exception(Exception(detail), status=exc.status_code)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_payload(code, detail, detail),
    )


@app.exception_handler(Exception)
async def handle_unhandled_exception(_request: Request, exc: Exception):
    code = classify_exception(exc, status=500)
    return JSONResponse(
        status_code=500,
        content=error_payload(code, str(exc), str(exc)),
    )

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth.router)
app.include_router(repositories.router)
app.include_router(tasks.router)
app.include_router(instructions.router)
app.include_router(logs.router)
app.include_router(test_runs.router)
app.include_router(test_cases.router)
app.include_router(documents.router)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "environment": settings.environment,
    }


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "message": "Xolvien API",
        "version": "0.1.0",
        "docs": "/docs",
    }
