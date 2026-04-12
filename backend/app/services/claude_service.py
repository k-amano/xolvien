"""Claude Code execution service."""
import os
import base64
import asyncio
import json
from typing import AsyncGenerator
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy import select as sa_select
from app.models.task import Task, TaskStatus
from app.models.instruction import Instruction, InstructionStatus
from app.models.test_run import TestRun, TestType
from app.models.task_log import TaskLog, LogLevel, LogSource
from app.services.docker_service import get_docker_service

# Python script for text-only generation (prompt generation)
_RUNNER_SCRIPT = """\
import subprocess, sys, os
prompt = open('/tmp/xolvien_prompt.txt', encoding='utf-8').read()
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
# Drops privileges to non-root xolvien user so --dangerously-skip-permissions is allowed
_RUNNER_SCRIPT_AGENT = """\
import subprocess, sys, os, shutil, pwd

prompt = open('/tmp/xolvien_prompt.txt', encoding='utf-8').read()

try:
    pw = pwd.getpwnam('xolvien')
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

    async def clarify_requirements(
        self,
        db: AsyncSession,
        task_id: int,
        instruction: str,
        history: list,
    ) -> AsyncGenerator[str, None]:
        """
        Conduct a clarification Q&A session before prompt generation.
        Claude either asks questions or outputs PROMPT_READY\\n{prompt}.
        Uses -p mode (text only) — file reading is deferred to generate_prompt.
        """
        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        # Lightweight context: file list + README only
        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' 2>/dev/null || echo '(空)'",
            "/workspace",
        )
        _, readme, _ = self.docker_service.execute_command(
            task.container_id,
            "cat /workspace/repo/README.md 2>/dev/null || cat /workspace/repo/README 2>/dev/null || echo '(READMEなし)'",
            "/workspace/repo",
        )

        # Build conversation history text
        history_text = ""
        if history:
            for msg in history:
                role_label = "Claude" if msg["role"] == "assistant" else "ユーザー"
                history_text += f"{role_label}: {msg['content']}\n\n"

        clarify_prompt = f"""あなたは要件ヒアリング担当です。ユーザーの指示を受け取り、最適なコードを生成するために必要な不明点を質問します。

## プロジェクト情報

ファイル一覧:
{file_list.strip()}

README:
{readme[:2000].strip()}

## ユーザーの指示

{instruction}
"""
        if history_text:
            clarify_prompt += f"""
## これまでの会話

{history_text.strip()}
"""

        clarify_prompt += """
## あなたの役割

以下のどちらかを行ってください：

**不明点がある場合：**
番号付きリストで1〜3個の具体的な質問を出力してください。
質問はユーザーの要件（機能・制約・期待する動作）に関するものにしてください。
コードの実装詳細ではなく、ユーザーが決めるべき仕様を聞いてください。

**十分な情報が揃った場合：**
最初の行に「PROMPT_READY」とだけ出力し、2行目以降にClaude Code CLIエージェントへ渡す最適なプロンプトを出力してください。

説明や前置きは不要です。質問か「PROMPT_READY」で始めてください。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", clarify_prompt)
        self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT)

        async for chunk in self.docker_service.execute_command_stream(
            task.container_id,
            "python3 /tmp/xolvien_runner.py",
            "/workspace/repo",
        ):
            yield chunk

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

        # Gather lightweight index context (file list, git log, README)
        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' 2>/dev/null || echo '(空)'",
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

        # Build meta-prompt — file contents are NOT pre-embedded;
        # the agent reads relevant files itself based on the instruction
        meta_prompt = f"""あなたはプロンプトエンジニアです。ユーザーの簡潔な指示を、Claude Code CLIエージェントに渡す最適なプロンプトに変換してください。

## ワークスペース情報

作業ディレクトリ: /workspace/repo

ファイル一覧:
{file_list.strip()}

直近のgit履歴:
{git_log.strip()}

README:
{readme[:3000].strip()}

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
## 手順

1. まず上記のファイル一覧から、ユーザーの指示に関係するファイルを特定してください
2. 該当ファイルを読み込み、現在の実装を正確に把握してください
3. その上で、Claude Code CLIエージェントへ渡す最適なプロンプトを生成してください

## 出力ルール

生成するプロンプトには以下を含めてください：
- 対象ファイルの正確なパス（読み込んだ内容に基づく）
- 現状の実装を踏まえた具体的な変更内容
- 必要であれば動作確認の観点

注意: 実行エージェントはファイルの読み書きやコマンド実行を自動で行います。出力形式の指定は不要です。

