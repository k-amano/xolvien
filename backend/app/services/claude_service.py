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
from app.models.test_case_item import TestCaseItem
from app.models.test_case_result import TestCaseResult, Verdict
from app.services.docker_service import get_docker_service
from app.services import document_converter
from app.services.document_service import schedule_generation
from app.errors import ErrorCode, XolvienError, classify_text

# Single container-side identity for everything that touches /workspace/repo
# or runs project tooling (tests, npm, pip, git). Claude agent mode already
# runs as this user (drop_privs), so detection/execution MUST use it too:
# running them as root once caused "No test framework found" because pytest
# was pip-install --user'd into /home/xolvien/.local, invisible to root.
AGENT_USER = "xolvien"

# Git identity applied inline on app-side commits (git config of the root
# entrypoint does not apply to the xolvien user's HOME).
_GIT_ID = "-c user.name='Xolvien Bot' -c user.email='bot@xolvien.com'"

# Unified RAW stream-json runner for ALL streamed Claude flows (clarify, prompt
# generation, test code-gen, test auto-fix, execute).
#
# Design (see spec): the LEFT pane is a console.log-equivalent raw view. This
# runner streams Claude Code CLI's stream-json output lines THROUGH UNMODIFIED —
# no [Thinking]/[Tool:]/[Result] reformatting, no dummy keepalive text. The
# frontend renders raw lines on the left and reconstructs assistant text for the
# right pane by concatenating text_delta events.
#
# Per-flow auth/permission differences are read from a flags file written next to
# the prompt: /tmp/xolvien_runner_flags.json -> {"skip_permissions", "drop_privs"}
#   - clarify: drop_privs=False (run as root, HOME=xolvien for credentials),
#     skip_permissions=False (read-only, no tools).
#   - prompt/execute/test: drop_privs=True + skip_permissions=True (full tools).
#
# Silence handling: a JSON-shaped keepalive line {"type":"_xolvien_keepalive"} is
# emitted every 15s so the stream never goes silent long enough to trip the
# server-side chunk_timeout. It is valid JSON the frontend/back parsers ignore.
#
# Loop-detection: aborts after 5 consecutive identical tool_result texts (e.g. a
# permission error repeating). The ORIGINAL raw line is still streamed.
_RUNNER_SCRIPT_STREAM = """\
import subprocess, sys, os, shutil, pwd, json, threading, time

prompt = open('/tmp/xolvien_prompt.txt', encoding='utf-8').read()
try:
    flags = json.load(open('/tmp/xolvien_runner_flags.json'))
except Exception:
    flags = {}
skip_permissions = bool(flags.get('skip_permissions', False))
drop_privs_flag = bool(flags.get('drop_privs', False))
add_dirs = flags.get('add_dirs') or []

try:
    pw = pwd.getpwnam('xolvien')
    uid, gid, home = pw.pw_uid, pw.pw_gid, pw.pw_dir
except KeyError:
    uid = gid = None
    home = '/root'

# When dropping privileges, make the ssh keys readable by the xolvien user.
if uid is not None and drop_privs_flag:
    src, dst = '/root/.ssh', f'{home}/.ssh'
    if os.path.exists(src) and not os.path.exists(dst):
        shutil.copytree(src, dst, symlinks=True)
        for dirpath, dirs, files in os.walk(dst):
            os.chown(dirpath, uid, gid)
            for f in files:
                try:
                    os.chown(os.path.join(dirpath, f), uid, gid)
                except Exception:
                    pass

cmd = ['claude']
if skip_permissions:
    cmd.append('--dangerously-skip-permissions')
# Grant READ access to extra directories (e.g. /workspace/uploads for the
# clarify flow) without enabling full tool permissions.
for d in add_dirs:
    cmd += ['--add-dir', d]
cmd += ['-p', prompt, '--output-format', 'stream-json',
        '--include-partial-messages', '--verbose']

# HOME points at the xolvien home (where the credentials file lives) whether we
# run as root or drop to the xolvien user.
env = {**os.environ, 'HOME': home if uid is not None else '/root'}

preexec = None
if uid is not None and drop_privs_flag:
    def drop_privs():
        os.setgroups([gid])
        os.setgid(gid)
        os.setuid(uid)
    preexec = drop_privs

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    env=env,
    cwd='/workspace/repo',
    preexec_fn=preexec,
)

_write_lock = threading.Lock()

def emit_raw(b):
    with _write_lock:
        sys.stdout.buffer.write(b)
        if not b.endswith(b'\\n'):
            sys.stdout.buffer.write(b'\\n')
        sys.stdout.buffer.flush()

# Echo the full prompt sent to Claude as the first line, so the left pane (a
# console.log-equivalent) shows the INPUT as well as the output.
emit_raw(json.dumps({'type': '_xolvien_input', 'prompt': prompt}).encode('utf-8'))

# JSON keepalive so the stream never goes silent (e.g. during a long tool call).
def _keepalive():
    while proc.poll() is None:
        time.sleep(15)
        if proc.poll() is None:
            emit_raw(b'{"type":"_xolvien_keepalive"}')
threading.Thread(target=_keepalive, daemon=True).start()

# Loop-detection: abort after 5 consecutive identical tool_result texts.
_last_result = None
_repeat_count = 0
_MAX_REPEATS = 5

buf = b''
_aborted = False
for chunk in iter(lambda: proc.stdout.read(256), b''):
    if _aborted:
        break
    buf += chunk
    while b'\\n' in buf:
        raw_line, buf = buf.split(b'\\n', 1)
        if not raw_line.strip():
            continue
        # Stream the line through UNMODIFIED (raw view).
        emit_raw(raw_line)
        # Parse only to drive loop-detection; do not alter the output.
        try:
            obj = json.loads(raw_line.decode('utf-8', errors='replace'))
        except Exception:
            continue
        if obj.get('type') == 'user':
            for item in obj.get('message', {}).get('content', []):
                if item.get('type') == 'tool_result':
                    content = item.get('content', '')
                    result_text = ''
                    if isinstance(content, str):
                        result_text = content.strip()[:300]
                    elif isinstance(content, list):
                        for c in content:
                            if c.get('type') == 'text' and c.get('text', '').strip():
                                result_text = c['text'].strip()[:300]
                                break
                    if result_text:
                        if result_text == _last_result:
                            _repeat_count += 1
                        else:
                            _last_result = result_text
                            _repeat_count = 1
                        if _repeat_count >= _MAX_REPEATS:
                            emit_raw(b'{"type":"_xolvien_error","message":"Identical error repeated 5 times - aborting to prevent infinite loop."}')
                            proc.kill()
                            _aborted = True
                            break

if buf.strip():
    emit_raw(buf)
proc.wait()
sys.exit(1 if _aborted else proc.returncode)
"""

