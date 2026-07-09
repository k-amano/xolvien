"""Generated-document endpoints (Sprint 3 — YAML storage; rendering comes later).

Documents are stored as files under {document_data_path}/tasks/{task_id}/,
named {doc_type}_{YYYYMMDD_HHMMSS}.yaml. The filesystem is the source of
truth — no DB table.
"""
import os
import re
from datetime import datetime
from typing import List

import yaml
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import verify_token
from app.database import get_db
from app.models.task import Task
from app.services.document_format import DOC_TYPES, validate_document
from app.services.document_renderer import render_document
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


def _document_path_or_404(task_id: int, filename: str) -> str:
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=404, detail="Document not found")
    path = os.path.join(get_document_service().task_document_dir(task_id), filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Document not found")
    return path


@router.get("/{filename}", response_class=PlainTextResponse)
async def get_document(
    task_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Return one document's raw YAML."""
    await _get_task_or_404(db, task_id)
    path = _document_path_or_404(task_id, filename)
    with open(path, encoding="utf-8") as f:
        return PlainTextResponse(f.read(), media_type="application/yaml")


@router.get("/{filename}/render")
async def render_document_file(
    task_id: int,
    filename: str,
    format: str = Query("html", pattern="^(html|excel)$"),
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Render a stored document to HTML or Excel (Sprint 3 step 3.3).

    Returns a download: text/html for `format=html`, an .xlsx workbook for
    `format=excel`. Images resolve against the task's asset snapshot.
    """
    await _get_task_or_404(db, task_id)
    path = _document_path_or_404(task_id, filename)

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f.read())
    errors = validate_document(data)
    if errors:
        raise HTTPException(status_code=422, detail=f"Stored document is invalid: {errors[0]}")

    m = _FILENAME_RE.match(filename)
    generated_at = datetime.strptime(m.group(2), "%Y%m%d_%H%M%S")
    assets_dir = get_document_service().task_assets_dir(task_id)
    base_name = filename.removesuffix(".yaml")

    rendered = render_document(data, format, assets_dir=assets_dir, generated_at=generated_at)
    if format == "html":
        return HTMLResponse(
            rendered,
            headers={"Content-Disposition": f'inline; filename="{base_name}.html"'},
        )
    return Response(
        rendered,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{base_name}.xlsx"'},
    )