プロンプト本文のみを出力してください。説明や前置きは不要です。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", meta_prompt)
        self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT_AGENT)

        async for chunk in self.docker_service.execute_command_stream(
            task.container_id,
            "python3 /tmp/xolvien_runner.py",
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
            self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", instruction_content)
            self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT_AGENT)

            yield "[Claude] Claude Code CLIを実行しています...\n\n"

            full_response = ""
            async for chunk in self.docker_service.execute_command_stream(
                task.container_id,
                "python3 /tmp/xolvien_runner.py",
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

            # Auto-commit changes
            yield "\n[GIT] 変更をコミットしています...\n"
            commit_msg = instruction_content.replace("\n", " ")[:72]
            # Write commit message to temp file to avoid shell escaping issues
            self._write_text_to_container(
                task.container_id, "/tmp/xolvien_commit_msg.txt", commit_msg
            )
            commit_cmd = (
                "git add -A && "
                "git diff --cached --quiet && echo '[GIT] 変更なし（コミットスキップ）' || "
                "git commit -F /tmp/xolvien_commit_msg.txt"
            )
            _, commit_out, _ = self.docker_service.execute_command(
                task.container_id, commit_cmd, "/workspace/repo"
            )
            if commit_out.strip():
                yield f"{commit_out.strip()}\n"
                log = TaskLog(
                    task_id=task_id,
                    level=LogLevel.INFO,
                    source=LogSource.GIT,
                    message=commit_out.strip(),
                    instruction_id=instruction.id,
                )
                db.add(log)

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


    async def generate_test_cases(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
    ) -> AsyncGenerator[str, None]:
        """
        Generate test case list (not code) for a given implementation prompt.
        Streams Markdown text listing test cases (normal / error / edge cases).
        """
        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' | grep -v '__pycache__' | grep -v 'node_modules' 2>/dev/null || echo '(空)'",
            "/workspace",
        )

        prompt = f"""あなたはテスト設計の専門家です。以下の実装プロンプトに基づいて、単体テストのテストケース一覧を生成してください。

## 実装予定の内容
{implementation_prompt}

## プロジェクトのファイル一覧
{file_list.strip()}

## 出力形式
以下のMarkdown形式でテストケース一覧を出力してください。テストコードは生成しないでください。

```
## テストケース一覧

### 正常系
- [ ] テストケース名: 説明

### 異常系
- [ ] テストケース名: 説明

### 境界値
- [ ] テストケース名: 説明（該当する場合のみ）
```

テストケースの粒度は「機能単位」とし、正常系・異常系・境界値を網羅してください。
テストコードや実装の詳細は含めず、テストケース名と説明のみを出力してください。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", prompt)
        self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT)

        async for chunk in self.docker_service.execute_command_stream(
            task.container_id,
            "python3 /tmp/xolvien_runner.py",
            "/workspace/repo",
        ):
            yield chunk

    async def run_unit_tests(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        test_cases: str,
    ) -> AsyncGenerator[str, None]:
        """
        Generate test code from approved test cases, run tests, auto-fix up to 3 times.
        Streams progress logs. Saves TestRun record on completion.
        """
        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        # Determine test command from project structure
        _, pkg_json, _ = self.docker_service.execute_command(
            task.container_id,
            "cat /workspace/repo/package.json 2>/dev/null || echo ''",
            "/workspace/repo",
        )
        _, pyproject, _ = self.docker_service.execute_command(
            task.container_id,
            "cat /workspace/repo/pyproject.toml 2>/dev/null || echo ''",
            "/workspace/repo",
        )
        _, requirements, _ = self.docker_service.execute_command(
            task.container_id,
            "ls /workspace/repo/requirements*.txt 2>/dev/null || echo ''",
            "/workspace/repo",
        )

        if 'pytest' in pyproject or requirements.strip():
            test_command = "python -m pytest -v 2>&1"
        elif pkg_json.strip():
            test_command = "npm test -- --watchAll=false 2>&1"
        else:
            test_command = "python -m pytest -v 2>&1"

        # Create TestRun record
        test_run = TestRun(
            task_id=task_id,
            test_type=TestType.UNIT,
            test_command=test_command,
            test_cases=test_cases,
            started_at=datetime.utcnow(),
        )
        db.add(test_run)
        await db.commit()
        await db.refresh(test_run)

        task.status = TaskStatus.TESTING
        await db.commit()

        yield f"[TEST] テストコードを生成しています...\n"

        # Step 1: Generate test code
        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' | grep -v '__pycache__' | grep -v 'node_modules' 2>/dev/null",
            "/workspace",
        )

        gen_prompt = f"""あなたはテストコード生成の専門家です。以下の実装プロンプトとテストケース一覧に基づいて、テストコードを生成してください。

## 実装予定の内容
{implementation_prompt}

## 承認済みテストケース一覧
{test_cases}

## プロジェクトのファイル一覧
{file_list.strip()}

## 指示
1. プロジェクトの構成（package.json, pyproject.toml等）から使用するテストフレームワークを判断してください
2. 既存のテストファイルがあれば確認して、命名規則や構造に従ってください
3. 承認済みテストケース一覧の全ケースをカバーするテストコードを生成してください
4. テストファイルを /workspace/repo の適切な場所に書き込んでください
5. 実装コードがまだ存在しない場合は、テストが失敗することを前提にして書いてください（TDDアプローチ）

