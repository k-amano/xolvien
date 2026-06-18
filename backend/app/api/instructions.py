"""Instruction execution endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List

from app.database import get_db
from app.models.task import Task
from app.models.instruction import Instruction, InstructionStatus
from app.models.test_run import TestType
from app.schemas.instruction import InstructionCreate, InstructionResponse, GeneratePromptRequest, ClarifyRequest, GenerateTestCasesRequest, RunUnitTestsRequest, RunIntegrationTestsRequest, RunE2ETestsRequest
from app.api.auth import verify_token
from app.services.claude_service import get_claude_service
from app.errors import XolvienError, classify_exception, error_sentinel_line

router = APIRouter(prefix="/api/v1/tasks/{task_id}/instructions", tags=["instructions"])


@router.post("", response_model=InstructionResponse, status_code=201)
async def create_instruction(
    task_id: int,
    instruction_data: InstructionCreate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Create and execute an instruction (non-streaming).

    Note: For streaming execution, use POST /execute-stream endpoint.
    """
    # Verify task exists
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # For now, just create the instruction record
    # Actual execution will be done via streaming endpoint
    instruction = Instruction(
        task_id=task_id,
        content=instruction_data.content,
    )
    db.add(instruction)
    await db.commit()
    await db.refresh(instruction)

    return instruction


@router.post("/execute-stream")
async def execute_instruction_stream(
    task_id: int,
    instruction_data: InstructionCreate,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Execute an instruction with streaming output.

    This endpoint returns a streaming response with real-time execution logs.
    """
    # Verify task exists
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get Claude Code service
    claude_service = get_claude_service()

    # Execute instruction with streaming
    async def generate():
        try:
            async for chunk in claude_service.execute_instruction(
                db, task_id, instruction_data.content
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-cache",
        },
    )


@router.post("/reset-workspace")
async def reset_workspace(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Delete all files under /workspace/repo and reinitialise a bare git repository.
    Called before "Reset & Rebuild" to start implementation from scratch.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.container_id:
        raise HTTPException(status_code=400, detail="Task has no container")

    claude_service = get_claude_service()
    try:
        claude_service.reset_workspace(task.container_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "ok"}


@router.post("/generate-prompt")
async def generate_prompt_stream(
    task_id: int,
    data: GeneratePromptRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Generate an optimized prompt from a brief user instruction.
    Returns a streaming response with the generated prompt text.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.generate_prompt(
                db, task_id, data.content, data.feedback or "", lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/clarify")
async def clarify_requirements_stream(
    task_id: int,
    data: ClarifyRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Conduct a requirement clarification Q&A session.
    Claude either asks 1-3 questions or outputs PROMPT_READY\\n{prompt}.
    Returns a streaming response.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.clarify_requirements(
                db, task_id, data.instruction, [m.model_dump() for m in data.history], data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/generate-test-cases")
async def generate_test_cases_stream(
    task_id: int,
    data: GenerateTestCasesRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Generate a test case list (Markdown) from an implementation prompt.
    Returns a streaming response. The user reviews and approves test cases
    before test code is generated.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.generate_test_cases(
                db, task_id, data.implementation_prompt, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/generate-integration-test-cases")
async def generate_integration_test_cases_stream(
    task_id: int,
    data: GenerateTestCasesRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Generate integration test cases. Returns streaming response."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.generate_test_cases(
                db, task_id, data.implementation_prompt, TestType.INTEGRATION, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/run-unit-tests")
async def run_unit_tests_stream(
    task_id: int,
    data: RunUnitTestsRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Generate test code from approved test cases, execute tests, and auto-fix
    up to 3 times. Streams progress output.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.run_unit_tests(
                db, task_id, data.implementation_prompt, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/run-integration-tests")
async def run_integration_tests_stream(
    task_id: int,
    data: RunIntegrationTestsRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Generate integration test code from approved test cases, execute tests against
    a running server + DB, and auto-fix up to 3 times. Streams progress output.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.run_integration_tests(
                db, task_id, data.implementation_prompt, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/generate-e2e-test-cases")
async def generate_e2e_test_cases_stream(
    task_id: int,
    data: GenerateTestCasesRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Generate E2E test cases (Playwright scenarios). Returns streaming response."""
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.generate_test_cases(
                db, task_id, data.implementation_prompt, TestType.E2E, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/run-e2e-tests")
async def run_e2e_tests_stream(
    task_id: int,
    data: RunE2ETestsRequest,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Generate Playwright E2E test code from approved test cases, run browser tests
    with screenshots, and auto-fix up to 3 times. Streams progress output.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    claude_service = get_claude_service()

    async def generate():
        try:
            async for chunk in claude_service.run_e2e_tests(
                db, task_id, data.implementation_prompt, lang=data.lang
            ):
                yield chunk
        except Exception as e:
            code = e.code if isinstance(e, XolvienError) else classify_exception(e)
            yield error_sentinel_line(code, str(e))

    return StreamingResponse(
        generate(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/last-completed", response_model=InstructionResponse)
async def get_last_completed_instruction(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """
    Get the most recently completed instruction for a task.
    Used to restore confirmedPrompt when resuming a session.
    """
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    result = await db.execute(
        select(Instruction)
        .where(
            Instruction.task_id == task_id,
            Instruction.status == InstructionStatus.COMPLETED,
        )
        .order_by(Instruction.created_at.desc())
        .limit(1)
    )
    instruction = result.scalar_one_or_none()
    if not instruction:
        raise HTTPException(status_code=404, detail="No completed instruction found")
    return instruction


@router.get("", response_model=List[InstructionResponse])
async def list_instructions(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """List all instructions for a task."""
    # Verify task exists
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Get instructions
    result = await db.execute(
        select(Instruction)
        .where(Instruction.task_id == task_id)
        .order_by(Instruction.created_at.desc())
    )
    instructions = result.scalars().all()

    return instructions


@router.get("/{instruction_id}", response_model=InstructionResponse)
async def get_instruction(
    task_id: int,
    instruction_id: int,
    db: AsyncSession = Depends(get_db),
    _token: str = Depends(verify_token),
):
    """Get an instruction by ID."""
    result = await db.execute(
        select(Instruction)
        .where(
            Instruction.id == instruction_id,
            Instruction.task_id == task_id,
        )
    )
    instruction = result.scalar_one_or_none()

    if not instruction:
        raise HTTPException(status_code=404, detail="Instruction not found")

    return instruction
