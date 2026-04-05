"""Task management endpoints."""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update as sql_update
from typing import List
from datetime import datetime

from app.database import get_db
from app.models.task import Task, TaskStatus
from app.models.repository import Repository
from app.models.task_log import TaskLog, LogLevel, LogSource
from app.schemas.task import TaskCreate, TaskResponse, TaskListResponse, TaskUpdate
from app.api.auth import verify_token
from app.api.repositories import get_or_create_default_user
from app.services.docker_service import get_docker_service

router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])


async def log_task_event(
    db: AsyncSession,
    task_id: int,
    message: str,
    level: LogLevel = LogLevel.INFO,
    source: LogSource = LogSource.SYSTEM,
):
    """Log a task event."""
    log = TaskLog(
        task_id=task_id,
        level=level,
        source=source,
        message=message,
    )
    db.add(log)
    await db.commit()


async def initialize_task_container(
    task_id: int,
    repository_url: str,
    branch_name: str,
    db_url: str,
):
    """Background task to initialize container."""
    from app.database import engine
    from sqlalchemy.ext.asyncio import async_sessionmaker

    # Create a new session for this background task
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    async with async_session() as db:
        try:
            # Update status to initializing
            result = await db.execute(select(Task).where(Task.id == task_id))
            task = result.scalar_one()
            task.status = TaskStatus.INITIALIZING
            await db.commit()

            await log_task_event(
                db, task_id, "Initializing workspace container...", source=LogSource.DOCKER
            )

            # Create container
            docker_service = get_docker_service()
            container_id, container_name = docker_service.create_workspace_container(
                task_id, repository_url, branch_name
            )

            # Update task with container info
            task.container_id = container_id
            task.container_name = container_name
            task.workspace_path = f"/workspace/repo"
            task.status = TaskStatus.IDLE
            task.started_at = datetime.utcnow()
            await db.commit()

            await log_task_event(
                db,
                task_id,
                f"Workspace container ready: {container_name}",
                source=LogSource.DOCKER,
            )

        except Exception as e:
            # Update status to failed
            result = await db.execute(select(Task).where(Task.id == task_id))
            task = result.scalar_one()
            task.status = TaskStatus.FAILED
            await db.commit()

            await log_task_event(
                db,
                task_id,
                f"Failed to initialize container: {str(e)}",
                level=LogLevel.ERROR,
                source=LogSource.DOCKER,
            )


@router.get("", response_model=List[TaskListResponse])
async def list_tasks(
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """List all tasks."""
    result = await db.execute(select(Task).order_by(Task.created_at.desc()))
    tasks = result.scalars().all()
    return tasks


@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(
    task_data: TaskCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Create a new task and spawn Docker container."""
    # Get repository
    result = await db.execute(
        select(Repository).where(Repository.id == task_data.repository_id)
    )
    repository = result.scalar_one_or_none()

    if not repository:
        raise HTTPException(status_code=404, detail="Repository not found")

    # Get or create default user
    user = await get_or_create_default_user(db)

    # Create task (branch_name may be None here; auto-assigned below after ID is known)
    task = Task(
        repository_id=task_data.repository_id,
        owner_id=user.id,
        title=task_data.title,
        description=task_data.description,
        branch_name=task_data.branch_name or "",  # temporary, updated below
        status=TaskStatus.PENDING,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    # Auto-generate branch name if not specified
    if not task_data.branch_name:
        task.branch_name = f"karakuri/task-{task.id}"
        await db.commit()
        await db.refresh(task)

    # Log creation
    await log_task_event(
        db, task.id, f"Task created: {task.title} (branch: {task.branch_name})", source=LogSource.SYSTEM
    )

    # Initialize container in background
    background_tasks.add_task(
        initialize_task_container,
        task.id,
        repository.url,
        task.branch_name,
        str(db.bind.url) if hasattr(db, "bind") else "",
    )

    return task


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Get a task by ID."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return task


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: int,
    task_data: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Update a task."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Update fields
    update_data = task_data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(task, field, value)

    await db.commit()
    await db.refresh(task)

    return task


@router.post("/{task_id}/stop", response_model=TaskResponse)
async def stop_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Stop a task."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if not task.container_id:
        raise HTTPException(status_code=400, detail="Task has no container")

    # Stop container
    docker_service = get_docker_service()
    docker_service.stop_container(task.container_id)

    # Update status
    task.status = TaskStatus.STOPPED
    task.completed_at = datetime.utcnow()
    await db.commit()
    await db.refresh(task)

    await log_task_event(
        db, task_id, "Task stopped", level=LogLevel.INFO, source=LogSource.SYSTEM
    )

    return task


@router.post("/{task_id}/git/push")
async def git_push(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Push the task branch to remote origin."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.container_id:
        raise HTTPException(status_code=400, detail="Task has no container")

    docker_service = get_docker_service()

    async def stream():
        yield f"[GIT] ブランチ '{task.branch_name}' を push しています...\n"
        async for chunk in docker_service.execute_command_stream(
            task.container_id,
            f"git push -u origin {task.branch_name} 2>&1",
            "/workspace/repo",
        ):
            yield chunk
        yield "\n[GIT] push 完了\n"

    return StreamingResponse(stream(), media_type="text/plain")


@router.delete("/{task_id}", status_code=204)
async def delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Delete a task and remove its container."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Remove container if exists
    if task.container_id:
        docker_service = get_docker_service()
        try:
            docker_service.remove_container(task.container_id, task_id)
        except Exception as e:
            # Log error but continue with deletion
            await log_task_event(
                db,
                task_id,
                f"Failed to remove container: {str(e)}",
                level=LogLevel.WARNING,
                source=LogSource.DOCKER,
            )

    # Null out FK references in task_logs before cascade delete to avoid constraint errors
    await db.execute(
        sql_update(TaskLog)
        .where(TaskLog.task_id == task_id)
        .values(instruction_id=None, test_run_id=None)
    )
    await db.flush()

    # Delete task (cascade will delete related records)
    await db.delete(task)
    await db.commit()

    return None
