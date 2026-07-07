"""Application configuration."""
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings."""

    # Database
    database_url: str

    # API
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    frontend_url: str = "http://localhost:5173"

    # Auth
    dev_auth_token: str = "dev-token-12345"

    # Docker
    docker_socket: str = "/var/run/docker.sock"
    workspace_image: str = "xolvien-workspace:latest"
    task_data_path: str = "/tmp/xolvien/tasks"
    # Repository-level uploads (spec/design docs) persist here, independent of
    # task containers. Referenced repeatedly across a project's fix-tasks.
    upload_data_path: str = "/tmp/xolvien/uploads"
    # Left-pane activity logs (raw stream-json) are written here, one file per
    # streamed execution. Relative paths resolve against the backend cwd, so
    # the default lands in backend/logs/ (bind-mounted in docker compose).
    activity_log_path: str = "logs"
    # Auto-generated documents (YAML, document-format.md) are stored here, one
    # file per generation: {path}/tasks/{task_id}/{doc_type}_{ts}.yaml
    document_data_path: str = "documents"

    # Claude Code (no longer used; Claude Code CLI is used instead)
    anthropic_api_key: str = ""

    # GitHub
    github_token: str = ""

    # Environment
    environment: str = "development"

    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
