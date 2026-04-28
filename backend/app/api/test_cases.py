"""Test case items and results API endpoints."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional

from app.database import get_db
from app.api.auth import verify_token
from app.models.task import Task
from app.models.test_case_item import TestCaseItem
from app.models.test_case_result import TestCaseResult
from app.models.test_run import TestType
from app.schemas.test_case import TestCaseItemWithLatestResult, TestCaseResultResponse

router = APIRouter(prefix="/api/v1/tasks/{task_id}/test-cases", tags=["test-cases"])


@router.get("", response_model=List[TestCaseItemWithLatestResult])
async def get_test_case_items(
    task_id: int,
    test_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Get all test case items for a task, with their latest result attached.

    Optionally filter by test_type (unit, integration, e2e).
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Task not found")

    query = select(TestCaseItem).where(TestCaseItem.task_id == task_id)
    if test_type is not None:
        try:
            tt = TestType(test_type.lower())
        except ValueError:
            raise HTTPException(status_code=422, detail=f"Invalid test_type: {test_type}")
        query = query.where(TestCaseItem.test_type == tt)
    query = query.order_by(TestCaseItem.seq_no)

    tc_result = await db.execute(query)
    items = tc_result.scalars().all()

    out = []
    for item in items:
        # Fetch latest result
        r_res = await db.execute(
            select(TestCaseResult)
            .where(TestCaseResult.test_case_item_id == item.id)
            .order_by(TestCaseResult.executed_at.desc())
            .limit(1)
        )
        latest = r_res.scalar_one_or_none()
        out.append(TestCaseItemWithLatestResult(
            id=item.id,
            task_id=item.task_id,
            seq_no=item.seq_no,
            tc_id=item.tc_id,
            test_type=item.test_type,
            target_screen=item.target_screen,
            test_item=item.test_item,
            operation=item.operation,
            expected_output=item.expected_output,
            function_name=item.function_name,
            created_at=item.created_at,
            latest_result=TestCaseResultResponse.model_validate(latest) if latest else None,
        ))
    return out


@router.get("/{item_id}/results", response_model=List[TestCaseResultResponse])
async def get_test_case_results(
    task_id: int,
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Get all results for a specific test case item (history across test runs)."""
    tc_res = await db.execute(
        select(TestCaseItem).where(TestCaseItem.id == item_id, TestCaseItem.task_id == task_id)
    )
    if not tc_res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Test case item not found")

    r_res = await db.execute(
        select(TestCaseResult)
        .where(TestCaseResult.test_case_item_id == item_id)
        .order_by(TestCaseResult.executed_at.desc())
    )
    return r_res.scalars().all()
