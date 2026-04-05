"""Task schemas."""
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
from app.models.task import TaskStatus


class TaskBase(BaseModel):
    """Base task schema."""

    title: str
    description: Optional[str] = None
    branch_name: str


class TaskCreate(BaseModel):
    """Task creation schema."""

    repository_id: int
    title: str
    description: Optional[str] = None
    branch_name: Optional[str] = None  # Auto-generated as karakuri/task-{id} if omitted


class TaskUpdate(BaseModel):
    """Task update schema."""

    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[TaskStatus] = None


class TaskResponse(TaskBase):
    """Task response schema."""

    id: int
    repository_id: int
    owner_id: int
    status: TaskStatus
    container_id: Optional[str]
    container_name: Optional[str]
    workspace_path: Optional[str]
    created_at: datetime
    updated_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


class TaskListResponse(BaseModel):
    """Task list item response."""

    id: int
    title: str
    status: TaskStatus
    branch_name: str
    repository_id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
