"""Automatic document generation (Sprint 3, step 3.3 — YAML only, no renderer).

Generates the five document types as YAML conforming to docs/document-format.md
by running Claude Code CLI inside the task container, validates against the
JSON Schema (retrying with error feedback), and saves each generation to the
host at:

    {document_data_path}/tasks/{task_id}/{doc_type}_{YYYYMMDD_HHMMSS}.yaml

Generation runs in fire-and-forget background asyncio tasks scheduled from the
user flows (see `schedule_generation`) so it never blocks or delays streamed
responses. The docgen runner uses its own /tmp file names inside the container
so a concurrent user-facing Claude run is never disturbed.
"""
import asyncio
import base64
import logging
import os
from datetime import datetime
from typing import List, Optional

import yaml

from app.config import get_settings
from app.services.docker_service import get_docker_service
from app.services.document_format import extract_yaml_document, validate_document

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 3

# Runs claude non-interactively as the xolvien user and prints the raw text
# response. Separate prompt/runner file names from the user-flow runner so the
# two can never clobber each other.
_DOCGEN_RUNNER = """\
import subprocess, sys, os, pwd

prompt = open('/tmp/xolvien_docgen_prompt.txt', encoding='utf-8').read()
try:
    pw = pwd.getpwnam('xolvien')
    uid, gid, home = pw.pw_uid, pw.pw_gid, pw.pw_dir
except KeyError:
    uid = gid = None
    home = '/root'

env = {**os.environ, 'HOME': home}
preexec = None
if uid is not None:
    def drop_privs():
        os.setgroups([gid])
        os.setgid(gid)
        os.setuid(uid)
    preexec = drop_privs

proc = subprocess.run(
    ['claude', '--dangerously-skip-permissions', '-p', prompt,
     '--output-format', 'text'],
    capture_output=True, env=env, cwd='/workspace/repo', preexec_fn=preexec,
)
sys.stdout.buffer.write(proc.stdout)
sys.stderr.buffer.write(proc.stderr)
sys.exit(proc.returncode)
"""

# Compact, prompt-embeddable summary of document-format.md. The full JSON
# Schema stays server-side; validation errors are fed back on retry.
_FORMAT_RULES = """\
Output EXACTLY ONE fenced code block (```yaml ... ```) and nothing else outside it.
The YAML must follow this structure:

format_version: 1
doc_type: {doc_type}
title: "<document title>"
language: {lang}
sections:            # chapters; nesting depth at most 3 (1. / 1.1 / 1.1.1)
  - title: "<chapter title WITHOUT a number>"
    page_break_before: true   # optional; start this chapter on a new page
    blocks:          # ordered content; any mix of the 7 block types below
      - type: text
        content: "plain text; blank line separates paragraphs; NO markdown"
      - type: table
        caption: "optional"
        header: ["col", ...]
        rows: [["cell", ...], ...]
      - type: list
        style: bullet   # or number
        items: ["item", {text: "item", children: ["sub-item", ...]}]
      - type: figure
        format: mermaid
        caption: "optional"
        code: "valid mermaid source"
      - type: image
        path: "path relative to /workspace/repo"
        caption: "optional"
      - type: code
        language: "python"   # optional
        caption: "optional"
        content: "source code verbatim"
      - type: note
        style: warning   # info | warning | important
        content: "supplementary note or caution"
    sections: [...]  # optional child sections, same shape

Table details:
- A cell is a scalar, or an object to merge cells:
  {value: "Input", rowspan: 3} spans 3 rows downward; {value: "Basics", colspan: 2}
  spans 2 columns. Rows under a rowspan OMIT the spanned cell entirely.
- header may be a list of column names, or a list of rows for a 2-tier header:
  header:
    - [{value: "Basics", colspan: 2}, {value: "Validation", colspan: 2}]
    - ["Name", "Type", "Constraint", "Description"]
- row_header_cols: 1 renders the leftmost column(s) as row headers
  (use for item-name/value tables).
- A row must never occupy more columns than the table grid.

Rules:
- Section titles carry no numbers (numbering is added when rendering).
- text content is plain text only — no markdown, no HTML.
- Use image blocks ONLY for image files that actually exist in the repository.
- Do NOT include the optional top-level cover/revisions fields — the platform
  manages that metadata.
- Do not invent facts; base everything on the source material provided.
"""