テストコードの生成と書き込みのみを行ってください。実装コードの変更は不要です。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", gen_prompt)
        self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT_AGENT)

        async for chunk in self.docker_service.execute_command_stream(
            task.container_id,
            "python3 /tmp/xolvien_runner.py",
            "/workspace/repo",
        ):
            yield chunk

        yield f"\n[TEST] テストを実行しています: {test_command}\n"

        max_retries = 3
        passed = False
        last_output = ""
        last_error = ""

        for attempt in range(max_retries + 1):
            if attempt > 0:
                yield f"\n[TEST] 自動修正 ({attempt}/{max_retries})...\n"

                # Auto-fix: give Claude the failure output
                fix_prompt = f"""テストが失敗しました。テストコードまたは実装コードを修正してください。

## 実装プロンプト
{implementation_prompt}

## テストケース一覧
{test_cases}

## テストコマンド
{test_command}

## テスト失敗の出力
{last_output[-3000:] if len(last_output) > 3000 else last_output}

## エラー出力
{last_error[-1000:] if len(last_error) > 1000 else last_error}

## 指示
上記の失敗を修正してください。テストコードか実装コードのどちらに問題があるか判断し、修正してください。
全テストケースがパスするまで修正を続けてください。
"""
                self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", fix_prompt)
                self._write_text_to_container(task.container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT_AGENT)

                async for chunk in self.docker_service.execute_command_stream(
                    task.container_id,
                    "python3 /tmp/xolvien_runner.py",
                    "/workspace/repo",
                ):
                    yield chunk

                yield f"\n[TEST] 修正後にテストを再実行しています...\n"

            exit_code, output, error = self.docker_service.execute_command(
                task.container_id,
                test_command,
                "/workspace/repo",
            )
            last_output = output
            last_error = error

            if output.strip():
                yield output
            if error.strip():
                yield f"[STDERR] {error}\n"

            passed = exit_code == 0
            test_run.retry_count = attempt
            test_run.exit_code = exit_code
            test_run.passed = passed
            test_run.output = output
            test_run.error_output = error

            if passed:
                yield f"\n[TEST] テストがパスしました\n"
                break
            else:
                if attempt < max_retries:
                    yield f"\n[TEST] テストが失敗しました (試行 {attempt + 1}/{max_retries + 1})\n"
                else:
                    yield f"\n[TEST] 最大リトライ回数 ({max_retries}) に達しました。手動対応が必要です。\n"

        # Save test report as Markdown
        now_str = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        report_filename = f"test-report-{now_str}-unit.md"
        report_path = f"/workspace/repo/test-reports/{report_filename}"

        report_content = f"""# テストレポート

- 実行日時: {datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")} UTC
- テスト種別: 単体テスト
- テストコマンド: {test_command}
- 結果: {"✅ PASS" if passed else "❌ FAIL"}
- リトライ回数: {test_run.retry_count}

## テストケース一覧
{test_cases}

## テスト実行ログ
```
{last_output[-5000:] if len(last_output) > 5000 else last_output}
```
"""

        self.docker_service.execute_command(
            task.container_id,
            f"mkdir -p /workspace/repo/test-reports",
            "/workspace/repo",
        )
        self._write_text_to_container(task.container_id, report_path, report_content)

        # Commit test code and report
        commit_msg = f"test: add unit tests ({'pass' if passed else 'fail'})"
        self._write_text_to_container(task.container_id, "/tmp/xolvien_commit_msg.txt", commit_msg)
        _, commit_out, _ = self.docker_service.execute_command(
            task.container_id,
            "git add -A && git diff --cached --quiet && echo '[GIT] 変更なし' || git commit -F /tmp/xolvien_commit_msg.txt",
            "/workspace/repo",
        )
        if commit_out.strip():
            yield f"[GIT] {commit_out.strip()}\n"

        # Finalize TestRun record
        from app.services.test_service import get_test_service
        test_service = get_test_service()
        summary = test_service._parse_test_summary(last_output, test_command)
        test_run.summary = summary
        test_run.report_path = report_path
        test_run.completed_at = datetime.utcnow()
        await db.commit()

        task.status = TaskStatus.IDLE
        await db.commit()

        yield f"\n[TEST] レポートを保存しました: {report_path}\n"
        yield f"\n[SYSTEM] テスト完了: {summary}\n"


# Singleton instance
from typing import Optional as Opt
_claude_service: Opt[ClaudeCodeService] = None


def get_claude_service() -> ClaudeCodeService:
    """Get or create Claude Code service instance."""
    global _claude_service
    if _claude_service is None:
        _claude_service = ClaudeCodeService()
    return _claude_service
