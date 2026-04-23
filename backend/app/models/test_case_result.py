"""Test case result model — one row per test run per test case item."""
import enum
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Enum
from sqlalchemy.orm import relationship
from app.database import Base


class Verdict(str, enum.Enum):
    PASSED = "PASSED"
    FAILED = "FAILED"
    ERROR = "ERROR"
    SKIPPED = "SKIPPED"


class TestCaseResult(Base):
    __tablename__ = "test_case_results"

    id = Column(Integer, primary_key=True, index=True)
    test_case_item_id = Column(Integer, ForeignKey("test_case_items.id"), nullable=False, index=True)
    test_run_id = Column(Integer, ForeignKey("test_runs.id"), nullable=False, index=True)

    actual_output = Column(Text, nullable=True)           # 実際の出力値（テストランナー出力から抽出）
    verdict = Column(Enum(Verdict), nullable=True)        # PASSED / FAILED / ERROR / SKIPPED
    executed_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    test_case_item = relationship("TestCaseItem", back_populates="results")
    test_run = relationship("TestRun", back_populates="test_case_results")
