"""Storage for the workspace records shown on Documents and Action Items.

The tables are defined by prisma/schema.prisma (Supabase Postgres, schema `tutupbuku`). When DATABASE_URL
is set, the backend reads and writes them directly over Postgres (psycopg). Without it, the records are
kept in a JSON file on this server and the API says so. The browser never sees database credentials.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

KINDS = ("docs", "links", "claims", "issues", "audit")
MAX_RECORDS = 5000
ID_RE = re.compile(r"^[A-Za-z0-9_.:/-]{1,128}$")
RETRY_AFTER_SECONDS = 60  # after a failed connection, answer "unreachable" at once for this long
SETUP_HINT = "Create the tables with `npm run db:push`, or paste prisma/init.sql into the Supabase SQL editor."


class RecordStoreError(Exception):
    def __init__(self, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.status = status


def _empty() -> dict[str, list]:
    return {name: [] for name in KINDS}


def validate_records(value: Any) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(value, dict) or set(value) != set(KINDS):
        raise RecordStoreError("records must contain exactly: " + ", ".join(KINDS), 400)
    total = 0
    for name in KINDS:
        items = value[name]
        if not isinstance(items, list):
            raise RecordStoreError(f"records.{name} must be a list", 400)
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not ID_RE.fullmatch(item["id"]):
                raise RecordStoreError(f"every item in records.{name} needs a valid string id", 400)
            if item["id"] in seen:
                raise RecordStoreError(f"duplicate id {item['id']} in records.{name}", 400)
            seen.add(item["id"])
        total += len(items)
    if total > MAX_RECORDS:
        raise RecordStoreError(f"too many records ({total} > {MAX_RECORDS})", 400)
    return value


# ---- row <-> frontend object mapping (columns follow prisma/schema.prisma) ---------------------------
# (frontend key, column, optional) ; optional keys are omitted from the object when the column is NULL/empty.
COLUMNS = {
    "docs": ("documents", [("id", "id", False), ("docType", "doc_type", False), ("flow", "flow", False), ("filename", "filename", False),
                           ("fields", "fields", False), ("lines", "lines", False), ("status", "status", False), ("hash", "hash", False),
                           ("version", "version", False), ("uploadedAt", "uploaded_at", False), ("uploadedBy", "uploaded_by", False),
                           ("note", "note", True), ("sourceUrl", "source_url", True)]),
    "links": ("document_links", [("id", "id", False), ("sourceId", "source_id", False), ("targetId", "target_id", False),
                                 ("relationship", "relationship", False), ("confidence", "confidence", False), ("confirmedBy", "confirmed_by", False)]),
    "claims": ("claims", [("id", "id", False), ("employee", "employee", False), ("receiptDocId", "receipt_doc_id", False),
                          ("employeePurpose", "employee_purpose", False), ("categoryCode", "category_code", False),
                          ("categoryConfidence", "category_confidence", False), ("categoryReasoning", "category_reasoning", False),
                          ("alternativeCodes", "alternative_codes", False), ("standardizedDescription", "standardized_description", False),
                          ("findings", "findings", False), ("status", "status", False), ("decision", "decision", True)]),
    "issues": ("issues", [("id", "id", False), ("ruleCode", "rule_code", False), ("typeLabel", "type_label", False), ("title", "title", False),
                          ("severity", "severity", False), ("status", "status", False), ("docIds", "doc_ids", False), ("claimId", "claim_id", True),
                          ("fieldKey", "field_key", True), ("candidateIds", "candidate_ids", True), ("detected", "detected", False),
                          ("why", "why", False), ("suggested", "suggested", False), ("evidence", "evidence", False),
                          ("createdAt", "created_at", False), ("resolution", "resolution", True)]),
    "audit": ("audit_entries", [("id", "id", False), ("timestamp", "timestamp", False), ("actor", "actor", False), ("actorKind", "actor_kind", False),
                                ("action", "action", False), ("entityId", "entity_id", False), ("previous", "previous", True), ("next", "next", True)]),
}
ENUMS = {("docs", "doc_type"): "DocType", ("docs", "flow"): "Flow", ("docs", "status"): "DocStatus",
         ("links", "relationship"): "LinkRelationship", ("claims", "status"): "ClaimStatus",
         ("issues", "severity"): "Severity", ("issues", "status"): "IssueStatus", ("audit", "actor_kind"): "ActorKind"}
JSON_COLUMNS = {("docs", "fields"), ("docs", "lines"), ("claims", "decision"), ("issues", "evidence")}
ARRAY_COLUMNS = {("claims", "alternative_codes"), ("claims", "findings"), ("issues", "doc_ids"), ("issues", "candidate_ids"), ("issues", "suggested")}
DEFAULTS = {("docs", "fields"): [], ("docs", "lines"): [], ("docs", "version"): 1, ("issues", "evidence"): []}


def row_to_object(kind: str, row: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {}
    for key, column, optional in COLUMNS[kind][1]:
        value = row.get(column)
        if optional and (value is None or value == []):
            continue
        item[key] = value
    return item


def object_to_params(kind: str, item: dict[str, Any]) -> list[Any]:
    from psycopg.types.json import Jsonb

    params = []
    for key, column, optional in COLUMNS[kind][1]:
        value = item.get(key, DEFAULTS.get((kind, column)))
        if (kind, column) in ARRAY_COLUMNS:
            value = [str(v) for v in (value or [])]
        elif (kind, column) in JSON_COLUMNS:
            value = Jsonb(value) if value is not None else None
        params.append(value)
    return params


class LocalRecords:
    """JSON file on this server; used only when DATABASE_URL is not configured."""

    mode = "local"

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def status(self) -> dict[str, Any]:
        return {"mode": self.mode, "ok": True, "message": "No database is configured; records are saved in a file on this server."}

    def _read(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"version": 0, "records": _empty()}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RecordStoreError(f"saved records file is unreadable: {exc}") from exc
        return {"version": int(value.get("version", 0)), "records": value.get("records") or _empty()}

    def load(self) -> dict[str, Any]:
        with self._lock:
            return self._read()

    def save(self, records: dict[str, list], expected_version: Any) -> int:
        records = validate_records(records)
        with self._lock:
            current = self._read()["version"]
            if expected_version != current:
                raise RecordStoreError("The records changed since this page loaded them. Reload to see the latest.", 409)
            version = current + 1
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle, name = tempfile.mkstemp(prefix=".records-", suffix=".tmp", dir=self.path.parent)
            try:
                with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                    json.dump({"version": version, "records": records}, stream, ensure_ascii=False)
                os.replace(name, self.path)
            finally:
                Path(name).unlink(missing_ok=True)
            return version


def connection_settings(database_url: str) -> tuple[str, str]:
    """Split a Prisma-style URL into a libpq URL and the schema name (Prisma-only query params removed)."""
    parts = urlsplit(database_url)
    query = dict(parse_qsl(parts.query))
    schema = query.pop("schema", "tutupbuku")
    query.pop("pgbouncer", None)
    query.pop("connection_limit", None)
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", schema):
        raise RecordStoreError("The schema name in DATABASE_URL is not a plain identifier.", 500)
    return urlunsplit(parts._replace(query=urlencode(query))), schema


class PostgresRecords:
    """The Prisma-defined tables in Supabase Postgres, written in one transaction per save."""

    mode = "supabase"

    def __init__(self, database_url: str, *, connect=None) -> None:
        self.url, self.schema = connection_settings(database_url)
        self._connect = connect
        self._lock = threading.Lock()
        self._down_until = 0.0
        self._down_reason = ""

    def _connection(self):
        remaining = self._down_until - time.monotonic()
        if remaining > 0:
            raise RecordStoreError(f"{self._down_reason} Retrying in {int(remaining) + 1} s.")
        if self._connect is not None:
            return self._connect()
        try:
            import psycopg
        except ImportError as exc:
            raise RecordStoreError('The Postgres driver is not installed. Run: py -3.13 -m pip install "psycopg[binary]"') from exc
        try:
            connection = psycopg.connect(self.url, connect_timeout=5, prepare_threshold=None, autocommit=False)
            self._down_until = 0.0
            return connection
        except psycopg.OperationalError as exc:
            first = (str(exc).splitlines() or ["connection failed"])[0]
            if "timeout" in first.casefold():
                first = "connection timed out (this network may block Postgres ports 5432/6543; a phone hotspot works)"
            elif "password authentication failed" in first.casefold():
                first = "password authentication failed (check the password in DATABASE_URL)"
            self._down_reason = f"The Supabase database could not be reached: {first}."
            self._down_until = time.monotonic() + RETRY_AFTER_SECONDS
            raise RecordStoreError(self._down_reason) from exc

    def _table(self, name: str) -> str:
        return f'"{self.schema}"."{name}"'

    def _missing_tables(self, exc: Exception) -> bool:
        return getattr(exc, "sqlstate", None) in {"42P01", "3F000"}

    def status(self) -> dict[str, Any]:
        try:
            with self._connection() as connection:
                connection.execute(f"select value from {self._table('workspace_meta')} limit 1")
            return {"mode": self.mode, "ok": True, "message": f"Records are saved in Supabase (schema {self.schema})."}
        except RecordStoreError as exc:
            return {"mode": self.mode, "ok": False, "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - reported to the operator as-is
            message = f"The tables are missing. {SETUP_HINT}" if self._missing_tables(exc) else f"Database error: {str(exc).splitlines()[0][:200]}"
            return {"mode": self.mode, "ok": False, "message": message}

    def load(self) -> dict[str, Any]:
        from psycopg.rows import dict_row

        try:
            with self._lock, self._connection() as connection:
                connection.row_factory = dict_row
                row = connection.execute(f"select value from {self._table('workspace_meta')} where key = 'version'").fetchone()
                records = _empty()
                for kind, (table, columns) in COLUMNS.items():
                    names = ", ".join(f'"{column}"' for _, column, _ in columns)
                    order = '"timestamp", id' if kind == "audit" else "id"
                    for item in connection.execute(f"select {names} from {self._table(table)} order by {order}").fetchall():
                        records[kind].append(row_to_object(kind, item))
                return {"version": int(row["value"]) if row else 0, "records": records}
        except RecordStoreError:
            raise
        except Exception as exc:  # noqa: BLE001
            if self._missing_tables(exc):
                raise RecordStoreError(f"The tables are missing. {SETUP_HINT}") from exc
            raise RecordStoreError(f"Database error: {str(exc).splitlines()[0][:200]}") from exc

    def save(self, records: dict[str, list], expected_version: Any) -> int:
        records = validate_records(records)
        try:
            with self._lock, self._connection() as connection:
                with connection.transaction():
                    meta = self._table("workspace_meta")
                    connection.execute(f"insert into {meta} (key, value) values ('version', 0) on conflict (key) do nothing")
                    current = connection.execute(f"select value from {meta} where key = 'version' for update").fetchone()[0]
                    if expected_version != current:
                        raise RecordStoreError("The records changed since this page loaded them. Reload to see the latest.", 409)
                    # Remove what the page no longer has (children before the documents they reference).
                    for kind in ("links", "claims", "issues", "audit", "docs"):
                        table = self._table(COLUMNS[kind][0])
                        ids = [item["id"] for item in records[kind]]
                        connection.execute(f"delete from {table} where not (id = any(%s))", (ids,))
                    # Upsert parents first so foreign keys hold.
                    for kind in ("docs", "links", "claims", "issues", "audit"):
                        table, columns = COLUMNS[kind]
                        names = [column for _, column, _ in columns]
                        placeholders = []
                        for column in names:
                            enum = ENUMS.get((kind, column))
                            placeholders.append(f'%s::"{self.schema}"."{enum}"' if enum else "%s")
                        updates = ", ".join(f'"{c}" = excluded."{c}"' for c in names if c != "id")
                        if kind != "audit":
                            updates += ", updated_at = now()"
                        sql = (f'insert into {self._table(table)} ({", ".join(chr(34) + c + chr(34) for c in names)}) '
                               f'values ({", ".join(placeholders)}) on conflict (id) do update set {updates}')
                        rows = [object_to_params(kind, item) for item in records[kind]]
                        if rows:
                            with connection.cursor() as cursor:
                                cursor.executemany(sql, rows)
                    version = current + 1
                    connection.execute(f"update {meta} set value = %s, updated_at = now() where key = 'version'", (version,))
                return version
        except RecordStoreError:
            raise
        except Exception as exc:  # noqa: BLE001
            if self._missing_tables(exc):
                raise RecordStoreError(f"The tables are missing. {SETUP_HINT}") from exc
            state = getattr(exc, "sqlstate", None)
            status = 400 if state and state[:2] in {"22", "23"} else 503  # bad data / constraint violation
            raise RecordStoreError(f"The records could not be saved: {str(exc).splitlines()[0][:200]}", status) from exc


def build_record_store(env: dict[str, str], project_root: Path) -> LocalRecords | PostgresRecords:
    url = (env.get("DATABASE_URL") or "").strip()
    if url.startswith(("postgres://", "postgresql://")):
        return PostgresRecords(url)
    return LocalRecords(Path(project_root) / ".tutupbuku-job-state" / "records.json")
