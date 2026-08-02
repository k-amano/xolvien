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
from app.services.activity_log import ActivityLog
from app.services.docker_service import get_docker_service
from app.errors import (
    ErrorCode, XolvienError, classify_exception, classify_text, error_sentinel_line,
)

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
            task.status = TaskStatus.IDLE
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
        # Derive a slug from the task title: lowercase, replace spaces/special chars with hyphens
        import re as _re
        slug = _re.sub(r'[^a-z0-9]+', '-', task_data.title.lower()).strip('-')[:40]
        task.branch_name = f"xolvien/{task.id}-{slug}" if slug else f"xolvien/task-{task.id}"
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

    # Container is stopped but can be restarted — keep status as idle
    task.status = TaskStatus.IDLE
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

    repo_result = await db.execute(
        select(Repository).where(Repository.id == task.repository_id)
    )
    repository = repo_result.scalar_one_or_none()

    docker_service = get_docker_service()

    async def stream():
        """
        Push with automatic repair and conflict resolution.

        Repair (repos rebuilt by an older Reset & Rebuild lack both):
          - missing `origin` remote -> re-added from the repository URL
          - missing task branch -> the current branch is renamed to it

        Conflict resolution: the task branch is dedicated
        to this task, so a rejected push is auto-resolved without user action:

          1. push
          2. rejected? -> fetch + rebase onto origin/{branch}, push again
          3. rebase impossible (divergent history — the normal aftermath of
             Reset & Rebuild, which reinitialises the repo)? -> abort rebase
             and push --force-with-lease (safe: the lease was just fetched,
             and only this task writes to its branch)

        Every failing step emits the [[XOLVIEN_ERROR:CODE]] sentinel — the
        stream never ends in an unresolved state without a visible error.
        """
        activity_log = ActivityLog(task_id, "git_push")
        branch = task.branch_name

        async def emit(chunk: str):
            await activity_log.write(chunk)
            return chunk

        def run_git(cmd: str):
            return docker_service.execute_command(
                task.container_id, cmd, "/workspace/repo"
            )

        def rejected(text: str) -> bool:
            t = text.lower()
            return any(p in t for p in (
                "[rejected]", "non-fast-forward", "failed to push", "fetch first",
            ))

        _GIT_ID = "-c user.name='Xolvien Bot' -c user.email='bot@xolvien.com'"

        try:
            # Auto-repair: restore a missing origin remote / task branch
            # (repos rebuilt by an older reset_workspace lost both, which
            # made push fail with "'origin' does not appear to be a git
            # repository" — previously misclassified as an auth failure).
            rc, _out, _ = run_git("git remote get-url origin 2>/dev/null")
            if rc != 0:
                if not repository or not repository.url:
                    yield await emit(error_sentinel_line(
                        ErrorCode.GIT_PUSH_REJECTED,
                        "no origin remote and no repository URL on record",
                    ))
                    return
                yield await emit("[GIT] origin リモートが未設定のため復元します...\n")
                rc, out, _ = run_git(f"git remote add origin {repository.url} 2>&1")
                if rc != 0:
                    yield await emit(error_sentinel_line(ErrorCode.GIT_PUSH_REJECTED, out))
                    return
            rc, _out, _ = run_git(f"git rev-parse --verify refs/heads/{branch} 2>/dev/null")
            if rc != 0:
                yield await emit(
                    f"[GIT] ブランチ '{branch}' が存在しないため、現在のブランチを改名します...\n"
                )
                rc, out, _ = run_git(f"git branch -M {branch} 2>&1")
                if rc != 0:
                    yield await emit(error_sentinel_line(ErrorCode.GIT_PUSH_REJECTED, out))
                    return

            yield await emit(f"[GIT] ブランチ '{branch}' を push しています...\n")
            rc, out, _ = run_git(f"git push -u origin {branch} 2>&1")
            if out.strip():
                yield await emit(out.rstrip("\n") + "\n")

            if rc != 0 and rejected(out):
                yield await emit(
                    "\n[GIT] リモートに別の変更があるため拒否されました。自動解決します...\n"
                )
                rc, out, _ = run_git(f"git fetch origin {branch} 2>&1")
                if out.strip():
                    yield await emit(out.rstrip("\n") + "\n")
                if rc != 0:
                    yield await emit(error_sentinel_line(classify_text(out) if classify_text(out) != ErrorCode.UNKNOWN else ErrorCode.GIT_PUSH_REJECTED, out))
                    return

                yield await emit("[GIT] リモートの変更を取り込んでいます (rebase)...\n")
                rc, out, _ = run_git(f"git {_GIT_ID} rebase origin/{branch} 2>&1")
                if out.strip():
                    yield await emit(out.rstrip("\n") + "\n")

                if rc == 0:
                    rc, out, _ = run_git(f"git push -u origin {branch} 2>&1")
                else:
                    # Divergent/conflicting history (Reset & Rebuild rewrites
                    # it from scratch). The local state is the task's truth —
                    # overwrite our own branch, guarded by the fresh lease.
                    run_git("git rebase --abort 2>&1")
                    yield await emit(
                        "[GIT] 履歴が分岐しています（Reset & Rebuild 後の状態）。"
                        "タスク専用ブランチのため上書き push します...\n"
                    )
                    rc, out, _ = run_git(
                        f"git push --force-with-lease -u origin {branch} 2>&1"
                    )
                if out.strip():
                    yield await emit(out.rstrip("\n") + "\n")

            if rc != 0:
                code = classify_text(out)
                yield await emit(error_sentinel_line(
                    code if code != ErrorCode.UNKNOWN else ErrorCode.GIT_PUSH_REJECTED, out
                ))
                return

            # fetch/rebase above ran as root — hand any newly created .git
            # objects back to the agent user so later agent-side git works.
            run_git(
                "find /workspace/repo \\! -user xolvien "
                "-exec chown xolvien:xolvien {} + 2>/dev/null || true"
            )
            yield await emit("\n[GIT] push 完了\n")
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield await emit(error_sentinel_line(code, str(e)))
        finally:
            await activity_log.close()

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
