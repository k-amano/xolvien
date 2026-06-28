"""Upload schemas."""
from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class UploadResponse(BaseModel):
    """Metadata for a file attached to a Repository."""

    id: int
    repository_id: int
    filename: str
    content_type: Optional[str] = None
    size: int
    created_at: datetime

    class Config:
        from_attributes = True
