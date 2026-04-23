"""Task model."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Enum
from sqlalchemy.orm import relationship
import enum
from app.database import Base


class TaskStatus(str, enum.Enum):
    """Task status enum."""

    PENDING = "pending"  # Created, container startup waiting
    INITIALIZING = "initializing"  # Container starting, git cloning
    IDLE = "idle"  # Waiting for instruction
    RUNNING = "running"  # Claude Code executing
    TESTING = "testing"  # Running tests
    COMPLETED = "completed"  # Completed
    FAILED = "failed"  # Failed
    STOPPED = "stopped"  # Manually stopped


class Task(Base):
    """Task model."""

    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    repository_id = Column(Integer, ForeignKey("repositories.id"), nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    branch_name = Column(String(255), nullable=False)

    status = Column(Enum(TaskStatus), default=TaskStatus.PENDING, nullable=False, index=True)

    # Docker container info
    container_id = Column(String(255), unique=True, nullable=True, index=True)
    container_name = Column(String(255), unique=True, nullable=True)
    workspace_path = Column(String(512), nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # Relationships
    repository = relationship("Repository", back_populates="tasks")
    owner = relationship("User", backref="tasks")
    instructions = relationship("Instruction", back_populates="task", cascade="all, delete-orphan")
    test_runs = relationship("TestRun", back_populates="task", cascade="all, delete-orphan")
    test_case_items = relationship("TestCaseItem", back_populates="task", cascade="all, delete-orphan")
    logs = relationship("TaskLog", back_populates="task", cascade="all, delete-orphan")
