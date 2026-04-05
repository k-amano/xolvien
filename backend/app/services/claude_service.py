"""Claude Code execution service."""
import os
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

# Python script for text-only generation (prompt generation)
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

# Python script for agent mode execution (file read/write/bash tools enabled)
# Drops privileges to non-root karakuri user so --dangerously-skip-permissions is allowed
_RUNNER_SCRIPT_AGENT = """\
import subprocess, sys, os, shutil, pwd

prompt = open('/tmp/karakuri_prompt.txt', encoding='utf-8').read()

try:
    pw = pwd.getpwnam('karakuri')
    uid, gid, home = pw.pw_uid, pw.pw_gid, pw.pw_dir
except KeyError:
    uid = gid = None
    home = '/root'

if uid is not None:
    for d in ['.claude', '.ssh']:
        src, dst = f'/root/{d}', f'{home}/{d}'
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copytree(src, dst, symlinks=True)
            for dirpath, dirs, files in os.walk(dst):
                os.chown(dirpath, uid, gid)
                for f in files:
                    try:
                        os.chown(os.path.join(dirpath, f), uid, gid)
                    except Exception:
                        pass

    def drop_privs():
        os.setgid(gid)
        os.setuid(uid)

    cmd = ['claude', '--dangerously-skip-permissions', '-p', prompt]
    env = {**os.environ, 'HOME': home}
    preexec = drop_privs
else:
    cmd = ['claude', '-p', prompt, '--output-format', 'text']
    env = {**os.environ, 'HOME': '/root'}
    preexec = None

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    env=env,
    cwd='/workspace/repo',
    preexec_fn=preexec,
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

        # Read source file contents (exclude binary/lock files, limit total size)
        _, source_files_raw, _ = self.docker_service.execute_command(
            task.container_id,
            (
                "find /workspace/repo -type f "
                r"| grep -v '.git' "
                r"| grep -v -E '\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz|lock|min\.js|min\.css)$' "
                "| head -30"
            ),
            "/workspace",
        )
        file_contents_section = ""
        total_chars = 0
        for fpath in source_files_raw.strip().splitlines():
            fpath = fpath.strip()
            if not fpath:
                continue
            _, content, _ = self.docker_service.execute_command(
                task.container_id,
                f"cat {fpath} 2>/dev/null",
                "/workspace",
            )
            if total_chars + len(content) > 12000:
                file_contents_section += f"\n--- {fpath} (省略: 文字数制限)\n"
                break
            file_contents_section += f"\n--- {fpath}\n{content}\n"
            total_chars += len(content)

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

ソースファイルの内容:
{file_contents_section.strip() or "(ファイルなし)"}

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

上記の情報をもとに、Claude Code CLIエージェントへ渡す最適なプロンプトを出力してください。
プロンプトには以下を含めてください：
- 対象ファイルのパスを具体的に指定する（ソースファイルの内容から正確に把握する）
- 実装すべき内容を詳細に記述する
- 必要であれば動作確認の観点も含める

注意: Claude Code CLIはエージェントモードで実行されるため、ファイルの読み書きやコマンド実行は自動で行われます。
出力形式の指定は不要です。

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
        Execute instruction via Claude Code CLI agent mode inside the task container.
        Claude has full tool access (file read/write/bash) via --dangerously-skip-permissions.
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

            # Write prompt and agent runner script into the container
            self._write_text_to_container(task.container_id, "/tmp/karakuri_prompt.txt", instruction_content)
            self._write_text_to_container(task.container_id, "/tmp/karakuri_runner.py", _RUNNER_SCRIPT_AGENT)

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



# Singleton instance
from typing import Optional as Opt
_claude_service: Opt[ClaudeCodeService] = None


def get_claude_service() -> ClaudeCodeService:
    """Get or create Claude Code service instance."""
    global _claude_service
    if _claude_service is None:
        _claude_service = ClaudeCodeService()
    return _claude_service
