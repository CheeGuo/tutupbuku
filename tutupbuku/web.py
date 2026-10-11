"""Loopback HTTP interface shared by the browser and TutupBuku MCP service."""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import mimetypes
import re
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from .engine import InputValidationError
from .execution import ExecutionError, ExecutionManager
from .models import MAX_UPLOAD_BYTES, SUPPORTED_RECEIPT_SUFFIXES, SUPPORTED_ROOT_FILES
from .service import TutupBukuService
from .workbuddy import AgentReviewJobs, WorkBuddyError

MAX_REQUEST_BYTES = (MAX_UPLOAD_BYTES * 4 // 3) + 16 * 1024
MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024
UPLOAD_SESSION_TTL_SECONDS = 15 * 60
STATIC_ROOT = Path(__file__).resolve().parents[1] / "public"
EXPORT_NAMES = {
    "01_proposals.csv",
    "02_exceptions.md",
    "03_records_summary.md",
    "04_decisions_log.csv",
    "05_manifest.csv",
}
STATIC_NAMES = {"index.html", "styles.css", "app.js"}


def create_server(
    service: TutupBukuService,
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    api_token: str | None = None,
    agent_jobs: AgentReviewJobs | None = None,
    executions: ExecutionManager | None = None,
    frontend_dist: Path | None = None,
) -> ThreadingHTTPServer:
    """Create the loopback server; an optional bearer token protects tunneled API calls."""
    if host != "127.0.0.1":
        raise ValueError("TutupBuku's browser server must bind to 127.0.0.1")
    if api_token is not None and (len(api_token) < 32 or any(character.isspace() for character in api_token)):
        raise ValueError("TUTUPBUKU_API_TOKEN must be at least 32 characters and contain no whitespace")
    upload_sessions: dict[str, dict[str, Any]] = {}
    upload_lock = threading.RLock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "TutupBuku/0.2"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:
            # Never write credentials, source data or MCP protocol traffic to stdout.
            return

        def _headers(self, status: int, content_type: str, length: int) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def _send_bytes(self, status: int, content_type: str, content: bytes) -> None:
            self._headers(status, content_type, len(content))
            self.wfile.write(content)

        def _send_json(self, status: int, value: Any) -> None:
            content = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            self._send_bytes(status, "application/json; charset=utf-8", content)

        def _error(self, status: int, message: str) -> None:
            self._send_json(status, {"error": message})

        def _valid_host(self) -> bool:
            host_header = self.headers.get("Host", "").casefold()
            local_hosts = {"127.0.0.1", "localhost", "[::1]"}
            if self.server.server_port:
                local_hosts |= {f"{local_host}:{self.server.server_port}" for local_host in tuple(local_hosts)}
            return host_header in local_hosts

        def _authorized_api(self, path: str) -> bool:
            if not path.startswith("/api/") or api_token is None:
                return True
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {api_token}"
            return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))

        def _read_json(self) -> dict[str, Any]:
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().casefold()
            if content_type != "application/json":
                raise ValueError("request must use application/json")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise ValueError("request body length is invalid") from exc
            if length < 1:
                raise ValueError("request body is required")
            if length > MAX_REQUEST_BYTES:
                raise OverflowError(f"request exceeds the {MAX_UPLOAD_BYTES}-byte upload limit")
            try:
                value = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError("request body must be valid UTF-8 JSON") from exc
            if not isinstance(value, dict):
                raise ValueError("request body must be a JSON object")
            return value

        @staticmethod
        def _case_id(query: dict[str, list[str]], payload: dict[str, Any] | None = None) -> str | None:
            if payload is not None:
                case_id = payload.get("case_id")
                if case_id is not None and not isinstance(case_id, str):
                    raise ValueError("case_id must be a string")
                return case_id
            values = query.get("case_id", [])
            if len(values) > 1:
                raise ValueError("provide only one case_id")
            return values[0] if values else None

        def _require_no_active_job(self) -> None:
            if agent_jobs is not None and agent_jobs.blocks_state_changes():
                raise WorkBuddyError("Wait for the current WorkBuddy review to finish or resolve its unconfirmed status before changing inputs or decisions.", "JOB_ALREADY_ACTIVE", outcome_uncertain=True)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if not self._valid_host():
                self._error(HTTPStatus.BAD_REQUEST, "host is not allowed")
                return
            parsed = urlsplit(self.path)
            if not self._authorized_api(parsed.path):
                self._error(HTTPStatus.UNAUTHORIZED, "valid TutupBuku API bearer token required")
                return
            query = parse_qs(parsed.query, keep_blank_values=True)
            try:
                if frontend_dist is not None and not parsed.path.startswith("/api/"):
                    self._frontend(parsed.path)
                elif parsed.path in {"/", "/index.html"}:
                    self._static("index.html")
                elif parsed.path in {"/styles.css", "/app.js"}:
                    self._static(parsed.path.lstrip("/"))
                elif parsed.path == "/api/execution/audit":
                    run_id = query.get("run_id", [None])[0]
                    audit = executions.audit(run_id) if executions is not None and run_id else None
                    if audit is None:
                        self._error(HTTPStatus.NOT_FOUND, "run not found")
                        return
                    self._send_json(HTTPStatus.OK, audit)
                elif parsed.path == "/api/execution":
                    if executions is None:
                        self._error(HTTPStatus.SERVICE_UNAVAILABLE, "execution service is not configured")
                        return
                    run_id = query.get("run_id", [None])[0]
                    run = executions.current(run_id)
                    if run_id and run is None:
                        self._error(HTTPStatus.NOT_FOUND, "run not found")
                        return
                    self._send_json(HTTPStatus.OK, {"run": run})
                elif parsed.path == "/api/health":
                    self._send_json(HTTPStatus.OK, {
                        "status": "ok",
                        "case_id": service.default_case_id,
                        "workbuddy_configured": bool(agent_jobs and agent_jobs.configured),
                    })
                elif parsed.path == "/api/cases":
                    self._send_json(HTTPStatus.OK, {"cases": service.list_cases()})
                elif parsed.path == "/api/case":
                    self._send_json(HTTPStatus.OK, service.get_case(self._case_id(query)))
                elif parsed.path == "/api/run":
                    self._send_json(HTTPStatus.OK, service.run_matching(self._case_id(query)))
                elif parsed.path == "/api/review-items":
                    self._send_json(HTTPStatus.OK, {"items": service.get_review_items(self._case_id(query))})
                elif parsed.path == "/api/review-pack":
                    self._send_json(HTTPStatus.OK, service.review_pack_status(self._case_id(query)))
                elif parsed.path == "/api/jobs":
                    self._send_json(HTTPStatus.OK, {"job": agent_jobs.latest() if agent_jobs else None})
                elif parsed.path.startswith("/api/jobs/"):
                    job_id = parsed.path.removeprefix("/api/jobs/")
                    if not re.fullmatch(r"[0-9a-f-]{36}", job_id, flags=re.IGNORECASE):
                        self._error(HTTPStatus.NOT_FOUND, "job not found")
                        return
                    job = agent_jobs.get(job_id) if agent_jobs else None
                    if job is None:
                        self._error(HTTPStatus.NOT_FOUND, "job not found")
                    else:
                        self._send_json(HTTPStatus.OK, {"job": job})
                elif parsed.path.startswith("/api/source/"):
                    relative_path = unquote(parsed.path.removeprefix("/api/source/"))
                    target = service.source_path(relative_path, self._case_id(query))
                    mime_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    self._send_bytes(HTTPStatus.OK, mime_type, target.read_bytes())
                elif parsed.path.startswith("/api/exports/"):
                    filename = unquote(parsed.path.removeprefix("/api/exports/"))
                    if filename not in EXPORT_NAMES:
                        raise ValueError("export filename is not in the allow-list")
                    target = service.export_path(filename, self._case_id(query))
                    content_type = "text/csv; charset=utf-8" if filename.endswith(".csv") else "text/markdown; charset=utf-8"
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(target.stat().st_size))
                    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(target.read_bytes())
                else:
                    self._error(HTTPStatus.NOT_FOUND, "route not found")
            except FileNotFoundError as exc:
                self._error(HTTPStatus.NOT_FOUND, str(exc))
            except (ValueError, InputValidationError) as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except OSError:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "local file could not be read")

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if not self._valid_host():
                self._error(HTTPStatus.BAD_REQUEST, "host is not allowed")
                return
            parsed = urlsplit(self.path)
            if not self._authorized_api(parsed.path):
                self._error(HTTPStatus.UNAUTHORIZED, "valid TutupBuku API bearer token required")
                return
            try:
                payload = self._read_json()
                case_id = self._case_id({}, payload)
                if parsed.path == "/api/chat":
                    if executions is None:
                        self._error(HTTPStatus.SERVICE_UNAVAILABLE, "execution service is not configured")
                        return
                    self._check_keys(payload, {"message", "history", "case_id"})
                    self._send_json(HTTPStatus.OK, executions.chat(payload.get("message"), payload.get("history"), case_id))
                elif parsed.path in {"/api/execution", "/api/execution/continue"}:
                    if executions is None:
                        self._error(HTTPStatus.SERVICE_UNAVAILABLE, "execution service is not configured")
                        return
                    if parsed.path == "/api/execution":
                        self._check_keys(payload, {"case_id", "goal", "request_id"})
                        run = executions.start(case_id, payload.get("goal"), payload.get("request_id"))
                    else:
                        self._check_keys(payload, {"run_id", "expected_version", "candidate_id", "answer", "leave_open"})
                        run = executions.resume(payload.get("run_id"), payload.get("expected_version"), payload.get("candidate_id"), payload.get("answer"), payload.get("leave_open"))
                    self._send_json(HTTPStatus.ACCEPTED, {"run": run})
                elif parsed.path == "/api/run":
                    self._require_no_active_job()
                    self._check_keys(payload, {"case_id"})
                    self._send_json(HTTPStatus.OK, service.run_matching(case_id))
                elif parsed.path == "/api/jobs":
                    self._check_keys(payload, {"case_id"})
                    if agent_jobs is None:
                        self._error(HTTPStatus.SERVICE_UNAVAILABLE, "WorkBuddy job service is not configured")
                        return
                    job, created = agent_jobs.start(case_id or service.default_case_id, self.headers.get("Idempotency-Key", ""))
                    self._send_json(HTTPStatus.ACCEPTED if created else HTTPStatus.OK, {"job": job, "created": created})
                elif parsed.path == "/api/decisions":
                    self._require_no_active_job()
                    self._check_keys(payload, {"case_id", "bank_row_id", "candidate_id", "answer"})
                    if not isinstance(payload.get("bank_row_id"), str) or not isinstance(payload.get("answer"), str):
                        raise ValueError("bank_row_id and answer must be strings")
                    result = service.save_decision(case_id, payload["bank_row_id"], payload.get("candidate_id"), payload["answer"])
                    self._send_json(HTTPStatus.OK, result)
                elif parsed.path == "/api/build-review-pack":
                    self._require_no_active_job()
                    self._check_keys(payload, {"case_id"})
                    self._send_json(HTTPStatus.OK, service.build_review_pack(case_id))
                elif parsed.path == "/api/uploads":
                    self._require_no_active_job()
                    self._handle_upload(payload, case_id)
                elif parsed.path == "/api/reset-demo":
                    self._require_no_active_job()
                    self._check_keys(payload, {"case_id", "confirmation"})
                    result = service.reset_demo_data(case_id or service.default_case_id, payload.get("confirmation", ""))
                    if agent_jobs is not None:
                        agent_jobs.reset_case(case_id or service.default_case_id)
                    self._send_json(HTTPStatus.OK, result)
                else:
                    self._error(HTTPStatus.NOT_FOUND, "route not found")
            except OverflowError as exc:
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(exc))
            except ExecutionError as exc:
                self._error(exc.status, str(exc))
            except WorkBuddyError as exc:
                status = HTTPStatus.SERVICE_UNAVAILABLE if exc.code == "GATEWAY_NOT_CONFIGURED" else HTTPStatus.CONFLICT if exc.code in {"JOB_ALREADY_ACTIVE", "IDEMPOTENCY_KEY_CONFLICT"} else HTTPStatus.TOO_MANY_REQUESTS if exc.code == "RATE_LIMITED" else HTTPStatus.BAD_REQUEST
                self._error(status, str(exc))
            except (ValueError, InputValidationError) as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except FileNotFoundError as exc:
                self._error(HTTPStatus.NOT_FOUND, str(exc))
            except (KeyError, TypeError) as exc:
                self._error(HTTPStatus.BAD_REQUEST, f"missing or invalid request field: {exc}")
            except OSError:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "local file could not be written")

        def _handle_upload(self, payload: dict[str, Any], case_id: str | None) -> None:
            if "upload_id" not in payload:
                self._check_keys(payload, {"case_id", "path", "file_base64"})
                relative_path = payload.get("path")
                encoded = payload.get("file_base64")
                if not isinstance(relative_path, str) or not isinstance(encoded, str):
                    raise ValueError("upload path and file_base64 must be strings")
                content = self._decode_file(encoded, MAX_UPLOAD_BYTES)
                self._send_json(HTTPStatus.OK, service.upload_source(relative_path, content, case_id))
                return

            self._check_keys(payload, {"case_id", "path", "file_size", "upload_id", "chunk_index", "chunk_count", "file_base64"})
            upload_id = payload.get("upload_id")
            relative_path = payload.get("path")
            file_size = payload.get("file_size")
            index = payload.get("chunk_index")
            count = payload.get("chunk_count")
            encoded = payload.get("file_base64")
            if not isinstance(upload_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", upload_id, re.IGNORECASE):
                raise ValueError("upload_id must be a UUID")
            if not isinstance(relative_path, str) or not isinstance(encoded, str):
                raise ValueError("upload path and file_base64 are required")
            if type(file_size) is not int or not 0 <= file_size <= MAX_UPLOAD_BYTES:
                raise ValueError("file_size is outside the upload limit")
            if type(index) is not int or type(count) is not int or count < 1 or count > 5 or not 0 <= index < count:
                raise ValueError("upload chunk index or count is invalid")
            chunk = self._decode_file(encoded, MAX_UPLOAD_CHUNK_BYTES)
            if not chunk and file_size:
                raise ValueError("an upload chunk cannot be empty")
            now = time.monotonic()
            with upload_lock:
                for key in [key for key, session in upload_sessions.items() if now - session["updated"] > UPLOAD_SESSION_TTL_SECONDS]:
                    upload_sessions.pop(key, None)
                session = upload_sessions.get(upload_id)
                if session is None:
                    if len(upload_sessions) >= 8:
                        self._error(HTTPStatus.TOO_MANY_REQUESTS, "too many uploads are already in progress")
                        return
                    session = {"case_id": case_id, "path": relative_path, "file_size": file_size, "count": count, "chunks": [None] * count, "updated": now}
                    upload_sessions[upload_id] = session
                if (session["case_id"], session["path"], session["file_size"], session["count"]) != (case_id, relative_path, file_size, count):
                    upload_sessions.pop(upload_id, None)
                    raise ValueError("upload metadata changed between chunks")
                previous = session["chunks"][index]
                if previous is not None and previous != chunk:
                    upload_sessions.pop(upload_id, None)
                    raise ValueError("a repeated upload chunk did not match the saved bytes")
                session["chunks"][index] = chunk
                session["updated"] = now
                received = sum(item is not None for item in session["chunks"])
                if received < count:
                    self._send_json(HTTPStatus.OK, {"status": "chunk_received", "upload_id": upload_id, "received_chunks": received, "chunk_count": count})
                    return
                content = b"".join(session["chunks"])
                upload_sessions.pop(upload_id, None)
            if len(content) != file_size:
                raise ValueError("assembled upload size did not match the declared file size")
            self._send_json(HTTPStatus.OK, service.upload_source(relative_path, content, case_id))

        @staticmethod
        def _decode_file(encoded: str, max_bytes: int) -> bytes:
            if len(encoded) > ((max_bytes + 2) // 3) * 4:
                raise OverflowError(f"upload chunk exceeds the {max_bytes}-byte limit")
            try:
                content = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("file_base64 must be valid base64") from exc
            if len(content) > max_bytes:
                raise OverflowError(f"upload exceeds the {max_bytes}-byte limit")
            return content

        @staticmethod
        def _check_keys(payload: dict[str, Any], allowed: set[str]) -> None:
            unknown = sorted(set(payload) - allowed)
            if unknown:
                raise ValueError("unexpected request field(s): " + ", ".join(unknown))

        def _frontend(self, request_path: str) -> None:
            """Serve the built React app; unknown non-file paths fall back to index.html (client routing)."""
            root = frontend_dist.resolve()
            try:
                requested = unquote(request_path).lstrip("/") or "index.html"
            except ValueError:
                self._error(HTTPStatus.BAD_REQUEST, "invalid path")
                return
            target = (root / requested).resolve()
            if not target.is_relative_to(root):
                self._error(HTTPStatus.NOT_FOUND, "not found")
                return
            if not target.is_file():
                if Path(requested).suffix:
                    self._error(HTTPStatus.NOT_FOUND, "frontend asset not found; build the frontend first")
                    return
                target = root / "index.html"
            if not target.is_file():
                self._error(HTTPStatus.SERVICE_UNAVAILABLE, "frontend build not found; run npm run build in the frontend folder")
                return
            content = target.read_bytes()
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if target.suffix in {".html", ".css", ".js", ".mjs", ".svg"}:
                content_type += "; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            # React sets inline style attributes, so the frontend needs 'unsafe-inline' for styles only.
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
            self.send_header("Cache-Control", "no-cache" if target.suffix == ".html" else "public, max-age=3600")
            self.end_headers()
            self.wfile.write(content)

        def _static(self, filename: str) -> None:
            if filename not in STATIC_NAMES:
                self._error(HTTPStatus.NOT_FOUND, "static file not found")
                return
            content = (STATIC_ROOT / filename).read_bytes()
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            if filename.endswith((".html", ".css", ".js")):
                content_type += "; charset=utf-8"
            self._send_bytes(HTTPStatus.OK, content_type, content)

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server