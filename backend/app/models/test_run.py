"""Test run model."""
import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.dialects.postgresql import ENUM
from sqlalchemy.orm import relationship
from app.database import Base


class TestType(str, enum.Enum):
    UNIT = "unit"
    INTEGRATION = "integration"
    E2E = "e2e"


# Reuse existing 'testtype' PG enum (values: unit, integration, e2e)
_testtype_pg = ENUM('unit', 'integration', 'e2e', name='testtype', create_type=False)


class TestRun(Base):
    """Test run model."""

    __tablename__ = "test_runs"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)

    # Test execution info
    test_type = Column(_testtype_pg, default=TestType.UNIT, nullable=False)
    test_command = Column(String(512), nullable=True)
    test_cases = Column(Text, nullable=True)  # テストケース一覧（Markdown形式）
    exit_code = Column(Integer, nullable=True)
    passed = Column(Boolean, default=False, nullable=False)
    retry_count = Column(Integer, default=0, nullable=False)

    # Results
    output = Column(Text, nullable=True)
    error_output = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)  # e.g., "10 passed, 2 failed"
    report_path = Column(String(512), nullable=True)  # コンテナ内のレポートファイルパス

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # Relationships
    task = relationship("Task", back_populates="test_runs")
    test_case_results = relationship("TestCaseResult", back_populates="test_run", cascade="all, delete-orphan")
