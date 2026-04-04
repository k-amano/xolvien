"""Claude Code execution service."""
import os
import re
import base64
import asyncio
from typing import AsyncGenerator
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from sqlalchemy import select as sa_select
from app.models.task import Task, TaskStatus
from app.models.instruction import Instruction, InstructionStatus
from app.models.task_log import TaskLog, LogLevel, LogSource
from app.services.docker_service import get_docker_service

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

# Python script written into the container to invoke Claude Code CLI and stream output
_RUNNER_SCRIPT = """\
import subprocess, sys, os
prompt = open('/tmp/karakuri_prompt.txt', encoding='utf-8').read()
env = {**os.environ, 'HOME': '/root'}
proc = subprocess.Popen(
    ['claude', '-p', prompt, '--output-format', 'text'],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    env=env,
)
for chunk in iter(lambda: proc.stdout.read(512), b''):
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
proc.wait()
sys.exit(proc.returncode)
"""


class ClaudeCodeService:
    """Service for executing Claude Code CLI in containers."""

    def __init__(self):
        """Initialize service."""
        self.docker_service = get_docker_service()

    def _write_text_to_container(self, container_id: str, path: str, text: str) -> None:
        """Write arbitrary text to a file inside the container via base64."""
        b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        cmd = (
            f"python3 -c \""
            f"import base64; "
            f"open('{path}', 'w', encoding='utf-8')"
            f".write(base64.b64decode('{b64}').decode('utf-8'))"
            f"\""
        )
        self.docker_service.execute_command(container_id, cmd, "/workspace")

    async def generate_prompt(
        self,
        db: AsyncSession,
        task_id: int,
        instruction_content: str,
        feedback: str = "",
    ) -> AsyncGenerator[str, None]:
        """
        Generate an optimized prompt from a brief user instruction.
        Streams the generated prompt text.
        """
        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        # Gather workspace context
        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' | head -50 2>/dev/null || echo '(空)'",
            "/workspace",
        )
        _, git_log, _ = self.docker_service.execute_command(
            task.container_id,
            "git log --oneline -10 2>/dev/null || echo '(履歴なし)'",
            "/workspace/repo",
        )
        _, readme, _ = self.docker_service.execute_command(
            task.container_id,
            "cat /workspace/repo/README.md 2>/dev/null || cat /workspace/repo/README 2>/dev/null || echo '(READMEなし)'",
            "/workspace/repo",
        )

        # Get past instructions for this task
        past_result = await db.execute(
            sa_select(Instruction)
            .where(Instruction.task_id == task_id)
            .where(Instruction.status == InstructionStatus.COMPLETED)
            .order_by(Instruction.created_at.asc())
            .limit(5)
        )
        past_instructions = past_result.scalars().all()
        past_text = "\n".join(f"- {i.content}" for i in past_instructions) or "(なし)"

        # Build meta-prompt for prompt generation
        meta_prompt = f"""あなたはプロンプトエンジニアです。ユーザーの簡潔な指示を、Claude Code CLIに渡す最適なプロンプトに変換してください。

## ワークスペース情報

ファイル一覧:
{file_list.strip()}

直近のgit履歴:
{git_log.strip()}

README:
{readme[:2000].strip()}

このタスクの過去の指示履歴:
{past_text}

## ユーザーの指示

{instruction_content}
"""
        if feedback:
            meta_prompt += f"""
## 前回生成したプロンプトへの指摘

{feedback}
"""
        meta_prompt += """
## 出力ルール

上記の情報をもとに、Claude Code CLIへ渡す最適なプロンプトを出力してください。
プロンプトには以下を含めてください：
- 対象ファイルのパスを具体的に指定する（ワークスペース情報から推測する）
- 実装すべき内容を詳細に記述する
- ファイルを作成・更新する場合は必ず以下の形式で出力するよう指示する：
  === FILE: ファイルのパス ===
  ファイルの内容
  === END FILE ===
- 必要であれば動作確認の観点も含める

プロンプト本文のみを出力してください。説明や前置きは不要です。
"""

        self._write_text_to_container(task.container_id, "/tmp/karakuri_prompt.txt", meta_prompt)
        self._write_text_to_container(task.container_id, "/tmp/karakuri_runner.py", _RUNNER_SCRIPT)

        async for chunk in self.docker_service.execute_command_stream(
            task.container_id,
            "python3 /tmp/karakuri_runner.py",
            "/workspace/repo",
        ):
            yield chunk

    async def execute_instruction(
        self,
        db: AsyncSession,
        task_id: int,
        instruction_content: str,
    ) -> AsyncGenerator[str, None]:
        """
        Execute instruction via Claude Code CLI inside the task container and stream output.
        Generated files (=== FILE: ... === blocks) are written into /workspace/repo.
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

            # Get workspace file listing for context
            _, ls_output, _ = self.docker_service.execute_command(
                task.container_id,
                "find /workspace/repo -type f | grep -v '.git' | head -30 2>/dev/null || echo '(空のディレクトリ)'",
                "/workspace",
            )
            yield "[SYSTEM] ワークスペース確認完了\n\n"

            # Build full prompt
            full_prompt = (
                SYSTEM_PROMPT
                + f"\n\n作業ディレクトリ: /workspace/repo\n現在のファイル:\n{ls_output.strip()}"
                + f"\n\nユーザーの指示: {instruction_content}"
            )

            # Write prompt and runner script into the container
            self._write_text_to_container(task.container_id, "/tmp/karakuri_prompt.txt", full_prompt)
            self._write_text_to_container(task.container_id, "/tmp/karakuri_runner.py", _RUNNER_SCRIPT)

            yield "[Claude] Claude Code CLIを実行しています...\n\n"

            full_response = ""
            async for chunk in self.docker_service.execute_command_stream(
                task.container_id,
                "python3 /tmp/karakuri_runner.py",
                "/workspace/repo",
            ):
                yield chunk
                full_response += chunk
                output_buffer.append(chunk)
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
