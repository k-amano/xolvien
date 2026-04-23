"""Test case item and result schemas."""
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
from app.models.test_case_result import Verdict


class TestCaseItemResponse(BaseModel):
    id: int
    task_id: int
    seq_no: int
    tc_id: str
    target_screen: Optional[str]
    test_item: str
    operation: Optional[str]
    expected_output: Optional[str]
    function_name: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class TestCaseResultResponse(BaseModel):
    id: int
    test_case_item_id: int
    test_run_id: int
    actual_output: Optional[str]
    verdict: Optional[Verdict]
    executed_at: datetime

    class Config:
        from_attributes = True


class TestCaseItemWithLatestResult(TestCaseItemResponse):
    """TestCaseItem with the most recent result attached."""
    latest_result: Optional[TestCaseResultResponse] = None
