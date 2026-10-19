"""Bounded HTTP-to-worker mailbox transport; no tunnel or public agent gateway."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import re
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .daemon_store import DaemonStoreError

POST_FIELDS = {
    "/api/execution": {"case_id", "goal", "request_id"},
    "/api/execution/continue": {"run_id", "expected_version", "candidate_id", "answer", "leave_open"},
    "/api/chat": {"message", "history", "case_id"},
    "/api/claims/council": {"claim", "accounts"},
    "/api/run": {"case_id"},
    "/api/jobs": {"case_id"},
    "/api/decisions": {"case_id", "bank_row_id", "candidate_id", "answer"},
    "/api/build-review-pack": {"case_id"},
    "/api/uploads": {"case_id", "path", "file_base64", "file_size", "upload_id", "chunk_index", "chunk_count"},
    "/api/reset-demo": {"case_id", "confirmation"},
    "/api/extract": {"filename", "content_base64"},
}
GET_PATHS = {"/api/execution", "/api/execution/audit", "/api/run", "/api/review-items", "/api/review-pack",
             "/api/jobs", "/api/cases", "/api/case"}
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
MAX_REPLY_BYTES = 4 * 1024 * 1024


def validate_target(method: str, target: str) -> str:
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.fragment or len(target) > 2048:
        raise ValueError("Invalid worker request target.")
    decoded = parsed.path
    for _ in range(4):
        updated = unquote(decoded)
        if updated == decoded:
            break
        decoded = updated
    if "\\" in decoded or any(ord(c) < 32 for c in decoded) or ".." in decoded.split("/") or "//" in decoded:
        raise ValueError("Invalid worker request path.")
    supported = decoded in (POST_FIELDS if method == "POST" else GET_PATHS)
    if method == "GET":
        supported = supported or any(decoded.startswith(prefix) and len(decoded) > len(prefix)
                                     for prefix in ("/api/source/", "/api/exports/", "/api/jobs/"))
    if method not in {"GET", "POST"} or not supported:
        raise ValueError("Worker route is not allowed.")
    query = parse_qs(parsed.query, keep_blank_values=True)
    if set(query) - {"case_id", "run_id"} or any(len(values) != 1 for values in query.values()):
        raise ValueError("Unexpected or repeated worker query parameter.")
    for key, values in query.items():
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", values[0]):
            raise ValueError(f"Invalid {key}.")
    return decoded


def response_from_worker(value: dict[str, Any]) -> Response:
    try:
        status = value["status"]
        if type(status) is not int or not 200 <= status <= 599:
            raise ValueError()
        encoded = value["body"]
        if not isinstance(encoded, str) or len(encoded) > (MAX_REPLY_BYTES + 2) // 3 * 4:
            raise ValueError()
        body = base64.b64decode(encoded, validate=True)
        raw_headers = value.get("headers", {})
        if not isinstance(raw_headers, dict):
            raise ValueError()
        headers = {str(k): str(v) for k, v in raw_headers.items()
                   if k.casefold() in {"content-type", "content-disposition"} and "\r" not in str(v) and "\n" not in str(v)}
        return Response(body, status_code=status, headers=headers)
    except (KeyError, TypeError, ValueError, binascii.Error):
        return JSONResponse({"error": "The worker returned an invalid response.", "code": "WORKER_PROTOCOL"}, status_code=502)


def install_daemon_routes(app, store, read_payload, *, file_wait_seconds: float = 10) -> None:
    def require_store():
        if store is None:
            raise DaemonStoreError("Configure DATABASE_URL and apply prisma/daemon.sql before enabling the WorkBuddy worker.", code="WORKER_NOT_CONFIGURED")
        return store

    @app.exception_handler(DaemonStoreError)
    async def worker_error(request: Request, exc: DaemonStoreError):
        return JSONResponse({"error": str(exc), "code": exc.code}, status_code=exc.status)

    @app.get("/api/worker/jobs/{job_id}")
    async def command_status(job_id: str):
        if not UUID_PATTERN.fullmatch(job_id):
            return JSONResponse({"error": "Worker job not found."}, status_code=404)
        job = await run_in_threadpool(require_store().get, job_id)
        if job is None:
            return JSONResponse({"error": "Worker job not found."}, status_code=404)
        return {"worker_job": job}

    async def relay(request: Request):
        target = request.url.path + ("?" + request.url.query if request.url.query else "")
        route = validate_target(request.method, target)
        payload = await read_payload(request, POST_FIELDS[route]) if request.method == "POST" else None
        request_key = request.headers.get("Idempotency-Key")
        if request_key and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_key):
            raise ValueError("Idempotency-Key is invalid.")
        # The month-end UI retains request_id after an ambiguous initial POST.
        if request.method == "POST" and route == "/api/execution" and isinstance(payload.get("request_id"), str):
            request_key = payload["request_id"]
        key = hashlib.sha256(f"{route}:{request_key}".encode()).hexdigest() if request_key else str(uuid.uuid4()) if request.method == "POST" else None
        headers = {"Idempotency-Key": request_key} if request_key else {}
        job = await run_in_threadpool(require_store().submit, request.method, target, payload, headers=headers, key=key)
        if route.startswith(("/api/source/", "/api/exports/")):
            deadline = time.monotonic() + file_wait_seconds
            while job["status"] in {"queued", "running"} and time.monotonic() < deadline:
                await asyncio.sleep(0.2)
                job = await run_in_threadpool(store.get, job["id"])
            if job["status"] != "completed":
                return JSONResponse({"error": "File is not ready. Wait for the worker, then retry the download."}, status_code=503)
        if job["status"] == "completed":
            return response_from_worker(job["response"])
        return JSONResponse({"worker_job": job}, status_code=202,
                            headers={"Location": f"/api/worker/jobs/{job['id']}"})

    for path in POST_FIELDS:
        app.add_api_route(path, relay, methods=["POST"], include_in_schema=False)
    for path in sorted(GET_PATHS):
        app.add_api_route(path, relay, methods=["GET"], include_in_schema=False)
    for path in ("/api/source/{worker_path:path}", "/api/exports/{worker_path:path}", "/api/jobs/{worker_path:path}"):
        app.add_api_route(path, relay, methods=["GET"], include_in_schema=False)
