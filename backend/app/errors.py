"""Cause-based error codes and helpers.

A single source of truth for the error taxonomy shared across the app. Non-
streaming responses are standardized to ``{code, message, detail}`` via the
FastAPI exception handlers in ``main.py``; streaming endpoints emit a terminal
sentinel line (see ``error_sentinel_line``) carrying the same code.

The raw exception text (``detail``) is intended for logs only — the frontend
never shows it in the error banner; it looks up human-friendly copy by ``code``.
"""
from __future__ import annotations

import re
from enum import Enum


class ErrorCode(str, Enum):
    """Cause-based classification of failures surfaced to the user."""

    CONTAINER_NOT_RUNNING = "CONTAINER_NOT_RUNNING"
    TIMEOUT = "TIMEOUT"
    CLAUDE_API_ERROR = "CLAUDE_API_ERROR"
    CLAUDE_PERMISSION_LOOP = "CLAUDE_PERMISSION_LOOP"
    GIT_AUTH_FAILED = "GIT_AUTH_FAILED"
    GIT_PUSH_REJECTED = "GIT_PUSH_REJECTED"
    TEST_INFRA_ERROR = "TEST_INFRA_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"
    UNKNOWN = "UNKNOWN"


class XolvienError(Exception):
    """A typed application error carrying an :class:`ErrorCode`.

    Raise this from services/handlers when the cause is known so the precise
    code reaches the client without relying on string heuristics.
    """

    def __init__(self, code: ErrorCode, detail: str = "", status: int = 400):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


# Ordered (cause, pattern) rules. First match wins. Patterns mirror the
# frontend classifier in ``frontend/src/errors.ts`` — keep the two in sync.
_RULES: list[tuple[ErrorCode, re.Pattern[str]]] = [
    (ErrorCode.TIMEOUT, re.compile(r"timed out|timeout|no output for", re.I)),
    (ErrorCode.CONTAINER_NOT_RUNNING,
     re.compile(r"not running|no container|container .* not found|did not start", re.I)),
    (ErrorCode.CLAUDE_PERMISSION_LOOP,
     re.compile(r"repeated .* times|aborting to prevent infinite loop", re.I)),
    (ErrorCode.GIT_AUTH_FAILED,
     re.compile(r"authentication failed|could not read username|permission denied \(publickey\)|fatal: could not read", re.I)),
    (ErrorCode.GIT_PUSH_REJECTED,
     re.compile(r"\[rejected\]|non-fast-forward|failed to push|updates were rejected", re.I)),
    (ErrorCode.TEST_INFRA_ERROR,
     re.compile(r"EACCES|EPERM|ENOENT|ENOSPC|cannot find module|command not found", re.I)),
    (ErrorCode.CLAUDE_API_ERROR,
     re.compile(r"anthropic|claude api|rate limit|overloaded|api error|\b529\b|\b429\b", re.I)),
]


def classify_exception(exc: Exception, status: int = 500) -> ErrorCode:
    """Best-effort mapping of an arbitrary exception to an :class:`ErrorCode`."""
    if isinstance(exc, XolvienError):
        return exc.code
    text = str(exc) or ""
    for code, pattern in _RULES:
        if pattern.search(text):
            return code
    return ErrorCode.UNKNOWN


def classify_text(text: str) -> ErrorCode:
    """Classify a raw text blob (e.g. streamed git output) to an error code."""
    for code, pattern in _RULES:
        if pattern.search(text or ""):
            return code
    return ErrorCode.UNKNOWN


def error_payload(code: ErrorCode, message: str, detail: str = "") -> dict:
    """Standard JSON error body for non-streaming responses."""
    return {"code": code.value, "message": message, "detail": detail}


def error_sentinel_line(code: ErrorCode, detail: str = "") -> str:
    """Terminal line appended to a stream when it aborts with an error.

    Frontend strips any line matching ``[[XOLVIEN_ERROR:CODE]]`` and routes the
    code to the error banner; the trailing detail is kept for the log pane only.
    """
    return f"\n[[XOLVIEN_ERROR:{code.value}]] {detail}\n"
