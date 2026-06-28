"""Upload model — files attached to a Repository for requirements analysis.

Uploads belong to a Repository (not a Task) so they persist across the many
fix-tasks of a project and can be referenced repeatedly. The file bytes live on
the host volume at `{upload_data_path}/repos/{repository_id}/`; this table holds
only metadata.
"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


class Upload(Base):
    """A file attached to a Repository."""

    __tablename__ = "uploads"

    id = Column(Integer, primary_key=True, index=True)
    repository_id = Column(Integer, ForeignKey("repositories.id"), nullable=False, index=True)
    filename = Column(String(512), nullable=False)
    content_type = Column(String(255), nullable=True)
    stored_path = Column(String(1024), nullable=False)
    size = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    repository = relationship("Repository", back_populates="uploads")
