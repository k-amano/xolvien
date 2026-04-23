"""FastAPI application."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import get_settings
from app.api import auth, repositories, tasks, instructions, logs, test_runs, test_cases

settings = get_settings()

app = FastAPI(
    title="Xolvien API",
    description="AI-driven development platform powered by Docker and Claude Code",
    version="0.1.0",
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