# Python script for batch test case generation using --output-format json + --resume
# Reads prompt from /tmp/xolvien_prompt.txt, optional session from /tmp/xolvien_session.txt
# Writes session_id to /tmp/xolvien_session.txt after first call
# Prints result text to stdout
_RUNNER_SCRIPT_TC_BATCH = """\
import subprocess, sys, os, shutil, pwd, json

prompt = open('/tmp/xolvien_prompt.txt', encoding='utf-8').read()
session_file = '/tmp/xolvien_session.txt'

try:
    pw = pwd.getpwnam('xolvien')
    uid, gid, home = pw.pw_uid, pw.pw_gid, pw.pw_dir
except KeyError:
    uid = gid = None
    home = '/root'

if uid is not None:
    src, dst = '/root/.ssh', f'{home}/.ssh'
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
        os.setgroups([gid])
        os.setgid(gid)
        os.setuid(uid)

    env = {**os.environ, 'HOME': home}
    preexec = drop_privs
else:
    env = {**os.environ, 'HOME': '/root'}
    preexec = None

cmd = ['claude', '--dangerously-skip-permissions', '-p', prompt, '--output-format', 'json']

session_id = None
if os.path.exists(session_file):
    session_id = open(session_file).read().strip()
    if session_id:
        cmd += ['--resume', session_id]

proc = subprocess.run(cmd, capture_output=True, env=env, cwd='/workspace/repo', preexec_fn=preexec)
raw = proc.stdout.decode('utf-8', errors='replace')

# Parse session_id and result from JSON output
# Output is one or more JSON objects concatenated
result_text = ''
for segment in raw.replace('}{', '}\\n{').split('\\n'):
    segment = segment.strip()
    if not segment.startswith('{'):
        continue
    try:
        obj = json.loads(segment)
        if obj.get('type') == 'system' and 'session_id' in obj:
            session_id = obj['session_id']
        elif obj.get('type') == 'result':
            result_text = obj.get('result', '')
    except Exception:
        pass

# Save session_id for next batch
if session_id:
    open(session_file, 'w').write(session_id)

sys.stdout.write(result_text)
sys.stdout.flush()
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

    def _normalize_repo_ownership(self, container_id: str) -> None:
        """
        chown any file under /workspace/repo not owned by AGENT_USER (runs as
        root; touches only mismatched files, so it is cheap when there is
        nothing to fix). Keeps the whole repo usable by the single agent user.
        """
        self.docker_service.execute_command(
            container_id,
            f"find /workspace/repo \\! -user {AGENT_USER} "
            f"-exec chown {AGENT_USER}:{AGENT_USER} {{}} + 2>/dev/null || true",
            "/workspace",
        )

    def _write_runner(
        self,
        container_id: str,
        *,
        skip_permissions: bool,
        drop_privs: bool,
        add_dirs: list[str] | None = None,
    ) -> None:
        """
        Install the unified raw stream-json runner plus its auth flags file.

        skip_permissions / drop_privs select the per-flow Claude invocation:
          clarify        -> skip_permissions=False, drop_privs=False (root, no tools)
          prompt/execute/test -> skip_permissions=True, drop_privs=True (full tools)
        add_dirs grants READ access to extra directories (clarify uses it for
        /workspace/uploads so reference files are readable without full perms).
        """
        # Re-copy the host's current Claude credentials on EVERY run: OAuth
        # tokens rotate, and the snapshot taken at container creation goes
        # stale in long-lived containers (401 "token has been revoked").
        self.docker_service.refresh_claude_credentials(container_id)
        # Heal any root-owned files inside the repo (from older app versions
        # or stray root operations) so every AGENT_USER operation — Claude
        # itself, tests, git — never hits a permission mismatch.
        self._normalize_repo_ownership(container_id)
        self._write_text_to_container(
            container_id, "/tmp/xolvien_runner_flags.json",
            json.dumps({
                "skip_permissions": skip_permissions,
                "drop_privs": drop_privs,
                "add_dirs": add_dirs or [],
            }),
        )
        self._write_text_to_container(container_id, "/tmp/xolvien_runner.py", _RUNNER_SCRIPT_STREAM)

    async def _stream_runner_checked(
        self,
        container_id: str,
        workdir: str = "/workspace/repo",
        chunk_timeout: float = 120.0,
        text_sink: list[str] | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Run the raw stream-json runner and PROVE that it succeeded.

        Chunks stream through unmodified (the left pane is a raw view) while
        complete JSON lines are inspected on the side. Success requires a
        terminal ``result`` line with ``is_error: false`` — the CLI emits one
        for every completed run. Every other ending raises XolvienError so the
        streaming endpoint appends the ``[[XOLVIEN_ERROR:CODE]]`` sentinel and
        the UI shows a prominent error banner:

        - ``result`` with ``is_error: true`` (e.g. revoked OAuth token — the
          CLI then produces NO text_delta events at all, so without this check
          the run would end silently with a blank right pane)
        - the runner's own ``_xolvien_error`` loop-abort
        - the stream ending with no ``result`` line (CLI crash/startup failure)

        When ``text_sink`` is given, every text_delta fragment is appended to
        it so the caller can inspect the reconstructed assistant text (e.g.
        the clarify flow's proof-of-read marker check).
        """
        line_carry = ""
        saw_result = False
        result_is_error = False
        result_text = ""
        runner_error = ""
        tail = ""  # recent raw output, used as detail when no result line arrives

        def inspect(line: str) -> None:
            nonlocal saw_result, result_is_error, result_text, runner_error
            s = line.strip()
            if not s:
                return
            try:
                obj = json.loads(s)
            except Exception:
                return
            if not isinstance(obj, dict):
                return
            if obj.get("type") == "result":
                saw_result = True
                result_is_error = bool(obj.get("is_error"))
                result_text = str(obj.get("result") or obj.get("error") or "")
            elif obj.get("type") == "_xolvien_error":
                runner_error = str(obj.get("message") or "runner aborted")
            elif obj.get("type") == "stream_event" and text_sink is not None:
                ev = obj.get("event") or {}
                if ev.get("type") == "content_block_delta":
                    delta = ev.get("delta") or {}
                    if delta.get("type") == "text_delta":
                        text_sink.append(str(delta.get("text", "")))

        async for chunk in self.docker_service.execute_command_stream(
            container_id,
            "python3 /tmp/xolvien_runner.py",
            workdir,
            chunk_timeout=chunk_timeout,
        ):
            yield chunk
            tail = (tail + chunk)[-2000:]
            combined = line_carry + chunk
            parts = combined.split("\n")
            line_carry = parts.pop()
            for line in parts:
                inspect(line)
        inspect(line_carry)

        if runner_error:
            code = classify_text(runner_error)
            raise XolvienError(
                code if code != ErrorCode.UNKNOWN else ErrorCode.CLAUDE_CLI_ERROR,
                runner_error,
            )
        if saw_result and result_is_error:
            detail = result_text or "Claude CLI reported an error result"
            code = classify_text(detail)
            raise XolvienError(
                code if code != ErrorCode.UNKNOWN else ErrorCode.CLAUDE_API_ERROR,
                detail,
            )
        if not saw_result:
            raise XolvienError(
                ErrorCode.CLAUDE_CLI_ERROR,
                "Claude CLI ended without a result line (crash or startup "
                f"failure). Last output: {tail[-500:]}",
            )

    async def _prepare_uploads(
        self,
        db: AsyncSession,
        task: Task,
        lang: str = "ja",
        upload_ids: list[int] | None = None,
    ) -> str:
        """
        Copy the task's repository uploads into the container and return a prompt
        fragment listing them. Returns "" when there are no uploads to prepare.

        upload_ids selects WHICH uploads this message references:
          None -> all repository uploads (backward compatible)
          []   -> none (user deselected everything)
          ids  -> only those uploads; a missing id is an ERROR, not a silent
                  skip — the user explicitly asked for that file.

        Likewise, when there are uploads to prepare but none could be placed
        into the container, this raises instead of silently returning "" —
        a run must never quietly proceed without its reference files.

        Uploads are repository-scoped, so they are available to every fix-task of
        the project and re-copied on each call (surviving Reset & Rebuild).
        """
        from app.models.upload import Upload  # local import avoids a cycle
        from app.config import get_settings

        if upload_ids is not None and not upload_ids:
            return ""

        query = select(Upload).where(Upload.repository_id == task.repository_id)
        if upload_ids is not None:
            query = query.where(Upload.id.in_(upload_ids))
        result = await db.execute(query.order_by(Upload.created_at))
        uploads = result.scalars().all()

        if upload_ids is not None:
            missing = set(upload_ids) - {u.id for u in uploads}
            if missing:
                raise XolvienError(
                    ErrorCode.UPLOAD_NOT_AVAILABLE,
                    f"selected upload id(s) not found in repository: {sorted(missing)}",
                )
        if not uploads:
            return ""

        host_dir = os.path.join(get_settings().upload_data_path, "repos", str(task.repository_id))

        # Claude Code CLI cannot read binary files, so make sure every
        # convertible binary (xlsx/docx/pdf) has an up-to-date Markdown sibling
        # on the host before copying. Normally created at upload time; this
        # lazily covers pre-existing uploads and earlier failures.
        for u in uploads:
            if u.stored_path:
                await asyncio.to_thread(document_converter.ensure_converted, u.stored_path)

        try:
            copied = self.docker_service.copy_uploads_to_container(
                task.container_id, host_dir, "/workspace/uploads"
            )
        except Exception as e:
            raise XolvienError(
                ErrorCode.UPLOAD_NOT_AVAILABLE,
                f"failed to copy reference files into the container: {e}",
            )
        if not copied:
            raise XolvienError(
                ErrorCode.UPLOAD_NOT_AVAILABLE,
                "no reference files could be placed into the container",
            )

        # Map stored filenames (id_originalname) back to original display names.
        by_stored = {f"{u.id}_{os.path.basename(u.filename)}": u.filename for u in uploads}
        copied_set = set(copied)
        suffix = document_converter.CONVERTED_SUFFIX
        lines = []
        for name in copied:
            # Conversions are listed with their original below, not standalone.
            if name.endswith(suffix) and name[: -len(suffix)] in copied_set:
                continue
            display = by_stored.get(name, name)
            converted = name + suffix
            if converted in copied_set:
                # Point Claude at the readable conversion, not the binary.
                if lang == "en":
                    lines.append(
                        f"- /workspace/uploads/{converted}  "
                        f"({display} converted to Markdown — read THIS file; "
                        f"the binary original cannot be read)"
                    )
                else:
                    lines.append(
                        f"- /workspace/uploads/{converted}  "
                        f"（{display} をMarkdownに変換したもの。バイナリの原本は"
                        f"読めないため、必ずこのファイルを読むこと）"
                    )
            else:
                lines.append(f"- /workspace/uploads/{name}  ({display})")
        listing = "\n".join(lines)

        if lang == "en":
            return (
                "\n## Uploaded Reference Files\n\n"
                "The user attached the following files. Read them (they may be specs, "
                "design docs, or screen mockups) and follow them when relevant:\n"
                f"{listing}\n"
            )
        return (
            "\n## 添付ファイル\n\n"
            "ユーザーが以下のファイルを添付しています。必要に応じて内容を読み取り"
            "（仕様書・設計書・画面モックなど）、それに従ってください:\n"
            f"{listing}\n"
        )

    def reset_workspace(self, container_id: str) -> None:
        """Delete all files under /workspace/repo and reinitialise a bare git repo."""
        cmd = (
            "rm -rf /workspace/repo && "
            "mkdir -p /workspace/repo && "
            "chown xolvien:xolvien /workspace/repo && "
            "git init /workspace/repo && "
            "git -C /workspace/repo commit --allow-empty -m 'initial' && "
            "chown -R xolvien:xolvien /workspace/repo"
        )
        exit_code, _, stderr = self.docker_service.execute_command(container_id, cmd, "/workspace")
        if exit_code != 0:
            raise RuntimeError(f"reset_workspace failed: {stderr}")

    async def clarify_requirements(
        self,
        db: AsyncSession,
        task_id: int,
        instruction: str,
        history: list,
        lang: str = "ja",
        upload_ids: list[int] | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        Conduct a clarification Q&A session before prompt generation.
        Claude either asks questions or outputs PROMPT_READY\\n{prompt}.

        When reference files are selected (upload_ids), the CLI gets read-only
        access to /workspace/uploads via --add-dir and MUST prove it read them
        by emitting a [XOLVIEN_SPEC_READ] marker — a response without the
        marker aborts with SPEC_NOT_READ instead of quietly interviewing the
        user with questions the spec already answers. Uploads are expected to
        be larger than the context window, so their content is never embedded
        in the prompt; Claude reads the relevant parts via the Read tool.
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

        # Repository-level uploaded reference files (specs, design docs, mockups),
        # limited to the ones this message selected.
        uploads_section = await self._prepare_uploads(db, task, lang, upload_ids)

        # Build conversation history text
        history_text = ""
        if history:
            for msg in history:
                if lang == "en":
                    role_label = "Claude" if msg["role"] == "assistant" else "User"
                else:
                    role_label = "Claude" if msg["role"] == "assistant" else "ユーザー"
                history_text += f"{role_label}: {msg['content']}\n\n"

        if lang == "en":
            clarify_prompt = f"""You are a requirements analyst. You receive user instructions and ask clarifying questions to generate the best possible code.

## Project Information

File list:
{file_list.strip()}

README:
{readme[:2000].strip()}
{uploads_section}
## User Instruction

{instruction}
"""
            if history_text:
                clarify_prompt += f"""
## Conversation History

{history_text.strip()}
"""
            clarify_prompt += """
## Your Role

This is the requirements clarification phase. Continue asking questions until the user clicks "Proceed".

**CRITICAL RULE: Ask exactly ONE question per response. Never ask multiple questions at once.**

Each response must follow this exact format:
```
[Question text]

Options:
- [Option A]
- [Option B]
- [Option C]
```

Always start with this question first (unless the conversation history or the reference files already answer it):
- Question: What programming language and framework should be used?
- Options must include concrete choices (e.g. "Vanilla HTML/CSS/JS", "React", "Vue", "TypeScript")

After language/framework is confirmed, ask ONE follow-up question at a time about:
- Features, constraints, and expected behavior
- If there is a UI, design and interaction flow
- Specifications the user should decide (not implementation details)

Never output "PROMPT_READY". Always respond with one question + options only.
No preamble or explanation. No numbered prefix on the question itself.
"""
        else:
            clarify_prompt = f"""あなたは要件ヒアリング担当です。ユーザーの指示を受け取り、最適なコードを生成するために必要な不明点を質問します。

## プロジェクト情報

ファイル一覧:
{file_list.strip()}

README:
{readme[:2000].strip()}
{uploads_section}
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

これは要件ヒアリングフェーズです。ユーザーが「次へ進む」を押すまで質問を続けてください。

**重要ルール：1回の応答で必ず1問だけ質問してください。複数の質問を同時に出さないこと。**

各応答は以下のフォーマットに厳密に従ってください：
```
[質問文]

選択肢:
- [選択肢A]
- [選択肢B]
- [選択肢C]
```

会話履歴で回答済み、または参照ファイルに記載済みでない限り、最初に必ずこの質問から始めてください：
- 質問：使用するプログラミング言語とフレームワークは何ですか？
- 選択肢には具体的な候補（例：「Vanilla HTML/CSS/JS」「React」「Vue」「TypeScript」）を含めること

言語/フレームワークが確定したら、次の項目について1問ずつ質問してください：
- 機能・制約・期待する動作
- UIがある場合はデザインや操作フロー
- ユーザーが決めるべき仕様（実装詳細ではなく）

「PROMPT_READY」は絶対に出力しないでください。必ず質問1問＋選択肢のみで応答してください。
説明や前置きは不要です。質問自体に番号をつけないこと。
"""

        # Reference-file protocol: only added when files are actually selected.
        # Read access is granted via --add-dir below; the marker proves it.
        if uploads_section:
            if lang == "en":
                clarify_prompt += """
## Reference files (MUST DO FIRST)

- BEFORE asking anything, read the reference files listed above (use the converted Markdown). For large files, grasp the structure first, then read the sections relevant to the user's instruction.
- After reading, output `[XOLVIEN_SPEC_READ]` alone on the FIRST line of your response, then write your question. A response without this marker is treated as a failure.
- Never ask about anything the reference files already specify (language, framework, features, screens, etc.). Treat their contents as decided; ask only about points they leave open.
"""
            else:
                clarify_prompt += """
## 参照ファイルの取り扱い（最初に必ず実行）

- 質問する前に、上記の参照ファイルを読むこと（変換済みMarkdownを使うこと）。大きなファイルはまず構成を把握し、依頼に関係する部分を読むこと。
- 読み終えたら、応答の1行目に `[XOLVIEN_SPEC_READ]` を単独で出力し、その後に質問を書くこと。このマーカーがない応答は失敗として扱われる。
- 参照ファイルに記載済みの事項（言語・フレームワーク・機能・画面構成など）は質問しないこと。記載内容は確定事項として扱い、記載のない不明点のみ質問すること。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", clarify_prompt)
        # clarify is read-only Q&A: run as root (HOME=xolvien), no write tools.
        # When reference files are selected, grant READ access to the uploads
        # directory (it is outside the CLI's working dir /workspace/repo).
        self._write_runner(
            task.container_id,
            skip_permissions=False,
            drop_privs=False,
            add_dirs=(["/workspace/uploads"] if uploads_section else None),
        )

        # Collect the assistant's text so we can VERIFY the proof-of-read
        # marker — with reference files selected, a marker-less response means
        # Claude skipped the spec, and we abort loudly rather than let it
        # interview the user blind.
        sink: list[str] = []
        async for chunk in self._stream_runner_checked(
            task.container_id, chunk_timeout=120.0, text_sink=sink,
        ):
            yield chunk

        if uploads_section and "[XOLVIEN_SPEC_READ]" not in "".join(sink):
            raise XolvienError(
                ErrorCode.SPEC_NOT_READ,
                "reference files were selected but the response carried no "
                "[XOLVIEN_SPEC_READ] marker — the spec was not read",
            )

    async def generate_prompt(
        self,
        db: AsyncSession,
        task_id: int,
        instruction_content: str,
        feedback: str = "",
        lang: str = "ja",
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
        past_text = "\n".join(f"- {i.content}" for i in past_instructions) or "(none)"

        if lang == "en":
            meta_prompt = f"""You are a prompt engineer. Convert the user's brief instruction into the best possible prompt to pass to a Claude Code CLI agent.

## Workspace information

Working directory: /workspace/repo

File list:
{file_list.strip()}

Recent git history:
{git_log.strip()}

README:
{readme[:3000].strip()}

Past instructions for this task:
{past_text}

## User instruction

{instruction_content}
"""
            if feedback:
                meta_prompt += f"""
## Feedback on the previously generated prompt

{feedback}
"""
            meta_prompt += """
## Instructions

Based on the workspace information above, generate the best prompt to pass to the Claude Code CLI agent.

The generated prompt must include:
- Relevant file paths from the file list above
- Specific changes to make
- Verification criteria if needed

Note: The execution agent reads/writes files and runs commands automatically. Do not specify output format.

Output the prompt body only. No explanation or preamble.
"""
        else:
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
## 指示

上記のワークスペース情報をもとに、Claude Code CLIエージェントへ渡す最適なプロンプトを生成してください。

生成するプロンプトには以下を含めてください：
- ファイル一覧にある関連ファイルのパス
- 具体的な変更内容
- 必要であれば動作確認の観点

注意: 実行エージェントはファイルの読み書きやコマンド実行を自動で行います。出力形式の指定は不要です。

プロンプト本文のみを出力してください。説明や前置きは不要です。
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", meta_prompt)
        self._write_runner(task.container_id, skip_permissions=True, drop_privs=True)

        async for chunk in self._stream_runner_checked(
            task.container_id, chunk_timeout=120.0,
        ):
            yield chunk

    async def execute_instruction(
        self,
        db: AsyncSession,
        task_id: int,
        instruction_content: str,
        upload_ids: list[int] | None = None,
        lang: str = "ja",
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
        if task.status in [TaskStatus.INITIALIZING, TaskStatus.PENDING]:
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

            yield f"[SYSTEM] Instruction received\n"
            yield f"[SYSTEM] {instruction_content}\n\n"

            # Sprint 3: the confirmed prompt IS the requirements source —
            # generate the requirements definition document in the background.
            schedule_generation(
                task_id, task.container_id,
                [("requirements", instruction_content)], lang,
            )

            # Copy the SELECTED repository uploads into the container and prepend
            # a reference to them so Claude reads them during execution.
            uploads_section = await self._prepare_uploads(db, task, lang, upload_ids)
            prompt_text = instruction_content
            if uploads_section:
                yield "[SYSTEM] Attached reference files made available at /workspace/uploads/\n\n"
                prompt_text = f"{instruction_content}\n{uploads_section}"

            # Write prompt and runner script into the container
            self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", prompt_text)
            self._write_runner(task.container_id, skip_permissions=True, drop_privs=True)

            yield "[Claude] Running Claude Code CLI...\n\n"

            full_response = ""
            async for chunk in self._stream_runner_checked(
                task.container_id, chunk_timeout=120.0,
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
            yield "\n[GIT] Committing changes...\n"
            commit_msg = instruction_content.replace("\n", " ")[:72]
            # Write commit message to temp file to avoid shell escaping issues
            self._write_text_to_container(
                task.container_id, "/tmp/xolvien_commit_msg.txt", commit_msg
            )
            commit_cmd = (
                "git add -A && "
                "git diff --cached --quiet && echo '[GIT] No changes (skipping commit)' || "
                f"git {_GIT_ID} commit -F /tmp/xolvien_commit_msg.txt"
            )
            _, commit_out, _ = self.docker_service.execute_command(
                task.container_id, commit_cmd, "/workspace/repo", user=AGENT_USER
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

            # Sprint 3: implementation complete — generate the external and
            # internal design documents from the actual code (background).
            schedule_generation(
                task_id, task.container_id,
                [
                    ("external_design", instruction_content),
                    ("internal_design", instruction_content),
                ],
                lang,
            )

            yield "\n[SYSTEM] Done\n"

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
            # Re-raise so the streaming endpoint appends the error sentinel —
            # swallowing here would end the stream "successfully" and leave the
            # UI with no visible error.
            raise


    async def generate_test_cases(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        test_type: TestType = TestType.UNIT,
        lang: str = "ja",
    ) -> AsyncGenerator[str, None]:
        """
        Generate structured test cases (JSON) from an implementation prompt.
        Saves results to test_case_items table, streams progress to caller.
        Supports both UNIT and INTEGRATION test types.
        """
        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        is_integration = test_type == TestType.INTEGRATION
        is_e2e = test_type == TestType.E2E
        if is_e2e:
            tag = "[E2E]"
        elif is_integration:
            tag = "[ITEST]"
        else:
            tag = "[TEST]"

        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' | grep -v '__pycache__' | grep -v 'node_modules' | sed 's|/workspace/repo/||' 2>/dev/null || echo '(none)'",
            "/workspace",
        )

        # Strip absolute container paths so Claude doesn't attempt file reads
        implementation_prompt = implementation_prompt.replace("/workspace/repo/", "")

        BATCH_SIZE = 10

        if is_e2e:
            fn_prefix = "test_e2e"
            if lang == "en":
                context = (
                    "You are an E2E test design expert.\n"
                    "E2E tests are browser UI scenario tests (open page, interact with UI elements, verify visible results).\n"
                    "Do NOT design direct API call tests — those are integration tests.\n\n"
                    f"## Implementation content\n{implementation_prompt}\n\n"
                    f"## Project file list\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "First, decide how many E2E test cases are needed to fully cover this implementation.\n"
                    "Output this line first: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "Then generate the first {n} test cases (seq_no {start} to {end}).\n"
                )
                next_batch_prefix = "Generate the next {n} E2E test cases (seq_no {start} to {end}).\n"
                batch_body = (
                    "For each test case output exactly:\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "...", "test_item": "...", "operation": "browser steps with specific URL/click/input", "expected_output": "visible UI result", "function_name": "test_e2e{start:03d}_..."}}\n\n'
                    "Rules: No explanatory text. No markdown. One JSON object per test case immediately after its marker."
                )
            else:
                context = (
                    "あなたはE2Eテスト設計の専門家です。\n"
                    "E2Eテストはブラウザを使ったUIシナリオテストです（ページを開く、UI操作、表示結果確認）。\n"
                    "APIの直接呼び出しはE2Eテストではありません。\n\n"
                    f"## 実装予定の内容\n{implementation_prompt}\n\n"
                    f"## プロジェクトのファイル一覧\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "まず、この実装を完全にカバーするために必要なE2Eテストケースの総数を決めてください。\n"
                    "最初にこの行を出力してください: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "次に最初の {n} 件（seq_no {start}〜{end}）を生成してください。\n"
                )
                next_batch_prefix = "次の {n} 件のE2Eテストケース（seq_no {start}〜{end}）を生成してください。\n"
                batch_body = (
                    "各テストケースをこの形式で出力してください：\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "...", "test_item": "...", "operation": "具体的なURL・クリック・入力を含むブラウザ操作手順", "expected_output": "UI上の表示結果", "function_name": "test_e2e{start:03d}_..."}}\n\n'
                    "注意：説明文不要。マークダウン不要。マーカーの直後にJSONを1件ずつ出力してください。"
                )
        elif is_integration:
            fn_prefix = "test_itc"
            if lang == "en":
                context = (
                    "You are an integration test design expert.\n"
                    "Integration tests cover HTTP request/response flows across multiple components (Frontend → API → DB).\n"
                    "Do NOT design unit tests (single function behavior).\n\n"
                    f"## Implementation content\n{implementation_prompt}\n\n"
                    f"## Project file list\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "First, decide how many integration test cases are needed to fully cover this implementation.\n"
                    "Output this line first: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "Then generate the first {n} test cases (seq_no {start} to {end}).\n"
                )
                next_batch_prefix = "Generate the next {n} integration test cases (seq_no {start} to {end}).\n"
                batch_body = (
                    "For each test case output exactly:\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "API endpoint or flow name", "test_item": "...", "operation": "HTTP method, URL, request body", "expected_output": "HTTP status and response body", "function_name": "test_itc{start:03d}_..."}}\n\n'
                    "Rules: No explanatory text. No markdown. One JSON object per test case immediately after its marker."
                )
            else:
                context = (
                    "あなたは結合テスト設計の専門家です。\n"
                    "結合テストはHTTPリクエスト/レスポンスを通じた複数コンポーネント連携のテストです（フロントエンド→API→DB）。\n"
                    "単体テスト（関数単体の動作）は設計しないでください。\n\n"
                    f"## 実装予定の内容\n{implementation_prompt}\n\n"
                    f"## プロジェクトのファイル一覧\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "まず、この実装を完全にカバーするために必要な結合テストケースの総数を決めてください。\n"
                    "最初にこの行を出力してください: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "次に最初の {n} 件（seq_no {start}〜{end}）を生成してください。\n"
                )
                next_batch_prefix = "次の {n} 件の結合テストケース（seq_no {start}〜{end}）を生成してください。\n"
                batch_body = (
                    "各テストケースをこの形式で出力してください：\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "APIエンドポイントまたはフロー名", "test_item": "...", "operation": "HTTPメソッド・URL・リクエストボディ", "expected_output": "HTTPステータスとレスポンスボディ", "function_name": "test_itc{start:03d}_..."}}\n\n'
                    "注意：説明文不要。マークダウン不要。マーカーの直後にJSONを1件ずつ出力してください。"
                )
        else:
            fn_prefix = "test_tc"
            if lang == "en":
                context = (
                    "You are a unit test design expert.\n\n"
                    f"## Implementation content\n{implementation_prompt}\n\n"
                    f"## Project file list\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "First, decide how many unit test cases are needed to fully cover this implementation (happy path, error cases, boundary values).\n"
                    "Output this line first: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "Then generate the first {n} test cases (seq_no {start} to {end}).\n"
                )
                next_batch_prefix = "Generate the next {n} unit test cases (seq_no {start} to {end}).\n"
                batch_body = (
                    "For each test case output exactly:\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "...", "test_item": "...", "operation": "specific steps with input values", "expected_output": "specific expected output", "function_name": "test_tc{start:03d}_..."}}\n\n'
                    "Rules: Cover happy path, error cases, and boundary values. No explanatory text. No markdown. One JSON object per test case immediately after its marker."
                )
            else:
                context = (
                    "あなたはテスト設計の専門家です。\n\n"
                    f"## 実装予定の内容\n{implementation_prompt}\n\n"
                    f"## プロジェクトのファイル一覧\n{file_list.strip()}"
                )
                first_batch_prefix = (
                    "まず、この実装を完全にカバーするために必要な単体テストケースの総数を決めてください（正常系・異常系・境界値）。\n"
                    "最初にこの行を出力してください: [XOLVIEN_TC_TOTAL] <total>\n\n"
                    "次に最初の {n} 件（seq_no {start}〜{end}）を生成してください。\n"
                )
                next_batch_prefix = "次の {n} 件の単体テストケース（seq_no {start}〜{end}）を生成してください。\n"
                batch_body = (
                    "各テストケースをこの形式で出力してください：\n"
                    "[XOLVIEN_TC_DONE] <seq_no>\n"
                    '{{"seq_no": <seq_no>, "target_screen": "...", "test_item": "...", "operation": "具体的な入力値を含む操作手順", "expected_output": "期待される具体的な出力値", "function_name": "test_tc{start:03d}_..."}}\n\n'
                    "注意：正常系・異常系・境界値を網羅すること。説明文不要。マークダウン不要。マーカーの直後にJSONを1件ずつ出力してください。"
                )

        # Delete previous test_case_items of this test_type before starting
        existing = await db.execute(
            sa_select(TestCaseItem).where(
                TestCaseItem.task_id == task_id,
                TestCaseItem.test_type == test_type,
            )
        )
        for item in existing.scalars().all():
            await db.delete(item)
        await db.commit()

        # Clear session file so each generation starts fresh
        self.docker_service.execute_command(
            task.container_id, "rm -f /tmp/xolvien_session.txt", "/workspace"
        )
        # This flow bypasses _write_runner, so refresh credentials and
        # normalize repo ownership here too.
        self.docker_service.refresh_claude_credentials(task.container_id)
        self._normalize_repo_ownership(task.container_id)
        self._write_text_to_container(
            task.container_id, "/tmp/xolvien_runner_tc.py", _RUNNER_SCRIPT_TC_BATCH
        )

        gen_start = datetime.utcnow()
        tc_done_count = 0
        total_tc = 0  # set after first batch parses [XOLVIEN_TC_TOTAL]
        batch_num = 0

        while True:
            batch_num += 1
            start_seq = (batch_num - 1) * BATCH_SIZE + 1
            end_seq = batch_num * BATCH_SIZE
            if batch_num == 1:
                prefix = first_batch_prefix.format(n=BATCH_SIZE, start=start_seq, end=end_seq)
                prompt = context + "\n\n" + prefix + batch_body.format(start=start_seq)
            else:
                prefix = next_batch_prefix.format(n=BATCH_SIZE, start=start_seq, end=end_seq)
                prompt = prefix + batch_body.format(start=start_seq)

            self._write_text_to_container(
                task.container_id, "/tmp/xolvien_prompt.txt", prompt
            )

            if lang == "en":
                yield f"{tag} Generating test cases {start_seq}–{end_seq}...\n"
            else:
                yield f"{tag} テストケース {start_seq}〜{end_seq} を生成しています...\n"

            batch_rc, batch_output, _ = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: self.docker_service.execute_command(
                    task.container_id,
                    "python3 /tmp/xolvien_runner_tc.py",
                    "/workspace/repo",
                )
            )

            # Extract [XOLVIEN_TC_TOTAL] from first batch output
            if batch_num == 1:
                for line in batch_output.splitlines():
                    stripped = line.strip()
                    if stripped.startswith("[XOLVIEN_TC_TOTAL]"):
                        try:
                            total_tc = int(stripped.split()[1])
                        except (IndexError, ValueError):
                            pass

            # Parse test cases from this batch
            batch_items = self._parse_test_cases_json(batch_output)
            if not batch_items:
                # A failed CLI run (nonzero exit, e.g. revoked credentials) or a
                # first batch with nothing usable is an ERROR, not a quiet stop —
                # raise so the endpoint appends the error sentinel and the UI
                # shows a banner instead of ending silently.
                if batch_rc != 0 or tc_done_count == 0:
                    if lang == "en":
                        yield f"{tag} ⛔ Aborted: no test cases returned in batch {batch_num}.\n"
                    else:
                        yield f"{tag} ⛔ 中断: バッチ {batch_num} でテストケースが返されませんでした。\n"
                    detail = batch_output[-1000:] or f"batch exit code {batch_rc}"
                    code = classify_text(detail)
                    raise XolvienError(
                        code if code != ErrorCode.UNKNOWN else ErrorCode.CLAUDE_CLI_ERROR,
                        detail,
                    )
                # Batches so far succeeded and the CLI exited cleanly with an
                # empty batch: Claude finished early — treat as completion.
                break

            # Trim batch to not exceed total_tc
            if total_tc > 0 and tc_done_count + len(batch_items) > total_tc:
                batch_items = batch_items[:total_tc - tc_done_count]

            # Save batch to DB
            for item_data in batch_items:
                tc_done_count += 1
                tc = TestCaseItem(
                    task_id=task_id,
                    test_type=test_type,
                    seq_no=item_data["seq_no"],
                    target_screen=item_data.get("target_screen"),
                    test_item=item_data["test_item"],
                    operation=item_data.get("operation"),
                    expected_output=item_data.get("expected_output"),
                    function_name=item_data.get("function_name"),
                )
                db.add(tc)
            await db.commit()

            elapsed_ms = int((datetime.utcnow() - gen_start).total_seconds() * 1000)
            yield f"[XOLVIEN_PROGRESS] {tc_done_count}/{total_tc} elapsed_ms={elapsed_ms} eta_ms=0\n"
            if lang == "en":
                yield f"{tag} ✅ {tc_done_count}/{total_tc if total_tc else '?'} test cases saved\n"
            else:
                yield f"{tag} ✅ {tc_done_count}/{total_tc if total_tc else '?'} 件保存済み\n"

            # Stop when total reached, or Claude returned fewer than BATCH_SIZE
            if total_tc > 0 and tc_done_count >= total_tc:
                break
            if len(batch_items) < BATCH_SIZE:
                break

        if tc_done_count == 0:
            if lang == "en":
                yield f"\n{tag} ⛔ No test cases were generated.\n"
            else:
                yield f"\n{tag} ⛔ テストケースが生成されませんでした。\n"
            raise XolvienError(
                ErrorCode.CLAUDE_CLI_ERROR, "No test cases were generated"
            )
        else:
            if lang == "en":
                yield f"\n{tag} ✅ Done. Total: {tc_done_count} test cases\n"
            else:
                yield f"\n{tag} ✅ 完了。合計 {tc_done_count} 件のテストケースを生成しました\n"

    def _parse_test_cases_json(self, raw: str) -> list[dict]:
        """Parse test cases from one-per-line JSON objects."""
        items = []
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith('{') and line.endswith('}'):
                try:
                    items.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return items

    def _detect_e2e_test_command(self, container_id: str) -> str | None:
        """Detect Playwright config and return the appropriate E2E test command.

        All checks run as AGENT_USER — the same user that installed the
        dependencies and will run the tests — so detection can never disagree
        with execution about what is installed.
        """
        _, config_check, _ = self.docker_service.execute_command(
            container_id,
            "ls /workspace/repo/playwright.config.js /workspace/repo/playwright.config.ts 2>/dev/null | head -1 || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )
        if config_check.strip():
            return "npx playwright test --reporter=list 2>&1"

        # Python Playwright fallback
        _, py_playwright, _ = self.docker_service.execute_command(
            container_id,
            "python -c 'import playwright' 2>/dev/null && echo 'ok' || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )
        if py_playwright.strip() == "ok":
            return "python -m pytest tests/e2e/ -v 2>&1"

        # No Playwright config yet — it will be created by the code generation step
        return "npx playwright test --reporter=list 2>&1"

    def _detect_test_command(self, container_id: str) -> str | None:
        """
        Detect the test command from the project structure.
        Returns the command string, or None if no test framework is found.
        package.json is checked first — Node.js projects may also have requirements.txt.

        All checks run as AGENT_USER: Claude installs dependencies as that
        user (pip install --user lands in /home/xolvien/.local), so a
        root-side check would report pytest "missing" even though the tests
        are perfectly runnable — the exact "No test framework found" failure
        this used to produce.
        """
        # Check Node.js first (package.json is unambiguous)
        _, pkg_json, _ = self.docker_service.execute_command(
            container_id,
            "cat /workspace/repo/package.json 2>/dev/null || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )
        if pkg_json.strip():
            return "npm test -- --watchAll=false --verbose 2>&1"

        # Check for Python test frameworks
        _, pyproject, _ = self.docker_service.execute_command(
            container_id,
            "cat /workspace/repo/pyproject.toml 2>/dev/null || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )
        _, setup_py, _ = self.docker_service.execute_command(
            container_id,
            "test -f /workspace/repo/setup.py && echo 'exists' || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )
        _, req_files, _ = self.docker_service.execute_command(
            container_id,
            "ls /workspace/repo/requirements*.txt 2>/dev/null || echo ''",
            "/workspace/repo",
            user=AGENT_USER,
        )

        is_python = (
            'pytest' in pyproject
            or 'unittest' in pyproject
            or setup_py.strip() == 'exists'
            or req_files.strip() != ''
        )

        if is_python:
            # Verify pytest is actually installed FOR THE AGENT USER
            _, pytest_check, _ = self.docker_service.execute_command(
                container_id,
                "python -m pytest --version 2>/dev/null && echo 'ok' || echo 'missing'",
                "/workspace/repo",
                user=AGENT_USER,
            )
            if 'missing' in pytest_check:
                return None  # pytest not installed — caller should install first
            return "python -m pytest -v 2>&1"

        return None

    async def run_unit_tests(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        lang: str = "ja",
    ) -> AsyncGenerator[str, None]:
        """Generate unit test code, run tests, auto-fix up to 3 times."""
        async for chunk in self._run_tests(db, task_id, implementation_prompt, TestType.UNIT, lang=lang):
            yield chunk

    async def run_integration_tests(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        lang: str = "ja",
    ) -> AsyncGenerator[str, None]:
        """Generate integration test code, start server/DB, run tests, auto-fix up to 3 times."""
        async for chunk in self._run_tests(db, task_id, implementation_prompt, TestType.INTEGRATION, lang=lang):
            yield chunk

    async def run_e2e_tests(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        lang: str = "ja",
    ) -> AsyncGenerator[str, None]:
        """Generate Playwright E2E test code, run tests with screenshots, auto-fix up to 3 times."""
        async for chunk in self._run_tests(db, task_id, implementation_prompt, TestType.E2E, lang=lang):
            yield chunk

    async def _run_tests(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        test_type: TestType,
        lang: str = "ja",
    ) -> AsyncGenerator[str, None]:
        """
        Shared implementation for unit, integration, and E2E tests.
        Generates test code, executes tests, auto-fixes up to 3 times.
        Saves TestRun and TestCaseResult records. Streams progress logs.
        """
        is_integration = test_type == TestType.INTEGRATION
        is_e2e = test_type == TestType.E2E
        if is_e2e:
            tag = "[E2E]"
            report_suffix = "e2e"
            report_title = "E2E Test" if lang == "en" else "E2Eテスト"
            commit_prefix = "test(e2e)"
        elif is_integration:
            tag = "[ITEST]"
            report_suffix = "integration"
            report_title = "Integration Test" if lang == "en" else "結合テスト"
            commit_prefix = "test(integration)"
        else:
            tag = "[TEST]"
            report_suffix = "unit"
            report_title = "Unit Test" if lang == "en" else "単体テスト"
            commit_prefix = "test"

        result = await db.execute(sa_select(Task).where(Task.id == task_id))
        task = result.scalar_one_or_none()
        if not task:
            raise ValueError("Task not found")
        if not task.container_id:
            raise ValueError("Task has no container")

        # Load approved test case items from DB (filtered by test_type)
        tc_result = await db.execute(
            sa_select(TestCaseItem).where(
                TestCaseItem.task_id == task_id,
                TestCaseItem.test_type == test_type,
            ).order_by(TestCaseItem.seq_no)
        )
        tc_items = tc_result.scalars().all()
        if not tc_items:
            if lang == "en":
                yield f"{tag} ⚠️ No test cases registered. Please generate and approve test cases first.\n"
            else:
                yield f"{tag} ⚠️ テストケースが登録されていません。先にテストケースを生成・承認してください。\n"
            return

        task.status = TaskStatus.TESTING
        await db.commit()

        test_run = TestRun(
            task_id=task_id,
            test_type=test_type,
            started_at=datetime.utcnow(),
        )
        db.add(test_run)
        await db.commit()
        await db.refresh(test_run)

        total_tc = len(tc_items)
        if lang == "en":
            yield f"{tag} Generating test code... (0/{total_tc})\n"
        else:
            yield f"{tag} テストコードを生成しています... (0/{total_tc})\n"

        tc_summary_lines = []
        for tc in tc_items:
            if lang == "en":
                tc_summary_lines.append(
                    f"- {tc.tc_id} | {tc.test_item} | operation: {tc.operation} | expected: {tc.expected_output} | function: {tc.function_name}"
                )
            else:
                tc_summary_lines.append(
                    f"- {tc.tc_id} | {tc.test_item} | 操作: {tc.operation} | 期待出力: {tc.expected_output} | function: {tc.function_name}"
                )
        tc_summary = "\n".join(tc_summary_lines)

        # Progress marker instruction — injected into every gen_prompt
        tc_id_list = " ".join(tc.tc_id for tc in tc_items)
        xolvien_marker_instruction = f"""
## Progress reporting (MANDATORY)
For each test case, you MUST output these two marker lines at the exact moments described.
Do NOT skip or merge them. Output them as standalone lines with nothing else on the line.

Before you start writing the test function for each test case:
  [XOLVIEN_TC_START] <tc_id>

After you finish writing the test function for each test case:
  [XOLVIEN_TC_DONE] <tc_id>

Test case IDs to cover (in order): {tc_id_list}
Total: {total_tc} cases

Example for TC-001:
  [XOLVIEN_TC_START] TC-001
  ... (write the test function here) ...
  [XOLVIEN_TC_DONE] TC-001
"""

        _, file_list, _ = self.docker_service.execute_command(
            task.container_id,
            "find /workspace/repo -type f | grep -v '.git' | grep -v '__pycache__' | grep -v 'node_modules' | sed 's|/workspace/repo/||' 2>/dev/null",
            "/workspace",
        )

        # Strip absolute container paths so Claude doesn't attempt file reads
        implementation_prompt = implementation_prompt.replace("/workspace/repo/", "")

        if is_e2e:
            tc_id_example = "E2E-001"
            tc_func_example = "test_e2e001_xxx"
        elif is_integration:
            tc_id_example = "ITC-001"
            tc_func_example = "test_itc001_xxx"
        else:
            tc_id_example = "TC-001"
            tc_func_example = "test_tc001_xxx"
        xolvien_result_instruction = f"""
   **重要: 各テストケースは必ず以下のパターンで実際の出力値を `console.log` で出力すること**

   Jest（Node.js）の場合の例:
   ```javascript
   test('{tc_id_example}: テスト名', () => {{
     const actual = /* 実際の値 */;
     console.log('XOLVIEN_RESULT:' + JSON.stringify({{tc_id: '{tc_id_example}', actual: String(actual)}}));
     expect(actual).toBe(/* 期待値 */);
   }});
   ```

   pytest（Python）の場合の例:
   ```python
   import json
   def {tc_func_example}():
       actual = /* 実際の値 */
       print('XOLVIEN_RESULT:' + json.dumps({{'tc_id': '{tc_id_example}', 'actual': str(actual)}}))
       assert actual == /* 期待値 */
   ```"""

        if is_e2e:
            if lang == "en":
                gen_prompt = f"""You are an expert in Playwright E2E test code generation. Execute all steps below in order.

## Implementation content
{implementation_prompt}

## Approved test cases
Generate a function for each test case's function_name and write test code based on the operation and expected output.

{tc_summary}

## Project file list
{file_list.strip()}

{xolvien_marker_instruction}

## Steps (execute in order)

1. Read `package.json`, `pyproject.toml`, or `requirements*.txt` to identify how to start the app
2. **Install @playwright/test**
   - Node.js: `npm install --save-dev @playwright/test && npx playwright install chromium`
   - Python: `pip install pytest-playwright && playwright install chromium`
3. **Create `playwright.config.js` (Node.js)**
   ```javascript
   // playwright.config.js
   const {{ defineConfig }} = require('@playwright/test');
   module.exports = defineConfig({{
     testDir: './e2e',
     use: {{ headless: true, baseURL: 'http://localhost:3000' }},
   }});
   ```
   Adjust the port to match the app's actual startup port.
4. **Start the app in the background**
   - Node.js: `npm start &` or `npm run dev &`, then health-check with `curl`
   - Python: `uvicorn app:app &` or `flask run &`
5. **Create E2E test file in `e2e/` directory (Node.js: `e2e/tests.spec.js`)**
   - Use `@playwright/test`'s `test` / `expect` — **do NOT use Jest's `test()`**
   - For each test case in order, output [XOLVIEN_TC_START] <tc_id>, write the test function, then output [XOLVIEN_TC_DONE] <tc_id>
   - Output `console.log('XOLVIEN_RESULT:' + JSON.stringify({{tc_id: 'E2E-001', actual: 'actual value'}}))` at the start of each test

   **Node.js Playwright example:**
   ```javascript
   const {{ test, expect }} = require('@playwright/test');

   test('{tc_id_example}: test name', async ({{ page }}) => {{
     await page.goto('/');
     const text = await page.textContent('h1');
     console.log('XOLVIEN_RESULT:' + JSON.stringify({{tc_id: '{tc_id_example}', actual: String(text)}}));
     await page.screenshot({{ path: '/workspace/repo/test-reports/screenshots/{tc_id_example}.png' }});
     await expect(page.locator('h1')).toHaveText('expected text');
   }});
   ```

   - Output `XOLVIEN_RESULT:` before `expect`
   - Save screenshots to `/workspace/repo/test-reports/screenshots/` before each test ends
   - Run Playwright in headless mode (`headless: true`)
   - Create screenshot directory with `mkdir -p` beforehand
6. Run tests: `npx playwright test --reporter=line`
7. Stop the background server after tests finish

Notes:
- Do not change function_name (used for DB result matching)
- Convert `actual` to a string
- **Do not use Jest. Use only `@playwright/test`'s `test()`**
- Do not modify Jest settings like `testPathIgnorePatterns`
"""
            else:
                gen_prompt = f"""あなたはPlaywrightを使ったE2Eテストコード生成の専門家です。以下の手順をすべて実行してください。

## 実装内容
{implementation_prompt}

## 承認済みテストケース一覧
各テストケースの function_name で関数を生成し、操作と期待出力に基づいてテストコードを書いてください。

{tc_summary}

## プロジェクトのファイル一覧
{file_list.strip()}

{xolvien_marker_instruction}

## 実行手順（順番通りに行うこと）

1. `package.json` や `pyproject.toml`、`requirements*.txt` を読み込み、アプリの起動方法を特定してください
2. **@playwright/test をインストールしてください**
   - Node.js の場合: `npm install --save-dev @playwright/test && npx playwright install chromium`
   - Python の場合: `pip install pytest-playwright && playwright install chromium`
3. **`playwright.config.js` を作成してください（Node.js の場合）**
   ```javascript
   // playwright.config.js
   const {{ defineConfig }} = require('@playwright/test');
   module.exports = defineConfig({{
     testDir: './e2e',
     use: {{ headless: true, baseURL: 'http://localhost:3000' }},
   }});
   ```
   ポート番号はアプリの実際の起動ポートに合わせること。
4. **アプリをバックグラウンドで起動してください**
   - Node.js の場合: `npm start &` または `npm run dev &` などでサーバーを起動し、`curl` でヘルスチェックすること
   - Python の場合: `uvicorn app:app &` や `flask run &` などで起動すること
5. **E2E テストファイルを `e2e/` ディレクトリに作成してください（Node.js の場合: `e2e/tests.spec.js`）**
   - `@playwright/test` の `test` / `expect` を使い、**Jest の `test()` は使わないこと**
   - 各テストケースを順番に処理し、[XOLVIEN_TC_START] <tc_id> を出力→関数を書く→[XOLVIEN_TC_DONE] <tc_id> を出力すること
   - 各テストの先頭で `console.log('XOLVIEN_RESULT:' + JSON.stringify({{tc_id: 'E2E-001', actual: 'actual value'}}))` を出力すること

   **Node.js Playwright の例:**
   ```javascript
   const {{ test, expect }} = require('@playwright/test');

   test('{tc_id_example}: テスト名', async ({{ page }}) => {{
     await page.goto('/');
     const text = await page.textContent('h1');
     console.log('XOLVIEN_RESULT:' + JSON.stringify({{tc_id: '{tc_id_example}', actual: String(text)}}));
     await page.screenshot({{ path: '/workspace/repo/test-reports/screenshots/{tc_id_example}.png' }});
     await expect(page.locator('h1')).toHaveText('期待するテキスト');
   }});
   ```

   - `XOLVIEN_RESULT:` の出力は `expect` より前に行うこと
   - スクリーンショットを各テスト終了前に `/workspace/repo/test-reports/screenshots/` に保存すること
   - Playwright はヘッドレスモード（`headless: true`）で実行すること
   - スクリーンショット保存ディレクトリは事前に `mkdir -p` で作成すること
6. テストを実行してください: `npx playwright test --reporter=line`
7. テスト終了後にバックグラウンドで起動したサーバーを停止すること

注意:
- function_name は変更しないこと（DBでの結果照合に使用する）
- 記録する `actual` は文字列に変換すること
- **Jest を使わないこと。`@playwright/test` の `test()` のみ使用すること**
- `testPathIgnorePatterns` など Jest の設定を変更しないこと
"""
        elif is_integration:
            if lang == "en":
                gen_prompt = f"""You are an expert in integration test code generation. Execute all steps below in order.

## Implementation content
{implementation_prompt}

## Approved test cases
Generate a function for each test case's function_name and write test code based on the operation and expected output.

{tc_summary}

## Project file list
{file_list.strip()}

{xolvien_marker_instruction}

## Steps (execute in order)

1. Read `package.json`, `pyproject.toml`, or `requirements*.txt` to identify the test framework and how to start the app
2. Check existing test files and follow their naming conventions and structure
3. **Start the API server and DB in the background** before running tests
   - Node.js: `npm start &` or `node server.js &`, then wait for startup
   - Python: `uvicorn app:app &` or `flask run &`
   - If DB is needed: set up test DB connection strings
   - Verify startup: confirm health-check endpoint is reachable with `curl` or `wget`
4. For each test case in order, output [XOLVIEN_TC_START] <tc_id>, write the test function, then output [XOLVIEN_TC_DONE] <tc_id>
   - Use actual HTTP requests (axios, requests, fetch, httpx, etc.) to call the API
   - Use real DB connections if DB state verification is needed
{xolvien_result_instruction}
5. Install required dependencies (supertest, axios, httpx, pytest-httpx, etc.)
6. Run the tests

Notes:
- Do not change function_name (used for DB result matching)
- Output `XOLVIEN_RESULT:` before `expect/assert`
- Convert `actual` to a string
- Stop the background server after tests finish
"""
            else:
                gen_prompt = f"""あなたは結合テストコード生成の専門家です。以下の手順をすべて実行してください。

## 実装内容
{implementation_prompt}

## 承認済みテストケース一覧
各テストケースの function_name で関数を生成し、操作と期待出力に基づいてテストコードを書いてください。

{tc_summary}

## プロジェクトのファイル一覧
{file_list.strip()}

{xolvien_marker_instruction}

## 実行手順（順番通りに行うこと）

1. `package.json` や `pyproject.toml`、`requirements*.txt` を読み込み、テストフレームワークとアプリの起動方法を特定してください
2. 既存のテストファイルがあれば確認し、命名規則・構造に従ってください
3. **APIサーバーとDBをバックグラウンドで起動してから**テストを実行する準備をしてください
   - Node.js の場合: `npm start &` や `node server.js &` などでサーバーを起動し、起動待ちを行うこと
   - Python の場合: `uvicorn app:app &` や `flask run &` などでサーバーを起動すること
   - DB が必要な場合: テスト用DB接続文字列をセットアップすること
   - サーバーの起動確認: `curl` や `wget` でヘルスチェックエンドポイントに到達できることを確認すること
4. 各テストケースを順番に処理し、[XOLVIEN_TC_START] <tc_id> を出力→関数を書く→[XOLVIEN_TC_DONE] <tc_id> を出力してください
   - 実際の HTTP リクエスト（axios, requests, fetch, httpx 等）を使ってAPIを呼び出すこと
   - DBの状態確認が必要な場合は実際のDB接続を使うこと
{xolvien_result_instruction}
5. テストの実行に必要な依存パッケージをインストールしてください（supertest, axios, httpx, pytest-httpx 等）
6. テストを実行してください

注意:
- function_name は変更しないこと（DBでの結果照合に使用する）
- `XOLVIEN_RESULT:` の出力は `expect/assert` より前に行うこと
- 記録する `actual` は文字列に変換すること
- テスト終了後にバックグラウンドで起動したサーバーを停止すること
"""
        else:
            if lang == "en":
                gen_prompt = f"""You are an expert in unit test code generation. Execute all steps below in order.

## Implementation content
{implementation_prompt}

## Approved test cases
Generate a function for each test case's function_name and write test code based on the operation and expected output.

{tc_summary}

## Project file list
{file_list.strip()}

{xolvien_marker_instruction}

## Steps (execute in order)

1. Read `package.json`, `pyproject.toml`, or `requirements*.txt` to identify the test framework (Jest, pytest, etc.)
2. Check existing test files and follow their naming conventions and structure
3. For each test case in order, output [XOLVIEN_TC_START] <tc_id>, write the test function, then output [XOLVIEN_TC_DONE] <tc_id>
{xolvien_result_instruction}
4. Install required dependencies
5. Run the tests

Notes:
- Do not change function_name (used for DB result matching)
- Output `XOLVIEN_RESULT:` prefix before `expect/assert` (so it is recorded even if the test fails)
- Convert `actual` to a string
"""
            else:
                gen_prompt = f"""あなたはテストコード生成の専門家です。以下の手順をすべて実行してください。

## 実装内容
{implementation_prompt}

## 承認済みテストケース一覧
各テストケースの function_name で関数を生成し、操作と期待出力に基づいてテストコードを書いてください。

{tc_summary}

## プロジェクトのファイル一覧
{file_list.strip()}

{xolvien_marker_instruction}

## 実行手順（順番通りに行うこと）

1. `package.json` や `pyproject.toml`、`requirements*.txt` を読み込み、テストフレームワーク（Jest, pytest 等）を特定してください
2. 既存のテストファイルがあれば確認し、命名規則・構造に従ってください
3. 各テストケースを順番に処理し、[XOLVIEN_TC_START] <tc_id> を出力→関数を書く→[XOLVIEN_TC_DONE] <tc_id> を出力してください
{xolvien_result_instruction}
4. テストの実行に必要な依存パッケージをインストールしてください
5. テストを実行してください

注意:
- function_name は変更しないこと（DBでの結果照合に使用する）
- `XOLVIEN_RESULT:` プレフィックス付きの出力は `expect/assert` より前に行うこと（テスト失敗時も記録されるよう）
- 記録する `actual` は文字列に変換すること
"""

        self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", gen_prompt)
        self._write_runner(task.container_id, skip_permissions=True, drop_privs=True)

        gen_start = datetime.utcnow()
        tc_done_count = 0
        # The runner now streams RAW stream-json. The [XOLVIEN_TC_DONE] markers are
        # part of Claude's assistant text, so reconstruct that text by concatenating
        # text_delta events, then count completed (newline-terminated) marker lines.
        assistant_text = ""
        counted_markers = 0

        try:
            async for chunk in self._stream_runner_checked(
                task.container_id, chunk_timeout=90.0,
            ):
                now = datetime.utcnow()
                # Forward the raw chunk verbatim for the left-pane (console.log) view.
                yield chunk
                # Reconstruct assistant text from this chunk's text_delta events.
                for raw_line in chunk.splitlines():
                    s = raw_line.strip()
                    if not s:
                        continue
                    try:
                        obj = json.loads(s)
                    except Exception:
                        continue
                    if obj.get("type") == "stream_event":
                        ev = obj.get("event", {})
                        if ev.get("type") == "content_block_delta":
                            delta = ev.get("delta", {})
                            if delta.get("type") == "text_delta":
                                assistant_text += delta.get("text", "")
                # Count newly-completed [XOLVIEN_TC_DONE] lines (only whole lines).
                done_total = assistant_text.count("[XOLVIEN_TC_DONE]")
                # Subtract a possibly-incomplete trailing marker on the last line.
                last_line = assistant_text.rsplit("\n", 1)[-1]
                if "[XOLVIEN_TC_DONE]" in last_line and not assistant_text.endswith("\n"):
                    done_total -= 1
                while counted_markers < done_total:
                    counted_markers += 1
                    tc_done_count += 1
                    elapsed_ms = int((now - gen_start).total_seconds() * 1000)
                    remaining = total_tc - tc_done_count
                    avg_ms = elapsed_ms // tc_done_count if tc_done_count else 0
                    eta_ms = avg_ms * remaining
                    yield f"[XOLVIEN_PROGRESS] {tc_done_count}/{total_tc} elapsed_ms={elapsed_ms} eta_ms={eta_ms}\n"
        except XolvienError as e:
            test_run.passed = False
            test_run.completed_at = datetime.utcnow()
            test_run.summary = f"Aborted: {e.code.value}"
            task.status = TaskStatus.IDLE
            await db.commit()
            raise

        # Marker is mandatory — abort if Claude never output one
        if tc_done_count == 0:
            if lang == "en":
                yield f"\n{tag} ⛔ Aborted: no [XOLVIEN_TC_DONE] marker received. Claude did not follow the required output format.\n"
            else:
                yield f"\n{tag} ⛔ 中断: [XOLVIEN_TC_DONE]マーカーが1件も受信できませんでした。Claudeが出力フォーマットに従っていません。\n"
            test_run.passed = False
            test_run.completed_at = datetime.utcnow()
            test_run.summary = "Aborted: no progress markers" if lang == "en" else "中断: 進捗マーカーなし"
            await db.commit()
            task.status = TaskStatus.IDLE
            await db.commit()
            return

        if is_e2e:
            test_command = self._detect_e2e_test_command(task.container_id)
            # list reporter outputs ✓/✘ per test, compatible with existing verdict parsing
            if test_command and "playwright" in test_command:
                test_command = test_command.replace("--reporter=line", "--reporter=list")
        else:
            test_command = self._detect_test_command(task.container_id)
        if test_command is None:
            if lang == "en":
                yield f"\n{tag} No test framework found. Please check the test code.\n"
            else:
                yield f"\n{tag} テストフレームワークが見つかりません。テストコードを確認してください。\n"
            test_run.passed = False
            test_run.exit_code = -1
            test_run.error_output = "No test framework detected"
            test_run.completed_at = datetime.utcnow()
            test_run.summary = "No test framework detected" if lang == "en" else "テストフレームワーク未検出"
            await db.commit()
            task.status = TaskStatus.IDLE
            await db.commit()
            # Fail loud: an undetectable test framework is an infrastructure
            # problem, not a quiet no-op — raise so the error banner shows.
            raise XolvienError(
                ErrorCode.TEST_INFRA_ERROR,
                "no test framework detected (checked as the agent user)",
            )

        test_run.test_command = test_command
        await db.commit()

        if lang == "en":
            yield f"\n{tag} Running tests: {test_command}\n"
        else:
            yield f"\n{tag} テストを実行しています: {test_command}\n"

        max_retries = 3
        passed = False
        last_output = ""
        last_error = ""

        if is_e2e:
            results_file = "/tmp/xolvien_e2e_results.jsonl"
        elif is_integration:
            results_file = "/tmp/xolvien_itc_results.jsonl"
        else:
            results_file = "/tmp/xolvien_tc_results.jsonl"
        self.docker_service.execute_command(
            task.container_id,
            f"rm -f {results_file} && touch {results_file} && chmod 777 {results_file}",
            "/workspace/repo",
        )

        for attempt in range(max_retries + 1):
            if attempt > 0:
                if lang == "en":
                    yield f"\n{tag} Auto-fix ({attempt}/{max_retries})...\n"
                else:
                    yield f"\n{tag} 自動修正 ({attempt}/{max_retries})...\n"

                if lang == "en":
                    fix_prompt = f"""The tests failed. Identify the cause and fix it.

## Implementation content
{implementation_prompt}

## Test case list
{tc_summary}

## Test command
{test_command}

## Test output
{last_output[-3000:] if len(last_output) > 3000 else last_output}

## Standard error output
{last_error[-1000:] if len(last_error) > 1000 else last_error}

## Instructions
1. Identify the cause of failure (test code issue or implementation issue)
2. Fix the cause (do not change function_name)
3. Install missing dependencies if needed
4. Do not re-run the tests — only fix the code

## Absolutely prohibited
- Removing or weakening validation logic just to make tests pass
  (e.g. swallowing exceptions in `try/catch`, adding `return true` fallbacks)
- Weakening or removing `expect` / `assert` conditions
- For environment-dependent failures (clipboard, notifications, external APIs),
  use Playwright's `browserContext.grantPermissions()` or `page.route()` to mock correctly
"""
                else:
                    fix_prompt = f"""テストが失敗しました。原因を特定して修正してください。

## 実装内容
{implementation_prompt}

## テストケース一覧
{tc_summary}

## テストコマンド
{test_command}

## テスト実行の出力
{last_output[-3000:] if len(last_output) > 3000 else last_output}

## 標準エラー出力
{last_error[-1000:] if len(last_error) > 1000 else last_error}

## 指示
1. 失敗の原因を特定してください（テストコードの問題か、実装コードの問題か）
2. 原因を修正してください（function_name は変更しないこと）
3. 依存パッケージが不足している場合はインストールしてください
4. テストの再実行は不要です。修正のみ行ってください

## 絶対に行ってはいけないこと
- テストが通るようにするためだけに、実装コードの検証ロジックを削除・緩和すること
  （例: `try/catch` で例外を握り潰して成功扱いにする、常に `true` を返すフォールバックを追加する）
- `expect` / `assert` の条件を弱める・削除すること
- クリップボード・通知・外部API 等の環境依存で失敗する場合は、
  Playwright の `browserContext.grantPermissions()` や `page.route()` でモックして正しく検証すること
"""
                self._write_text_to_container(task.container_id, "/tmp/xolvien_prompt.txt", fix_prompt)
                self._write_runner(task.container_id, skip_permissions=True, drop_privs=True)

                try:
                    async for chunk in self._stream_runner_checked(
                        task.container_id, chunk_timeout=120.0,
                    ):
                        yield chunk
                except XolvienError as e:
                    test_run.passed = False
                    test_run.completed_at = datetime.utcnow()
                    test_run.summary = f"Auto-fix aborted: {e.code.value}"
                    task.status = TaskStatus.IDLE
                    await db.commit()
                    raise

                if lang == "en":
                    yield f"\n{tag} Re-running tests...\n"
                else:
                    yield f"\n{tag} テストを再実行しています...\n"

            exit_code, output, error = self.docker_service.execute_command(
                task.container_id,
                test_command,
                "/workspace/repo",
                user=AGENT_USER,
            )
            last_output = output
            last_error = error

            combined = (output + "\n" + error).strip()
            if combined:
                yield combined + "\n"

            passed = exit_code == 0
            test_run.retry_count = attempt
            test_run.exit_code = exit_code
            test_run.passed = passed
            test_run.output = output
            test_run.error_output = error

            if passed:
                if lang == "en":
                    yield f"\n{tag} ✅ Tests passed\n"
                else:
                    yield f"\n{tag} ✅ テストがパスしました\n"
                break
            else:
                combined_out = output + "\n" + error
                infra_error_patterns = [
                    "EACCES", "EPERM", "ENOENT", "ENOSPC",
                    "permission denied", "Permission denied",
                    "Cannot find module", "command not found",
                ]
                infra_error = next(
                    (p for p in infra_error_patterns if p in combined_out), None
                )
                if infra_error:
                    if lang == "en":
                        yield f"\n{tag} ⛔ Infrastructure error detected ({infra_error}). Skipping auto-fix.\n"
                        yield f"{tag} Please check the test code or environment configuration.\n"
                    else:
                        yield f"\n{tag} ⛔ インフラエラーを検出しました（{infra_error}）。自動修正をスキップします。\n"
                        yield f"{tag} テストコードまたは環境設定を確認してください。\n"
                    break

                if attempt < max_retries:
                    if lang == "en":
                        yield f"\n{tag} ❌ Tests failed (attempt {attempt + 1}/{max_retries + 1})\n"
                    else:
                        yield f"\n{tag} ❌ テストが失敗しました (試行 {attempt + 1}/{max_retries + 1})\n"
                else:
                    if lang == "en":
                        yield f"\n{tag} Max retries ({max_retries}) reached. Manual intervention required.\n"
                    else:
                        yield f"\n{tag} 最大リトライ回数 ({max_retries}) に達しました。手動対応が必要です。\n"

        # Parse XOLVIEN_RESULT: lines from stdout
        actual_by_tc_id: dict[str, str] = {}
        for line in (last_output + "\n" + last_error).splitlines():
            if "XOLVIEN_RESULT:" not in line:
                continue
            try:
                json_part = line[line.index("XOLVIEN_RESULT:") + len("XOLVIEN_RESULT:"):]
                row = json.loads(json_part)
                if "tc_id" in row and "actual" in row:
                    actual_by_tc_id[row["tc_id"]] = str(row["actual"])
            except (ValueError, json.JSONDecodeError):
                pass
        if not actual_by_tc_id:
            _, jsonl_content, _ = self.docker_service.execute_command(
                task.container_id,
                f"cat {results_file} 2>/dev/null || echo ''",
                "/workspace/repo",
            )
            for line in jsonl_content.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    if "tc_id" in row and "actual" in row:
                        actual_by_tc_id[row["tc_id"]] = str(row["actual"])
                except json.JSONDecodeError:
                    pass

        # Save TestCaseResults
        last_combined = (last_output + "\n" + last_error).strip()
        executed_at = datetime.utcnow()
        final_exit_code = test_run.exit_code or 0
        for tc in tc_items:
            verdict, actual_fallback = self._extract_result_for_function(last_combined, tc.function_name, tc.tc_id)
            actual = actual_by_tc_id.get(tc.tc_id) or actual_fallback
            # If output-format parsing missed this test but XOLVIEN_RESULT: was emitted,
            # the test ran — infer verdict from the overall exit code as a last resort.
            # A test whose result line was not found is still FAILED (not 未判定).
            if verdict is None and tc.tc_id in actual_by_tc_id:
                verdict = Verdict.PASSED if final_exit_code == 0 else Verdict.FAILED
            elif verdict is None:
                verdict = Verdict.FAILED
            tcr = TestCaseResult(
                test_case_item_id=tc.id,
                test_run_id=test_run.id,
                actual_output=actual,
                verdict=verdict,
                executed_at=executed_at,
            )
            db.add(tcr)
        await db.commit()
        if lang == "en":
            yield f"{tag} Saved {len(tc_items)} test results\n"
        else:
            yield f"{tag} テスト結果を {len(tc_items)} 件保存しました\n"

        # Compute summary from TestCaseResult verdicts
        tc_results_q = await db.execute(
            sa_select(TestCaseResult).where(TestCaseResult.test_run_id == test_run.id)
        )
        tc_results_all = tc_results_q.scalars().all()
        n_passed = sum(1 for r in tc_results_all if r.verdict == Verdict.PASSED)
        n_failed = sum(1 for r in tc_results_all if r.verdict in (Verdict.FAILED, Verdict.ERROR))
        n_skipped = sum(1 for r in tc_results_all if r.verdict == Verdict.SKIPPED)
        n_unknown = sum(1 for r in tc_results_all if r.verdict is None)
        parts = [f"{n_passed} passed", f"{n_failed} failed"]
        if n_skipped:
            parts.append(f"{n_skipped} skipped")
        if n_unknown:
            parts.append(f"{n_unknown} unknown" if lang == "en" else f"{n_unknown} 未判定")
        summary = ", ".join(parts)
        test_run.summary = summary

        now_str = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        executed_at_str = executed_at.strftime("%Y-%m-%d %H:%M:%S UTC")
        report_filename = f"test-report-{now_str}-{report_suffix}.md"
        report_path = f"/workspace/repo/test-reports/{report_filename}"

        tc_result2 = await db.execute(
            sa_select(TestCaseItem).where(
                TestCaseItem.task_id == task_id,
                TestCaseItem.test_type == test_type,
            ).order_by(TestCaseItem.seq_no)
        )
        tc_items2 = tc_result2.scalars().all()
        if lang == "en":
            report_rows = ["| TC-ID | Test Item | Expected | Actual | Result | Executed At |",
                           "|---|---|---|---|---|---|"]
        else:
            report_rows = ["| TC-ID | テスト項目 | 期待出力 | 実際の出力 | 判定 | 実行日時 |",
                           "|---|---|---|---|---|---|"]
        verdict_icon = {Verdict.PASSED: "✅", Verdict.FAILED: "❌", Verdict.ERROR: "⚠️", Verdict.SKIPPED: "⏭️"}
        not_executed = "Not executed" if lang == "en" else "未実行"
        for tc in tc_items2:
            r_res = await db.execute(
                sa_select(TestCaseResult)
                .where(TestCaseResult.test_case_item_id == tc.id)
                .where(TestCaseResult.test_run_id == test_run.id)
            )
            r = r_res.scalar_one_or_none()
            icon = verdict_icon.get(r.verdict, "—") if r and r.verdict else "—"
            verdict_str = r.verdict.value if r and r.verdict else not_executed
            actual = (r.actual_output or "—") if r else "—"
            report_rows.append(
                f"| {tc.tc_id} | {tc.test_item} | {tc.expected_output or '—'} | {actual} | {icon} {verdict_str} | {executed_at_str} |"
            )
        results_table_md = "\n".join(report_rows)

        if lang == "en":
            report_content = f"""# Test Report ({report_title})

| Item | Value |
|---|---|
| Executed At | {executed_at_str} |
| Test Command | `{test_command}` |
| Result | {"✅ PASS" if passed else "❌ FAIL"} |
| Retries | {test_run.retry_count} |
| Summary | {summary} |

## Test Results

{results_table_md}

## Test Execution Log

```
{(last_output + chr(10) + last_error).strip()[-5000:]}
```
"""
        else:
            report_content = f"""# テストレポート（{report_title}）

| 項目 | 値 |
|---|---|
| 実行日時 | {executed_at_str} |
| テストコマンド | `{test_command}` |
| 結果 | {"✅ PASS" if passed else "❌ FAIL"} |
| リトライ回数 | {test_run.retry_count} |
| サマリー | {summary} |

## テスト結果集計表

{results_table_md}

## テスト実行ログ

```
{(last_output + chr(10) + last_error).strip()[-5000:]}
```
"""

        self.docker_service.execute_command(
            task.container_id,
            "mkdir -p /workspace/repo/test-reports",
            "/workspace/repo",
            user=AGENT_USER,
        )
        self._write_text_to_container(task.container_id, report_path, report_content)
        # The report was written by root (base64 helper) inside the
        # xolvien-owned repo — hand it to the agent user immediately.
        self.docker_service.execute_command(
            task.container_id,
            f"chown {AGENT_USER}:{AGENT_USER} {report_path}",
            "/workspace/repo",
        )

        test_run.report_path = report_path
        test_run.completed_at = datetime.utcnow()
        await db.commit()

        commit_msg = f"{commit_prefix}: add {report_suffix} tests ({'pass' if passed else 'fail'})"
        self._write_text_to_container(task.container_id, "/tmp/xolvien_commit_msg.txt", commit_msg)
        no_changes_msg = "[GIT] No changes" if lang == "en" else "[GIT] 変更なし"
        _, commit_out, _ = self.docker_service.execute_command(
            task.container_id,
            f"git add -A && git diff --cached --quiet && echo '{no_changes_msg}' || git {_GIT_ID} commit -F /tmp/xolvien_commit_msg.txt",
            "/workspace/repo",
            user=AGENT_USER,
        )
        if commit_out.strip():
            yield f"[GIT] {commit_out.strip()}\n"

        task.status = TaskStatus.IDLE
        await db.commit()

        # Sprint 3: E2E completion means all test phases are done — generate
        # the specification and test report documents in the background.
        if test_type == TestType.E2E:
            try:
                spec_source, report_source = await self._build_test_doc_sources(
                    db, task_id, implementation_prompt, lang
                )
                schedule_generation(
                    task_id, task.container_id,
                    [("specification", spec_source), ("test_report", report_source)],
                    lang,
                )
            except Exception:
                pass  # document generation must never break the test flow

        if lang == "en":
            yield f"\n{tag} Report saved: {report_path}\n"
            yield f"\n[SYSTEM] Tests complete: {summary}\n"
        else:
            yield f"\n{tag} レポートを保存しました: {report_path}\n"
            yield f"\n[SYSTEM] テスト完了: {summary}\n"

    async def _build_test_doc_sources(
        self,
        db: AsyncSession,
        task_id: int,
        implementation_prompt: str,
        lang: str = "ja",
    ) -> tuple[str, str]:
        """
        Collect DB test data into the source-material strings for the
        specification and test report documents (Sprint 3).
        """
        items_q = await db.execute(
            sa_select(TestCaseItem)
            .where(TestCaseItem.task_id == task_id)
            .order_by(TestCaseItem.test_type, TestCaseItem.seq_no)
        )
        items = items_q.scalars().all()

        runs_q = await db.execute(
            sa_select(TestRun)
            .where(TestRun.task_id == task_id, TestRun.completed_at.isnot(None))
            .order_by(TestRun.id)
        )
        latest_run_by_type: dict = {}
        for run in runs_q.scalars().all():
            latest_run_by_type[run.test_type] = run  # ordered by id -> last wins

        run_ids = [r.id for r in latest_run_by_type.values()]
        results_by_item: dict = {}
        if run_ids:
            results_q = await db.execute(
                sa_select(TestCaseResult).where(TestCaseResult.test_run_id.in_(run_ids))
            )
            for r in results_q.scalars().all():
                results_by_item[r.test_case_item_id] = r

        # Specification source: the implemented behavior (prompt) + every test
        # case at specification level (input/operation/expected).
        spec_lines = [
            "### Implementation prompt", "", implementation_prompt, "",
            "### Test cases (tc_id | test item | operation | expected output)", "",
        ]
        for tc in items:
            spec_lines.append(
                f"- {tc.tc_id} | {tc.test_item} | {tc.operation or '-'} | {tc.expected_output or '-'}"
            )
        spec_source = "\n".join(spec_lines)

        # Test report source: latest run per type + per-case verdicts.
        report_lines = ["### Test runs (latest per type)", ""]
        for test_type, run in latest_run_by_type.items():
            type_name = test_type.value if hasattr(test_type, "value") else str(test_type)
            report_lines.append(
                f"- {type_name}: {'PASSED' if run.passed else 'FAILED'} | summary: {run.summary or '-'} "
                f"| completed_at: {run.completed_at}"
            )
        report_lines += ["", "### Per-case results (tc_id | test item | expected | actual | verdict | executed_at)", ""]
        for tc in items:
            r = results_by_item.get(tc.id)
            verdict = r.verdict.value if r and r.verdict else "-"
            actual = (r.actual_output or "-") if r else "-"
            executed = str(r.executed_at) if r else "-"
            report_lines.append(
                f"- {tc.tc_id} | {tc.test_item} | {tc.expected_output or '-'} | {actual} | {verdict} | {executed}"
            )
        report_source = "\n".join(report_lines)

        return spec_source, report_source

    def _extract_result_for_function(
        self, output: str, function_name: str | None, tc_id: str | None = None
    ) -> tuple[Verdict | None, str | None]:
        """
        Scan test output for a specific test and return (verdict, actual_output).

        Supports:
        - pytest verbose (-v): "tests/test_foo.py::test_tc001_xxx PASSED/FAILED"
          Failure detail block starts with "FAILED tests/...::function_name" in summary section;
          E-prefixed lines contain AssertionError details.
        - Jest (--verbose): "✓ TC-001: テスト名" (pass) / "✕ TC-001: テスト名" (fail)
          Failure detail block starts with "● TC-001: テスト名";
          "Expected:" / "Received:" lines contain assertion details.
        """
        import re as _re

        if not function_name and not tc_id:
            return None, None

        lines = output.splitlines()
        verdict: Verdict | None = None
        actual_lines: list[str] = []

        # ── Pass 1: determine verdict ────────────────────────────���────────────
        for line in lines:
            # pytest verbose: "path/test_foo.py::test_tc001_xxx PASSED  [ n%]"
            if function_name and function_name in line:
                if "PASSED" in line:
                    verdict = Verdict.PASSED
                elif "FAILED" in line:
                    verdict = Verdict.FAILED
                elif "ERROR" in line:
                    verdict = Verdict.ERROR
                elif "SKIPPED" in line:
                    verdict = Verdict.SKIPPED

            # Jest --verbose: "  ✓ TC-001: テスト名 (n ms)"  or "  ✕ TC-001: テスト名"
            if tc_id and (tc_id + ":") in line:
                if _re.search(r'[✓√]', line):
                    verdict = Verdict.PASSED
                elif _re.search(r'[✕×✗]', line):
                    verdict = Verdict.FAILED
                elif 'skip' in line.lower() or 'todo' in line.lower():
                    verdict = Verdict.SKIPPED

            # Playwright --reporter=list: "  ✓  N function_name (Xs)" or "  ✘  N function_name"
            if function_name and function_name in line:
                if _re.search(r'[✓√✔]', line):
                    verdict = Verdict.PASSED
                elif _re.search(r'[✘✗✕×]', line):
                    verdict = Verdict.FAILED

        if verdict is None:
            return None, None

        if verdict == Verdict.PASSED:
            # For passed tests, actual output = expected output (test confirmed it matches)
            return verdict, None

        # ── Pass 2: collect failure details ──────────────────────────────────
        in_block = False

        # Jest failure block: starts with "  ● TC-001: テスト名", ends at next "  ●" or blank+indented line
        if tc_id:
            for line in lines:
                stripped = line.strip()
                if stripped.startswith("●") and (tc_id + ":") in line:
                    in_block = True
                    continue
                if in_block:
                    # Next failure block or separator ends this block
                    if stripped.startswith("●") and (tc_id + ":") not in line:
                        break
                    if _re.match(r'^-{5,}$', stripped):
                        break
                    # Collect Expected/Received lines
                    if stripped.startswith("Expected:") or stripped.startswith("Received:"):
                        actual_lines.append(stripped)
                    # Also collect "Error:" type lines
                    elif stripped.startswith("Error:") or stripped.startswith("TypeError:"):
                        actual_lines.append(stripped)

        # pytest failure block: "E   AssertionError: ..." lines near function_name in short summary
        if function_name and not actual_lines:
            capture = False
            for line in lines:
                stripped = line.strip()
                if function_name in line and "FAILED" in line:
                    capture = True
                if capture and stripped.startswith("E "):
                    actual_lines.append(stripped[2:].strip())
                if capture and _re.match(r'^=+$', stripped):
                    break

        actual = "\n".join(actual_lines[:5]) if actual_lines else None
        return verdict, actual


# Singleton instance
from typing import Optional as Opt
_claude_service: Opt[ClaudeCodeService] = None


def get_claude_service() -> ClaudeCodeService:
    """Get or create Claude Code service instance."""
    global _claude_service
    if _claude_service is None:
        _claude_service = ClaudeCodeService()
    return _claude_service
