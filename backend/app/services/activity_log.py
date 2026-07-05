"""Persistent file logging of the left-pane activity stream (roadmap 4.1).

Everything the left pane shows — the raw stream-json lines from Claude Code
CLI, `[SYSTEM]`/`[GIT]` lines, and terminal `[[XOLVIEN_ERROR:CODE]]` sentinels —
is appended verbatim to a host file for later review, one file per streamed
execution:

    {activity_log_path}/tasks/{task_id}/{flow}_{YYYYMMDD_HHMMSS}.log

Each completed line is prefixed with an ISO 8601 timestamp: `[{ISO8601}] {line}`.
The 15-second `{"type": "_xolvien_keepalive"}` lines are skipped — the left
pane filters them out too, and they would only bloat the file.

Writing must never break the user-facing stream: any filesystem error disables
the logger for the rest of the execution and the stream continues.
"""
import logging
import os
from datetime import datetime

import aiofiles

from app.config import get_settings

logger = logging.getLogger(__name__)

_KEEPALIVE_MARKER = '"_xolvien_keepalive"'


class ActivityLog:
    """Appends one streamed execution's chunks to a timestamped log file.

    Chunks may contain partial lines; they are buffered and written only when
    complete, so each file line is exactly one stream line. Call `close()` in
    a finally block to flush a trailing partial line and release the file.
    """

    def __init__(self, task_id: int, flow: str):
        started = datetime.now()
        self._dir = os.path.join(
            get_settings().activity_log_path, "tasks", str(task_id)
        )
        self.path = os.path.join(
            self._dir, f"{flow}_{started.strftime('%Y%m%d_%H%M%S')}.log"
        )
        self._file = None
        self._pending = ""
        self._disabled = False

    async def write(self, chunk: str) -> None:
        if self._disabled or not chunk:
            return
        try:
            self._pending += chunk
            *lines, self._pending = self._pending.split("\n")
            lines = [l for l in lines if _KEEPALIVE_MARKER not in l]
            if lines:
                await self._write_lines(lines)
        except Exception:
            self._disabled = True
            logger.warning("Activity log write failed: %s", self.path, exc_info=True)

    async def close(self) -> None:
        try:
            if not self._disabled and self._pending and _KEEPALIVE_MARKER not in self._pending:
                await self._write_lines([self._pending])
            self._pending = ""
        except Exception:
            logger.warning("Activity log flush failed: %s", self.path, exc_info=True)
        finally:
            if self._file is not None:
                try:
                    await self._file.close()
                except Exception:
                    pass
                self._file = None

    async def _write_lines(self, lines: list) -> None:
        if self._file is None:
            os.makedirs(self._dir, exist_ok=True)
            self._file = await aiofiles.open(self.path, "a", encoding="utf-8")
        stamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
        await self._file.write("".join(f"[{stamp}] {l}\n" for l in lines))
        await self._file.flush()
