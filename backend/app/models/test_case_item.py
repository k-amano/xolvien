"""Test case item model — one row per approved test case (specification level)."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import ENUM
from sqlalchemy.orm import relationship
from app.database import Base
from app.models.test_run import TestType

# Reuse the existing 'testtype' PostgreSQL enum (shared with test_runs)
_testtype_pg = ENUM('unit', 'integration', 'e2e', name='testtype', create_type=False)


class TestCaseItem(Base):
    __tablename__ = "test_case_items"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    seq_no = Column(Integer, nullable=False)          # 1-based within the task → TC-001

    # Test type: unit / integration / e2e — shares the 'testtype' PG enum with test_runs
    test_type = Column(_testtype_pg, default=TestType.UNIT, nullable=False)

    # Specification fields
    target_screen = Column(String(256), nullable=True)   # 対象画面
    test_item = Column(String(512), nullable=False)      # テスト項目
    operation = Column(Text, nullable=True)              # 操作方法（具体的入力値を含む）
    expected_output = Column(Text, nullable=True)        # 期待される具体的出力値

    # Links the spec to the generated test function
    function_name = Column(String(256), nullable=True)   # e.g. test_tc001_login_empty_password

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    task = relationship("Task", back_populates="test_case_items")
    results = relationship("TestCaseResult", back_populates="test_case_item", cascade="all, delete-orphan")

    @property
    def tc_id(self) -> str:
        prefix = "ITC" if self.test_type == TestType.INTEGRATION else "TC"
        return f"{prefix}-{self.seq_no:03d}"
