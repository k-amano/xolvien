"""Claude Code execution service."""
import os
import re
import base64
import asyncio
from typing import AsyncGenerator
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import anthropic

from app.config import get_settings
from app.models.task import Task, TaskStatus
from app.models.instruction import Instruction, InstructionStatus
from app.models.task_log import TaskLog, LogLevel, LogSource
from app.services.docker_service import get_docker_service

settings = get_settings()

SYSTEM_PROMPT = """あなたはコード生成AIです。ユーザーの指示に従い、動作するコードファイルを生成します。

## ファイルを作成・更新する際のルール

ファイルを出力するときは必ず以下の形式を使ってください：

=== FILE: ファイルのパス ===
ファイルの内容
=== END FILE ===

例：
=== FILE: index.html ===
<!DOCTYPE html>
<html>...</html>
=== END FILE ===

=== FILE: src/app.py ===
print("hello")
=== END FILE ===

## 注意事項
- 必ず動作する完全なコードを生成してください（省略しない）
- 複数のファイルが必要な場合はすべて出力してください
- ファイルパスにディレクトリが含まれる場合、自動的に作成されます
- 日本語でコメントや説明を書いてもかまいません
"""


class ClaudeCodeService:
    """Service for executing Claude Code in containers."""

    def __init__(self):
        """Initialize service."""
        self.docker_service = get_docker_service()

    async def execute_instruction(
        self,
        db: AsyncSession,
        task_id: int,
        instruction_content: str,
    ) -> AsyncGenerator[str, None]:
        """
        Execute instruction via Anthropic API and stream output.
        Generated files are written into the task's Docker container.
        """
        result = await db.execute(select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()

        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")
        if task.status not in [TaskStatus.IDLE, TaskStatus.RUNNING]:
            raise ValueError(f"Task is not ready (status: {task.status})")

        # Create instruction record
        instruction = Instruction(
            task_id=task_id,
            content=instruction_content,
            status=InstructionStatus.PENDING,
        )
        db.add(instruction)
        await db.commit()
        await db.refresh(instruction)

        output_buffer = []

        async def save_log(message: str):
            log = TaskLog(
                task_id=task_id,
                level=LogLevel.INFO,
                source=LogSource.CLAUDE,
                message=message,
                instruction_id=instruction.id,
            )
            db.add(log)
            await db.commit()

        try:
            task.status = TaskStatus.RUNNING
            instruction.status = InstructionStatus.RUNNING
            instruction.started_at = datetime.utcnow()
            await db.commit()

            yield f"[SYSTEM] 指示を受け付けました\n"
            yield f"[SYSTEM] {instruction_content}\n\n"

            # Get workspace context
            _, ls_output, _ = self.docker_service.execute_command(
                task.container_id,
                "find /workspace/repo -type f | grep -v '.git' | head -30 2>/dev/null || echo '(空のディレクトリ)'",
                "/workspace",
            )
            yield f"[SYSTEM] ワークスペース確認完了\n\n"

            # Call Anthropic API with streaming
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

            context_msg = f"作業ディレクトリ: /workspace/repo\n現在のファイル:\n{ls_output.strip()}\n\n指示: {instruction_content}"

            full_response = ""
            yield "[Claude] コードを生成しています...\n\n"

            async with client.messages.stream(
                model="claude-opus-4-6",
                max_tokens=8096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": context_msg}],
            ) as stream:
                async for text in stream.text_stream:
                    yield text
                    full_response += text
                    output_buffer.append(text)
                    if len(output_buffer) >= 50:
                        await save_log("".join(output_buffer))
                        output_buffer = []

            if output_buffer:
                await save_log("".join(output_buffer))
                output_buffer = []

            # Parse FILE blocks and write to container
            yield "\n\n[SYSTEM] ファイルをワークスペースに書き込んでいます...\n"
            files_written = await self._write_files_to_container(
                task.container_id, full_response
            )

            if files_written:
                yield f"[SYSTEM] {len(files_written)} 個のファイルを作成しました:\n"
                for f in files_written:
                    yield f"  ✓ {f}\n"
            else:
                yield "[SYSTEM] ファイルの書き込みはありませんでした\n"

            instruction.status = InstructionStatus.COMPLETED
            instruction.completed_at = datetime.utcnow()
            instruction.output = full_response
            instruction.exit_code = 0
            task.status = TaskStatus.IDLE
            await db.commit()

            yield "\n[SYSTEM] 完了しました\n"

        except Exception as e:
            error_msg = str(e)
            instruction.status = InstructionStatus.FAILED
            instruction.completed_at = datetime.utcnow()
            instruction.error_message = error_msg
            instruction.exit_code = 1
            task.status = TaskStatus.IDLE
            await db.commit()

            log = TaskLog(
                task_id=task_id,
                level=LogLevel.ERROR,
                source=LogSource.CLAUDE,
                message=f"Instruction failed: {error_msg}",
                instruction_id=instruction.id,
            )
            db.add(log)
            await db.commit()

            yield f"\n[ERROR] {error_msg}\n"

    async def _write_files_to_container(
        self, container_id: str, response_text: str
    ) -> list[str]:
        """Parse === FILE: ... === END FILE === blocks and write to container."""
        pattern = re.compile(
            r"=== FILE: (.+?) ===\n(.*?)=== END FILE ===", re.DOTALL
        )
        files_written = []

        for match in pattern.finditer(response_text):
            filepath = match.group(1).strip()
            content = match.group(2)

            # Remove leading newline if present
            if content.startswith("\n"):
                content = content[1:]

            # Create parent directory
            dir_path = os.path.dirname(filepath)
            if dir_path:
                self.docker_service.execute_command(
                    container_id,
                    f"mkdir -p /workspace/repo/{dir_path}",
                    "/workspace/repo",
                )

            # Write via base64 to avoid shell escaping issues
            b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
            write_cmd = (
                f"python3 -c \""
                f"import base64; "
                f"open('/workspace/repo/{filepath}', 'w', encoding='utf-8')"
                f".write(base64.b64decode('{b64}').decode('utf-8'))"
                f"\""
            )
            exit_code, _, _ = self.docker_service.execute_command(
                container_id, write_cmd, "/workspace/repo"
            )
            if exit_code == 0:
                files_written.append(filepath)

        return files_written


# Singleton instance
from typing import Optional as Opt
_claude_service: Opt[ClaudeCodeService] = None


def get_claude_service() -> ClaudeCodeService:
    """Get or create Claude Code service instance."""
    global _claude_service
    if _claude_service is None:
        _claude_service = ClaudeCodeService()
    return _claude_service
