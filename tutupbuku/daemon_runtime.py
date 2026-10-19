"""Ephemeral, isolated copy of the existing TutupBuku HTTP workflow.

Only explicitly allow-listed runtime files are checkpointed. Account
credentials and the CLI home directory are never part of this workspace.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import shutil
import tempfile
import threading
from pathlib import Path, PurePosixPath
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .daemon_api import validate_target

MAX_FILES = 3000
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024
MAX_RESPONSE_BYTES = 3 * 1024 * 1024
_ALLOWED_TOP_LEVEL = {"fixtures", ".tutupbuku-job-state"}


class RuntimeErrorSafe(RuntimeError):
    """A sanitized runtime failure suitable for worker handling."""


def _safe_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or "\\" in value or "\x00" in value:
        raise ValueError("Checkpoint path is invalid.")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Checkpoint path is invalid.")
    if path.parts[0] not in _ALLOWED_TOP_LEVEL and not (
        len(path.parts) >= 2 and path.parts[0].startswith("review_pack_")
    ):
        raise ValueError("Checkpoint path is outside the runtime data allow-list.")
    return path


def restore_files(state_root: Path, files: Mapping[str, str]) -> None:
    """Restore a validated DB checkpoint before services or agents start."""
    root = Path(state_root).resolve()
    if not isinstance(files, Mapping) or len(files) > MAX_FILES:
        raise ValueError("Workspace checkpoint has too many files.")
    total = 0
    for relative, encoded in files.items():
        path = _safe_relative(relative)
        if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE_BYTES + 2) // 3) * 4:
            raise ValueError("Workspace checkpoint contains an oversized file.")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Workspace checkpoint contains an invalid file.") from exc
        if len(content) > MAX_FILE_BYTES:
            raise ValueError("Workspace checkpoint contains an oversized file.")
        total += len(content)
        if total > MAX_SNAPSHOT_BYTES:
            raise ValueError("Workspace checkpoint exceeds its size limit.")
        destination = root.joinpath(*path.parts)
        resolved_parent = destination.parent.resolve()
        if not resolved_parent.is_relative_to(root):
            raise ValueError("Workspace checkpoint path escapes its root.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            raise ValueError("Workspace checkpoint cannot replace a symbolic link.")
        destination.write_bytes(content)


class LocalRuntime:
    """Run the current app services on loopback against an ephemeral workspace."""

    def __init__(self, source_root: Path, state_root: Path, client: Any | None, *, synchronous: bool = False) -> None:
        self.source_root = Path(source_root).resolve()
        self.state_root = Path(state_root).resolve()
        self.client = client
        self.synchronous = synchronous
        self._server = None
        self._thread: threading.Thread | None = None
        self._service = None
        self._executions = None
        self._lock = threading.RLock()

    def _copy_trusted_inputs(self) -> None:
        baseline = self.source_root / "demo-fixtures"
        local_baseline = self.state_root / "demo-fixtures"
        if not local_baseline.exists():
            if not baseline.is_dir():
                raise RuntimeErrorSafe("The synthetic demo baseline is missing from the worker image.")
            shutil.copytree(baseline, local_baseline)
        fixtures = self.state_root / "fixtures"
        if not fixtures.exists():
            shutil.copytree(local_baseline, fixtures)
        for relative in ("skills", ".codebuddy/skills/tutupbuku"):
            source = self.source_root / relative
            destination = self.state_root / relative
            if not destination.exists():
                if not source.is_dir():
                    raise RuntimeErrorSafe("A required trusted agent instruction is missing from the worker image.")
                shutil.copytree(source, destination)

    def start(self) -> None:
        with self._lock:
            if self._server is not None:
                return
            self.state_root.mkdir(parents=True, exist_ok=True)
            self._copy_trusted_inputs()

            from .agents import AgentOrchestrator
            from .execution import ExecutionManager
            from .records import build_record_store
            from .service import TutupBukuService
            from .web import create_server

            self._service = TutupBukuService(self.state_root, "Sept2026", fixtures_root=self.state_root / "fixtures")
            reviewer = AgentOrchestrator(self.state_root, self.client) if self.client is not None else None
            self._executions = ExecutionManager(
                self._service,
                reviewer=reviewer,
                state_file=self.state_root / ".tutupbuku-job-state" / "executions.json",
                synchronous=self.synchronous,
            )
            # Persist recovery normalization: an interrupted run is failed and
            # visible after replacement; it is never replayed automatically.
            self._executions._save()
            records = build_record_store(dict(os.environ), self.state_root)
            self._server = create_server(
                self._service,
                "127.0.0.1",
                0,
                executions=self._executions,
                records=records,
            )
            self._thread = threading.Thread(target=self._server.serve_forever, name="tutupbuku-daemon-api", daemon=True)
            self._thread.start()

    def handle(self, method: str, path: str, payload: dict | None, headers: dict | None = None) -> dict[str, Any]:
        """Call the existing local route; return its original status and bytes."""
        if self._server is None:
            raise RuntimeErrorSafe("The local workflow is not ready.")
        try:
            validate_target(method, path)
        except ValueError:
            return {"status": 400, "headers": {"Content-Type": "application/json"},
                    "body": base64.b64encode(b'{"error":"Worker route is not allowed."}').decode("ascii")}
        body = None if method == "GET" else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        outgoing = {"Accept": "application/json, application/octet-stream", "Connection": "close"}
        if body is not None:
            outgoing["Content-Type"] = "application/json"
        if headers and isinstance(headers.get("Idempotency-Key"), str):
            outgoing["Idempotency-Key"] = headers["Idempotency-Key"]
        target = f"http://127.0.0.1:{self._server.server_port}{path}"
        request = Request(target, data=body, headers=outgoing, method=method)
        try:
            response = urlopen(request, timeout=1800)
        except HTTPError as exc:
            response = exc
        except (URLError, OSError, TimeoutError):
            raise RuntimeErrorSafe("The local workflow did not return a confirmed response.") from None
        try:
            content = response.read(MAX_RESPONSE_BYTES + 1)
            if len(content) > MAX_RESPONSE_BYTES:
                content = b'{"error":"This file exceeds the worker download size limit."}'
                result_headers = {"Content-Type": "application/json"}
                return {"status": 413, "headers": result_headers,
                        "body": base64.b64encode(content).decode("ascii")}
            result_headers = {}
            for name in ("Content-Type", "Content-Disposition"):
                value = response.headers.get(name)
                if value is not None and "\r" not in value and "\n" not in value:
                    result_headers[name] = value
            return {"status": int(response.status), "headers": result_headers,
                    "body": base64.b64encode(content).decode("ascii")}
        finally:
            response.close()

    def snapshot(self) -> dict[str, str]:
        """Capture mutable files while holding the workflow's state locks."""
        with self._lock:
            if self._server is None:
                raise RuntimeErrorSafe("The local workflow is not ready for checkpointing.")
            locks = []
            if self._executions is not None:
                locks.append(self._executions._lock)
            if self._service is not None:
                locks.append(self._service._lock)
                locks.extend(engine._lock for engine in self._service._engines.values())
            for lock in locks:
                lock.acquire()
            try:
                files: dict[str, str] = {}
                total = 0
                for top in sorted(self.state_root.iterdir(), key=lambda item: item.name):
                    if top.name not in _ALLOWED_TOP_LEVEL and not top.name.startswith("review_pack_"):
                        continue
                    if top.is_symlink():
                        raise RuntimeErrorSafe("A symbolic link was found in mutable worker state.")
                    candidates = [top] if top.is_file() else sorted(top.rglob("*"), key=lambda item: item.as_posix())
                    for path in candidates:
                        if path.is_dir():
                            continue
                        if path.name.startswith(".") and path.suffix == ".tmp":
                            continue
                        if path.is_symlink() or not path.is_file():
                            raise RuntimeErrorSafe("A non-regular file was found in mutable worker state.")
                        relative = path.relative_to(self.state_root).as_posix()
                        _safe_relative(relative)
                        content = path.read_bytes()
                        if len(content) > MAX_FILE_BYTES:
                            raise RuntimeErrorSafe("A mutable worker file exceeds its checkpoint size limit.")
                        total += len(content)
                        if len(files) >= MAX_FILES or total > MAX_SNAPSHOT_BYTES:
                            raise RuntimeErrorSafe("The worker checkpoint exceeds its size limit.")
                        files[relative] = base64.b64encode(content).decode("ascii")
                return files
            finally:
                for lock in reversed(locks):
                    lock.release()

    def stop(self) -> None:
        with self._lock:
            server, self._server = self._server, None
            thread, self._thread = self._thread, None
            if server is None:
                return
            server.shutdown()
            server.server_close()
            if thread is not None:
                thread.join(timeout=5)

    def __enter__(self) -> "LocalRuntime":
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()
