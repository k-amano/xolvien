"""Instruction schemas."""
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
from app.models.instruction import InstructionStatus


class GeneratePromptRequest(BaseModel):
    """Request schema for prompt generation."""

    content: str
    feedback: Optional[str] = None


class InstructionBase(BaseModel):
    """Base instruction schema."""

    content: str


class InstructionCreate(InstructionBase):
    """Instruction creation schema."""

    pass


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
