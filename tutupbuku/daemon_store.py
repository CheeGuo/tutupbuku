"""Postgres command mailbox and fenced filesystem checkpoint for one workspace.

The database is the shared control plane; daemon containers have no ingress or
persistent disk. A claimed command is never automatically replayed after loss
of its worker. In particular, a model request with an unknown outcome is not a
reason to spend the user's credits again.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .records import RecordStoreError, connection_settings

MAX_COMMAND_BYTES = 4 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 48 * 1024 * 1024
DEFAULT_LEASE_SECONDS = 45


class DaemonStoreError(Exception):
    def __init__(self, message: str, status: int = 503, code: str = "WORKER_STORAGE"):
        super().__init__(message)
        self.status = status
        self.code = code


class PostgresDaemonStore:
    def __init__(self, database_url: str, *, workspace: str = "default", max_posts_per_hour: int = 120):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", workspace):
            raise ValueError("Worker workspace must be a plain identifier of 1 to 64 characters.")
        try:
            self.url, self.schema = connection_settings(database_url)
        except RecordStoreError:
            raise DaemonStoreError("The database schema in DATABASE_URL is invalid.", 400, "WORKER_CONFIG") from None
        self.workspace = workspace
        self.max_posts_per_hour = max(1, int(max_posts_per_hour))

    def table(self, name: str) -> str:
        if name not in {"daemon_commands", "daemon_workspaces"}:
            raise ValueError("Unknown daemon table.")
        return f'"{self.schema}"."{name}"'

    @contextmanager
    def connection(self):
        import psycopg
        from psycopg.rows import dict_row
        try:
            with psycopg.connect(self.url, connect_timeout=5, prepare_threshold=None, row_factory=dict_row) as conn:
                conn.execute("set local statement_timeout = '15s'")
                conn.execute("set local lock_timeout = '5s'")
                yield conn
        except psycopg.Error as exc:
            # Driver diagnostics can contain SQL parameters, sources or secrets.
            raise DaemonStoreError("Worker storage is unavailable. Check its database connection and daemon migration.") from exc

    def initialize(self) -> None:
        source = Path(__file__).resolve().parents[1] / "prisma" / "daemon.sql"
        sql = source.read_text(encoding="utf-8").replace('"tutupbuku"', f'"{self.schema}"')
        with self.connection() as conn:
            conn.execute(sql, prepare=False)

    def acquire(self, owner: str, *, lease_seconds: int = DEFAULT_LEASE_SECONDS) -> bool:
        with self.connection() as conn:
            row = conn.execute(
                f"insert into {self.table('daemon_workspaces')} (workspace, owner, lease_until) "
                "values (%s, %s, now() + %s * interval '1 second') on conflict (workspace) do update "
                "set owner = excluded.owner, lease_until = excluded.lease_until, ready = false, updated_at = now() "
                f"where {self.table('daemon_workspaces')}.lease_until <= now() returning owner",
                (self.workspace, owner, lease_seconds),
            ).fetchone()
            if row is None:
                return False
            conn.execute(
                f"update {self.table('daemon_commands')} set status = 'unconfirmed', finished_at = now() "
                "where workspace = %s and status = 'running'", (self.workspace,),
            )
            return True

    def checkpoint(self, owner: str, snapshot: dict[str, str] | None = None, *, ready: bool = True,
                   lease_seconds: int = DEFAULT_LEASE_SECONDS) -> bool:
        from psycopg.types.json import Jsonb
        if snapshot is not None and len(json.dumps(snapshot).encode()) > MAX_CHECKPOINT_BYTES:
            raise DaemonStoreError("Workspace checkpoint exceeds its 48 MiB storage limit.", 413, "WORKSPACE_TOO_LARGE")
        with self.connection() as conn:
            return conn.execute(
                f"update {self.table('daemon_workspaces')} set snapshot = coalesce(%s, snapshot), ready = %s, "
                "lease_until = now() + %s * interval '1 second', updated_at = now() "
                "where workspace = %s and owner = %s and lease_until > now() returning owner",
                (Jsonb(snapshot) if snapshot is not None else None, ready, lease_seconds, self.workspace, owner),
            ).fetchone() is not None

    def release(self, owner: str) -> None:
        with self.connection() as conn:
            conn.execute(f"update {self.table('daemon_workspaces')} set ready = false, lease_until = now() "
                         "where workspace = %s and owner = %s", (self.workspace, owner))

    def restore(self) -> dict[str, str]:
        with self.connection() as conn:
            row = conn.execute(f"select snapshot from {self.table('daemon_workspaces')} where workspace = %s",
                               (self.workspace,)).fetchone()
            return row["snapshot"] if row else {}

    def health(self) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(f"select ready and lease_until > now() as online, updated_at "
                               f"from {self.table('daemon_workspaces')} where workspace = %s", (self.workspace,)).fetchone()
            return {"online": bool(row and row["online"]),
                    "updated_at": row["updated_at"].isoformat() if row else None}

    @staticmethod
    def public(job: dict[str, Any]) -> dict[str, Any]:
        return {"id": job["id"], "status": job["status"], "response": job.get("response"),
                "error": "Worker stopped before the outcome was confirmed. Inspect the saved execution before submitting again."
                if job["status"] == "unconfirmed" else None}

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            job = conn.execute(f"select * from {self.table('daemon_commands')} where workspace = %s and id = %s",
                               (self.workspace, job_id)).fetchone()
            return self.public(job) if job else None

    def submit(self, method: str, path: str, payload: dict | None = None, *, headers: dict | None = None,
               key: str | None = None) -> dict[str, Any]:
        from psycopg.types.json import Jsonb
        if method not in {"GET", "POST"} or not isinstance(path, str) or len(path) > 2048:
            raise DaemonStoreError("Invalid worker command.", 400, "COMMAND_INVALID")
        if key is not None and (not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key)):
            raise DaemonStoreError("Idempotency-Key is invalid.", 400, "COMMAND_INVALID")
        headers = {"Idempotency-Key": headers["Idempotency-Key"]} if headers and "Idempotency-Key" in headers else {}
        serialized = json.dumps([method, path, payload, headers], sort_keys=True, separators=(",", ":"))
        if len(serialized.encode()) > MAX_COMMAND_BYTES:
            raise DaemonStoreError("Worker request exceeds 4 MiB.", 413, "COMMAND_TOO_LARGE")
        fingerprint = hashlib.sha256(serialized.encode()).hexdigest()
        with self.connection() as conn:
            # Serialize acceptance, budgets and worker takeover for this workspace.
            worker = conn.execute(f"select ready and lease_until > now() as online "
                                  f"from {self.table('daemon_workspaces')} where workspace = %s for update",
                                  (self.workspace,)).fetchone()
            if key:
                previous = conn.execute(f"select * from {self.table('daemon_commands')} where workspace = %s and request_key = %s",
                                        (self.workspace, key)).fetchone()
                if previous:
                    if previous["fingerprint"] != fingerprint:
                        raise DaemonStoreError("This request key was already used for different input.", 409, "IDEMPOTENCY_CONFLICT")
                    return self.public(previous)
            if not worker or not worker["online"]:
                raise DaemonStoreError("The WorkBuddy worker is offline or not ready. No new command was submitted.", code="WORKER_OFFLINE")
            pending = conn.execute(f"select count(*) as count from {self.table('daemon_commands')} "
                                   "where workspace = %s and status = 'queued'", (self.workspace,)).fetchone()["count"]
            if pending >= 50:
                raise DaemonStoreError("The worker queue is full. Check existing jobs before submitting more.", 429, "QUEUE_FULL")
            if method == "POST":
                recent = conn.execute(f"select count(*) as count from {self.table('daemon_commands')} "
                                      "where workspace = %s and method = 'POST' and created_at > now() - interval '1 hour'",
                                      (self.workspace,)).fetchone()["count"]
                if recent >= self.max_posts_per_hour:
                    raise DaemonStoreError("The workspace command budget for this hour has been reached.", 429, "RATE_LIMITED")
            job_id = str(uuid.uuid4())
            row = conn.execute(f"insert into {self.table('daemon_commands')} "
                               "(id, workspace, method, path, payload, headers, request_key, fingerprint) "
                               "values (%s,%s,%s,%s,%s,%s,%s,%s) returning *",
                               (job_id, self.workspace, method, path, Jsonb(payload), Jsonb(headers), key, fingerprint)).fetchone()
            return self.public(row)

    def _assert_owner(self, conn, owner: str) -> None:
        if conn.execute(f"select owner from {self.table('daemon_workspaces')} where workspace = %s "
                        "and owner = %s and lease_until > now() for update", (self.workspace, owner)).fetchone() is None:
            raise DaemonStoreError("Worker lease was lost; this instance must stop.", 409, "LEASE_LOST")

    def claim(self, owner: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            self._assert_owner(conn, owner)
            row = conn.execute(f"select * from {self.table('daemon_commands')} where workspace = %s "
                               "and status = 'queued' order by created_at, id limit 1 for update skip locked",
                               (self.workspace,)).fetchone()
            if not row:
                return None
            conn.execute(f"update {self.table('daemon_commands')} set status = 'running', owner = %s where id = %s",
                         (owner, row["id"]))
            row["status"] = "running"
            return row

    def complete(self, owner: str, job_id: str, response: dict[str, Any], snapshot: dict[str, str]) -> None:
        from psycopg.types.json import Jsonb
        if len(json.dumps(snapshot).encode()) > MAX_CHECKPOINT_BYTES:
            raise DaemonStoreError("Workspace checkpoint exceeds its storage limit.", 413, "WORKSPACE_TOO_LARGE")
        if len(json.dumps(response).encode()) > 6 * 1024 * 1024:
            raise DaemonStoreError("Worker response exceeds its storage limit.", 413, "RESPONSE_TOO_LARGE")
        with self.connection() as conn:
            self._assert_owner(conn, owner)
            updated = conn.execute(f"update {self.table('daemon_commands')} set status = 'completed', "
                                   "response = %s, finished_at = now() where workspace = %s and id = %s "
                                   "and owner = %s and status = 'running' returning id",
                                   (Jsonb(response), self.workspace, job_id, owner)).fetchone()
            if updated is None:
                raise DaemonStoreError("Command ownership changed; its outcome must be reconciled.", 409, "LEASE_LOST")
            conn.execute(f"update {self.table('daemon_workspaces')} set snapshot = %s, updated_at = now() "
                         "where workspace = %s and owner = %s", (Jsonb(snapshot), self.workspace, owner))

    def prune(self) -> None:
        """Keep mutation idempotency for seven days; short-lived GET mailboxes for an hour."""
        with self.connection() as conn:
            conn.execute(f"delete from {self.table('daemon_commands')} where workspace = %s "
                         "and ((method = 'GET' and created_at < now() - interval '1 hour') "
                         "or (status in ('completed','unconfirmed') and created_at < now() - interval '7 days'))",
                         (self.workspace,))

    def mark_unconfirmed(self, owner: str, job_id: str) -> None:
        with self.connection() as conn:
            self._assert_owner(conn, owner)
            conn.execute(f"update {self.table('daemon_commands')} set status = 'unconfirmed', finished_at = now() "
                         "where workspace = %s and id = %s and owner = %s and status = 'running'",
                         (self.workspace, job_id, owner))