def _outline(doc_type: str, lang: str) -> str:
    """Expected chapter outline per doc type (spec.md section 6.2)."""
    en = {
        "requirements": (
            "Expected chapters: overview/background, functional requirements "
            "(feature list), screens and screen transitions, use cases, "
            "non-functional requirements (only if any)."
        ),
        "external_design": (
            "Expected chapters: screen design (layout, fields, buttons, validation "
            "per screen), operation flows (user action to system response), API list "
            "(endpoint, method, request/response), external integrations (only if any)."
        ),
        "internal_design": (
            "Expected chapters: database design (tables, columns, types, constraints, "
            "relationships), class/module design (names, responsibilities, dependencies), "
            "method design (signatures, arguments, return values, processing summary)."
        ),
        "specification": (
            "Expected chapters: one chapter per functional area; each behavior stated "
            "at minimum unit as input, operation, and expected result, in tables where "
            "possible, each item linked to its test case ID (TC-NNN / ITC-NNN / E2E-NNN)."
        ),
        "test_report": (
            "Expected chapters: test execution summary (passed/failed counts per test "
            "type), then per-type result tables with TC-ID, test item, expected output, "
            "actual output, verdict, executed at."
        ),
    }
    ja = {
        "requirements": "章立て: 概要・背景、機能要件（機能一覧）、画面と画面遷移、ユースケース、非機能要件（あれば）。",
        "external_design": "章立て: 画面設計（画面ごとのレイアウト・項目・ボタン・バリデーション）、操作フロー（ユーザー操作→システム応答）、API一覧（エンドポイント・メソッド・リクエスト/レスポンス）、外部連携（あれば）。",
        "internal_design": "章立て: DB設計（テーブル・カラム・型・制約・リレーション）、クラス/モジュール設計（名前・責務・依存関係）、メソッド設計（シグネチャ・引数・戻り値・処理概要）。",
        "specification": "章立て: 機能領域ごとに1章。各動作を最小単位（入力値→操作→期待結果）で、可能な限り表で記述し、各項目をテストケースID（TC-NNN / ITC-NNN / E2E-NNN）に紐付ける。",
        "test_report": "章立て: テスト実行サマリ（種別ごとの成功/失敗件数）、続いて種別ごとの結果表（TC-ID・テスト項目・期待出力・実際の出力・判定・実行日時）。",
    }
    return (en if lang == "en" else ja)[doc_type]


def _role(doc_type: str, lang: str) -> str:
    en = {
        "requirements": "You are a requirements analyst. Write the requirements definition document for the project below.",
        "external_design": "You are a software architect. Write the external (basic) design document for the implementation in /workspace/repo. Read the actual code first.",
        "internal_design": "You are a software architect. Write the internal (detailed) design document for the implementation in /workspace/repo. Read the actual code first.",
        "specification": "You are a QA engineer. Write the specification document covering every implemented behavior.",
        "test_report": "You are a QA engineer. Write the test report document from the test results below. Use the provided data verbatim; do not re-run anything.",
    }
    ja = {
        "requirements": "あなたは要件アナリストです。以下のプロジェクトの要件定義書を作成してください。",
        "external_design": "あなたはソフトウェアアーキテクトです。/workspace/repo の実装の外部（基本）設計書を作成してください。まず実際のコードを読むこと。",
        "internal_design": "あなたはソフトウェアアーキテクトです。/workspace/repo の実装の内部（詳細）設計書を作成してください。まず実際のコードを読むこと。",
        "specification": "あなたはQAエンジニアです。実装されたすべての動作を網羅する仕様書を作成してください。",
        "test_report": "あなたはQAエンジニアです。以下のテスト結果からテスト報告書を作成してください。提供されたデータをそのまま使い、テストを再実行しないこと。",
    }
    return (en if lang == "en" else ja)[doc_type]


