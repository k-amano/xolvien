"""Instruction schemas."""
from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List, Literal
from app.models.instruction import InstructionStatus


class GenerateTestCasesRequest(BaseModel):
    """Request schema for test case generation."""
    implementation_prompt: str
    lang: str = "ja"


class RunUnitTestsRequest(BaseModel):
    """Request schema for running unit tests."""
    implementation_prompt: str
    lang: str = "ja"


class RunIntegrationTestsRequest(BaseModel):
    """Request schema for running integration tests."""
    implementation_prompt: str
    lang: str = "ja"


class RunE2ETestsRequest(BaseModel):
    """Request schema for running E2E tests."""
    implementation_prompt: str
    lang: str = "ja"


class GeneratePromptRequest(BaseModel):
    """Request schema for prompt generation."""

    content: str
    feedback: Optional[str] = None
    lang: str = "ja"


class ChatMessage(BaseModel):
    """A single message in the clarification conversation."""

    role: Literal['assistant', 'user']
    content: str


class ClarifyRequest(BaseModel):
    """Request schema for requirement clarification."""

    instruction: str
    history: List[ChatMessage] = []
    lang: str = "ja"
    # Which repository uploads this message references. None = all uploads
    # (backward compatible); [] = none; otherwise the selected upload ids.
    upload_ids: Optional[List[int]] = None


class InstructionBase(BaseModel):
    """Base instruction schema."""

    content: str


class InstructionCreate(InstructionBase):
    """Instruction creation schema."""

    # See ClarifyRequest.upload_ids — same semantics for execution.
    upload_ids: Optional[List[int]] = None


class InstructionResponse(InstructionBase):
    """Instruction response schema."""

    id: int
    task_id: int
    status: InstructionStatus
    output: Optional[str]
    error_message: Optional[str]
    exit_code: Optional[int]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True
