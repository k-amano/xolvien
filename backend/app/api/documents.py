"""Generated-document endpoints (Sprint 3 — YAML storage; rendering comes later).

Documents are stored as files under {document_data_path}/tasks/{task_id}/,
named {doc_type}_{YYYYMMDD_HHMMSS}.yaml. The filesystem is the source of
truth — no DB table.
"""
import os
import re
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import verify_token
from app.database import get_db
from app.models.task import Task
from app.services.document_format import DOC_TYPES
from app.services.document_service import get_document_service

router = APIRouter(prefix="/api/v1/tasks/{task_id}/documents", tags=["documents"])

# {doc_type}_{YYYYMMDD_HHMMSS}.yaml — also serves as path-traversal protection.
_FILENAME_RE = re.compile(
    rf"^({'|'.join(DOC_TYPES)})_(\d{{8}}_\d{{6}})\.yaml$"
)


class DocumentInfo(BaseModel):
    doc_type: str
    filename: str
    generated_at: datetime
    size: int


async def _get_task_or_404(db: AsyncSession, task_id: int) -> Task:
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("", response_model=List[DocumentInfo])
async def list_documents(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """List a task's generated documents, newest first."""
    await _get_task_or_404(db, task_id)
    doc_dir = get_document_service().task_document_dir(task_id)
    if not os.path.isdir(doc_dir):
        return []

    docs: List[DocumentInfo] = []
    for name in os.listdir(doc_dir):
        m = _FILENAME_RE.match(name)
        if not m:
            continue
        generated_at = datetime.strptime(m.group(2), "%Y%m%d_%H%M%S")
        docs.append(DocumentInfo(
            doc_type=m.group(1),
            filename=name,
            generated_at=generated_at,
            size=os.path.getsize(os.path.join(doc_dir, name)),
        ))
    docs.sort(key=lambda d: d.generated_at, reverse=True)
    return docs


@router.get("/{filename}", response_class=PlainTextResponse)
async def get_document(
    task_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Return one document's raw YAML."""
    await _get_task_or_404(db, task_id)
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="Document not found")
    path = os.path.join(get_document_service().task_document_dir(task_id), filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Document not found")
    with open(path, encoding="utf-8") as f:
        return PlainTextResponse(f.read(), media_type="application/yaml")
