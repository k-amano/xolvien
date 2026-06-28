"""Repository management endpoints."""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
import os
import httpx
import aiofiles

from app.database import get_db
from app.models.repository import Repository
from app.models.user import User
from app.models.upload import Upload
from app.schemas.repository import RepositoryCreate, RepositoryResponse, RepositoryUpdate, GitHubRepoCreate
from app.schemas.upload import UploadResponse
from app.api.auth import verify_token
from app.config import get_settings


def _repo_upload_dir(repository_id: int) -> str:
    """Host directory holding a repository's uploads (on the persistent volume)."""
    return os.path.join(get_settings().upload_data_path, "repos", str(repository_id))

router = APIRouter(prefix="/api/v1/repositories", tags=["repositories"])


async def get_or_create_default_user(db: AsyncSession) -> User:
    """Get or create the default user (MVP: single user)."""
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()

    if not user:
        user = User(
            username="default",
            email="default@xolvien.com",
            full_name="Default User",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

    return user


@router.post("/github", response_model=RepositoryResponse, status_code=201)
async def create_github_repository(
    data: GitHubRepoCreate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Create a GitHub repository via API and register it in Xolvien."""
    settings = get_settings()
    if not settings.github_token:
        raise HTTPException(status_code=503, detail="GitHub token not configured")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://api.github.com/user/repos",
            headers={
                "Authorization": f"Bearer {settings.github_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            json={
                "name": data.name,
                "description": data.description or "",
                "private": data.private,
                "auto_init": True,
            },
        )

    if resp.status_code == 422:
        detail = resp.json().get("message", "Validation failed")
        raise HTTPException(status_code=422, detail=detail)
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="GitHub token is invalid or expired")
    if resp.status_code not in (200, 201):
        detail = resp.json().get("message", "GitHub API error")
        raise HTTPException(status_code=502, detail=f"GitHub API error: {detail}")

    gh = resp.json()
    ssh_url: str = gh["ssh_url"]

    user = await get_or_create_default_user(db)
    repository = Repository(
        name=data.name,
        url=ssh_url,
        description=data.description,
        owner_id=user.id,
    )
    db.add(repository)
    await db.commit()
    await db.refresh(repository)
    return repository


@router.get("", response_model=List[RepositoryResponse])
async def list_repositories(
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """List all repositories."""
    result = await db.execute(select(Repository))
    repositories = result.scalars().all()
    return repositories


@router.post("", response_model=RepositoryResponse, status_code=201)
async def create_repository(
    repository_data: RepositoryCreate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Create a new repository."""
    # Get or create default user
    user = await get_or_create_default_user(db)

    # Create repository
    repository = Repository(
        **repository_data.model_dump(),
        owner_id=user.id,
    )
    db.add(repository)
    await db.commit()
    await db.refresh(repository)

    return repository


@router.get("/{repository_id}", response_model=RepositoryResponse)
async def get_repository(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Get a repository by ID."""
    result = await db.execute(
        select(Repository).where(Repository.id == repository_id)
    )
    repository = result.scalar_one_or_none()

    if not repository:
        raise HTTPException(status_code=404, detail="Repository not found")

    return repository


@router.patch("/{repository_id}", response_model=RepositoryResponse)
async def update_repository(
    repository_id: int,
    repository_data: RepositoryUpdate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Update a repository."""
    result = await db.execute(
        select(Repository).where(Repository.id == repository_id)
    )
    repository = result.scalar_one_or_none()

    if not repository:
        raise HTTPException(status_code=404, detail="Repository not found")

    # Update fields
    update_data = repository_data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(repository, field, value)

    await db.commit()
    await db.refresh(repository)

    return repository


@router.delete("/{repository_id}", status_code=204)
async def delete_repository(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Delete a repository."""
    result = await db.execute(
        select(Repository).where(Repository.id == repository_id)
    )
    repository = result.scalar_one_or_none()

    if not repository:
        raise HTTPException(status_code=404, detail="Repository not found")

    await db.delete(repository)
    await db.commit()

    return None


# ── Repository uploads (spec/design docs for requirements analysis) ───────────

async def _get_repository_or_404(db: AsyncSession, repository_id: int) -> Repository:
    result = await db.execute(select(Repository).where(Repository.id == repository_id))
    repository = result.scalar_one_or_none()
    if not repository:
        raise HTTPException(status_code=404, detail="Repository not found")
    return repository


@router.get("/{repository_id}/uploads", response_model=List[UploadResponse])
async def list_uploads(
    repository_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """List files attached to a repository."""
    await _get_repository_or_404(db, repository_id)
    result = await db.execute(
        select(Upload).where(Upload.repository_id == repository_id).order_by(Upload.created_at)
    )
    return result.scalars().all()


@router.post("/{repository_id}/uploads", response_model=List[UploadResponse], status_code=201)
async def upload_files(
    repository_id: int,
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Attach one or more files to a repository. Stored on the persistent host
    volume so they survive task containers and can be referenced repeatedly.
    """
    await _get_repository_or_404(db, repository_id)

    dest_dir = _repo_upload_dir(repository_id)
    os.makedirs(dest_dir, exist_ok=True)

    created: List[Upload] = []
    for file in files:
        # Create the row first to get an id for a collision-free stored name.
        upload = Upload(
            repository_id=repository_id,
            filename=file.filename or "file",
            content_type=file.content_type,
            stored_path="",
            size=0,
        )
        db.add(upload)
        await db.flush()  # assigns upload.id without committing

        stored_name = f"{upload.id}_{os.path.basename(upload.filename)}"
        stored_path = os.path.join(dest_dir, stored_name)

        size = 0
        async with aiofiles.open(stored_path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                await out.write(chunk)

        upload.stored_path = stored_path
        upload.size = size
        created.append(upload)

    await db.commit()
    for upload in created:
        await db.refresh(upload)
    return created


@router.delete("/{repository_id}/uploads/{upload_id}", status_code=204)
async def delete_upload(
    repository_id: int,
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Delete a repository upload (file + metadata)."""
    result = await db.execute(
        select(Upload).where(
            Upload.id == upload_id, Upload.repository_id == repository_id
        )
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=404, detail="Upload not found")

    if upload.stored_path and os.path.isfile(upload.stored_path):
        try:
            os.remove(upload.stored_path)
        except OSError:
            pass  # metadata removal still proceeds

    await db.delete(upload)
    await db.commit()
    return None
