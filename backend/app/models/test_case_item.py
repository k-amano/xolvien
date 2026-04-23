"""Test case item model — one row per approved test case (specification level)."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.database import Base


class TestCaseItem(Base):
    __tablename__ = "test_case_items"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    seq_no = Column(Integer, nullable=False)          # 1-based within the task → TC-001

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
        return f"TC-{self.seq_no:03d}"