class DocumentService:
    """Generates and stores document YAML files."""

    def __init__(self):
        self.docker_service = get_docker_service()

    # ── storage ────────────────────────────────────────────────────────────

    def task_document_dir(self, task_id: int) -> str:
        return os.path.join(get_settings().document_data_path, "tasks", str(task_id))

    def _save(self, task_id: int, doc_type: str, yaml_text: str) -> str:
        doc_dir = self.task_document_dir(task_id)
        os.makedirs(doc_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(doc_dir, f"{doc_type}_{ts}.yaml")
        with open(path, "w", encoding="utf-8") as f:
            f.write(yaml_text if yaml_text.endswith("\n") else yaml_text + "\n")
        return path

    # ── generation ─────────────────────────────────────────────────────────

    def _build_prompt(self, doc_type: str, source_material: str, lang: str) -> str:
        header = _role(doc_type, lang)
        outline = _outline(doc_type, lang)
        # str.replace, not str.format — the template contains literal YAML braces.
        rules = _FORMAT_RULES.replace("{doc_type}", doc_type).replace("{lang}", lang)
        source_label = "## Source material" if lang == "en" else "## 元情報"
        format_label = "## Output format (mandatory)" if lang == "en" else "## 出力形式（厳守）"
        lang_note = (
            "Write all document content in English."
            if lang == "en" else "ドキュメントの内容はすべて日本語で書いてください。"
        )
        return (
            f"{header}\n{outline}\n{lang_note}\n\n"
            f"{source_label}\n\n{source_material}\n\n"
            f"{format_label}\n\n{rules}"
        )

    def _run_claude(self, container_id: str, prompt: str) -> str:
        """Write docgen prompt+runner into the container and run it (blocking)."""
        for path, content in (
            ("/tmp/xolvien_docgen_prompt.txt", prompt),
            ("/tmp/xolvien_docgen_runner.py", _DOCGEN_RUNNER),
        ):
            b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
            cmd = (
                f"python3 -c \""
                f"import base64; "
                f"open('{path}', 'w', encoding='utf-8')"
                f".write(base64.b64decode('{b64}').decode('utf-8'))\""
            )
            self.docker_service.execute_command(container_id, cmd, "/workspace")
        _, output, _ = self.docker_service.execute_command(
            container_id, "python3 /tmp/xolvien_docgen_runner.py", "/workspace/repo"
        )
        return output

    async def generate_document(
        self,
        task_id: int,
        container_id: str,
        doc_type: str,
        source_material: str,
        lang: str = "ja",
    ) -> Optional[str]:
        """
        Generate one document and save it. Returns the saved file path, or
        None when generation failed after all attempts (logged, never raised —
        document generation must not break the user flow that scheduled it).
        """
        prompt = self._build_prompt(doc_type, source_material, lang)
        feedback = ""
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                output = await asyncio.to_thread(
                    self._run_claude, container_id, prompt + feedback
                )
                yaml_text = extract_yaml_document(output)
                if not yaml_text:
                    raise ValueError("response contained no YAML")
                data = yaml.safe_load(yaml_text)
                errors = validate_document(data)
                if errors:
                    raise ValueError("; ".join(errors))
                path = self._save(task_id, doc_type, yaml_text)
                logger.info("Generated document %s (attempt %d): %s", doc_type, attempt, path)
                return path
            except Exception as e:
                logger.warning(
                    "Document generation failed (task %s, %s, attempt %d/%d): %s",
                    task_id, doc_type, attempt, _MAX_ATTEMPTS, e,
                )
                feedback = (
                    "\n\n## Previous attempt was rejected\n\n"
                    f"Fix these problems and output the corrected YAML:\n{e}\n"
                )
        return None

    async def _generate_many(
        self, task_id: int, container_id: str, jobs: List[tuple], lang: str
    ) -> None:
        # Sequential on purpose: one extra claude process in the container at a
        # time keeps CPU contention with any concurrent user run acceptable.
        for doc_type, source_material in jobs:
            await self.generate_document(task_id, container_id, doc_type, source_material, lang)


# Keep strong references so fire-and-forget tasks are not garbage-collected.
_background_tasks: set = set()


def schedule_generation(
    task_id: int,
    container_id: str,
    jobs: List[tuple],
    lang: str = "ja",
) -> None:
    """
    Fire-and-forget generation of one or more documents.

    jobs: list of (doc_type, source_material) tuples, generated sequentially.
    Never raises; the caller's stream continues immediately.
    """
    try:
        service = get_document_service()
        task = asyncio.create_task(service._generate_many(task_id, container_id, jobs, lang))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    except Exception:
        logger.warning("Failed to schedule document generation", exc_info=True)


_document_service: Optional[DocumentService] = None


def get_document_service() -> DocumentService:
    global _document_service
    if _document_service is None:
        _document_service = DocumentService()
    return _document_service
