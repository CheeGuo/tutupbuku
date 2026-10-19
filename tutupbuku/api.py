"""Stateless Vercel API: Postgres records, read-only cases, and document extraction.

Run this ASGI app through Vercel's Python runtime. The local server remains in
app.py; file-backed workflows and background agent runs require a durable worker.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import mimetypes
import os
import re
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from .extract import ExtractionError, extract_document
from .records import PostgresRecords, RecordStoreError
from .service import TutupBukuService

# Leave room below Vercel's 4.5 MB request limit, including base64 upload overhead.
MAX_REQUEST_BYTES = 4 * 1024 * 1024
WORKER_REQUIRED = {
    "error": "This operation needs a durable worker. The hosted API currently supports records, case browsing, and document extraction.",
    "code": "DURABLE_WORKER_REQUIRED",
}


async def read_payload(request: Request, allowed: set[str]) -> dict[str, Any]:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise ValueError("request must use application/json")
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError as exc:
            raise ValueError("request body length is invalid") from exc
        if length < 0:
            raise ValueError("request body length is invalid")
        if length > MAX_REQUEST_BYTES:
            raise OverflowError("request exceeds the hosted API's 4 MiB limit")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise OverflowError("request exceeds the hosted API's 4 MiB limit")
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("request body must be valid UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ValueError("unexpected request field(s): " + ", ".join(unknown))
    return payload


def create_app(*, project_root: Path | None = None, env: Mapping[str, str] | None = None,
               records: Any | None = None, daemon_store: Any | None = None) -> FastAPI:
    """Construct an API without opening a database connection or starting workers."""
    root = Path(project_root or Path(__file__).resolve().parents[1]).resolve()
    settings = dict(os.environ if env is None else env)
    daemon_enabled = settings.get("TUTUPBUKU_DAEMON_ENABLED") == "1"
    if daemon_enabled and daemon_store is None and settings.get("DATABASE_URL", "").startswith(("postgres://", "postgresql://")):
        from .daemon_store import PostgresDaemonStore
        daemon_store = PostgresDaemonStore(settings["DATABASE_URL"], workspace=settings.get("TUTUPBUKU_WORKER_WORKSPACE", "default"),
                                          max_posts_per_hour=int(settings.get("TUTUPBUKU_WORKER_MAX_COMMANDS_PER_HOUR", "120")))
    token = settings.get("TUTUPBUKU_API_TOKEN") or None
    if token is not None and (len(token) < 32 or any(character.isspace() for character in token)):
        raise ValueError("TUTUPBUKU_API_TOKEN must be at least 32 characters and contain no whitespace")
    app = FastAPI(title="TutupBuku API", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.records = records
    app.state.record_error = "Configure a Postgres DATABASE_URL in the Vercel project's environment variables."
    if records is None:
        url = settings.get("DATABASE_URL", "").strip()
        if url.startswith(("postgres://", "postgresql://")):
            try:
                app.state.records = PostgresRecords(url)
            except RecordStoreError as exc:
                app.state.record_error = str(exc)
    # Committed demo inputs are browsed in place. Never copy or write into the bundle.
    app.state.cases = None

    def record_store():
        if app.state.records is None:
            raise RecordStoreError(app.state.record_error)
        return app.state.records

    def case_service() -> TutupBukuService:
        # The constructor does no I/O beyond reading the committed baseline.
        if app.state.cases is None:
            app.state.cases = TutupBukuService(root, fixtures_root=root / "demo-fixtures", persist_input_state=False)
        return app.state.cases

    @app.middleware("http")
    async def protect_api(request: Request, call_next):
        supplied = request.headers.get("authorization", "")
        if token and request.url.path.startswith("/api/") and not hmac.compare_digest(
            supplied.encode("utf-8"), f"Bearer {token}".encode("utf-8")
        ):
            response = JSONResponse({"error": "valid TutupBuku API bearer token required"}, status_code=401)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(RecordStoreError)
    async def record_error(request: Request, exc: RecordStoreError):
        body: dict[str, Any] = {"error": str(exc)}
        if request.url.path == "/api/records":
            body["storage"] = {"mode": getattr(app.state.records, "mode", "unconfigured"), "ok": False, "message": str(exc)}
        return JSONResponse(body, status_code=exc.status)

    @app.exception_handler(ValueError)
    async def bad_request(request: Request, exc: ValueError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    @app.exception_handler(OverflowError)
    async def too_large(request: Request, exc: OverflowError):
        return JSONResponse({"error": str(exc)}, status_code=413)

    @app.exception_handler(OSError)
    async def file_error(request: Request, exc: OSError):
        status = 404 if isinstance(exc, FileNotFoundError) else 500
        return JSONResponse({"error": "source file is not available" if status == 404 else "source file could not be read"}, status_code=status)

    @app.exception_handler(HTTPException)
    async def route_error(request: Request, exc: HTTPException):
        return JSONResponse({"error": "route not found" if exc.status_code == 404 else str(exc.detail)}, status_code=exc.status_code, headers=exc.headers)

    if daemon_enabled:
        from .daemon_api import install_daemon_routes
        install_daemon_routes(app, daemon_store, read_payload)

    @app.get("/api/health")
    def health():
        worker = {"online": False}
        if daemon_enabled and daemon_store is not None:
            from .daemon_store import DaemonStoreError
            try:
                worker = daemon_store.health()
            except DaemonStoreError as exc:
                worker["error"] = str(exc)
        return {"status": "ok", "case_id": "Sept2026", "storage_configured": app.state.records is not None,
                "workbuddy_configured": bool(worker["online"]), "worker": worker,
                "capabilities": {"records": True, "cases": True,
                                 "extraction": bool(worker["online"]) if daemon_enabled else True,
                                 "execution": bool(worker["online"])}}

    @app.get("/api/records")
    def get_records():
        store = record_store()
        return {"storage": {"mode": store.mode, "ok": True}, **store.load()}

    @app.post("/api/records")
    async def save_records(request: Request):
        payload = await read_payload(request, {"records", "expected_version"})
        store = record_store()
        version = await run_in_threadpool(store.save, payload.get("records"), payload.get("expected_version"))
        return {"version": version, "storage": {"mode": store.mode, "ok": True}}

    @app.get("/api/cases")
    def cases():
        return {"cases": case_service().list_cases()}

    @app.get("/api/case")
    def case(case_id: str | None = None):
        return case_service().get_case(case_id)

    @app.get("/api/source/{relative_path:path}")
    def source(relative_path: str, case_id: str | None = None):
        target = case_service().source_path(relative_path, case_id)
        return Response(target.read_bytes(), media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream")

    @app.post("/api/extract")
    async def extract(request: Request):
        payload = await read_payload(request, {"filename", "content_base64"})
        filename, encoded = payload.get("filename"), payload.get("content_base64")
        if not isinstance(filename, str) or not isinstance(encoded, str):
            raise ValueError("filename and content_base64 must be strings")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("content_base64 is not valid base64") from exc
        if not re.search(r"\.(pdf|jpe?g|png|webp|gif|bmp|tiff?)$", filename, re.I):
            return JSONResponse({"error": "Upload a PDF or an image (JPG, PNG, WEBP, GIF, BMP or TIFF)."}, status_code=415)
        try:
            return await run_in_threadpool(extract_document, content, filename[:200])
        except ExtractionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=422)

    @app.get("/api/execution")
    def execution_status(run_id: str | None = None):
        if run_id:
            return JSONResponse(WORKER_REQUIRED, status_code=503)
        return {"run": None, "capabilities": {"execution": False}}

    def worker_required():
        return JSONResponse(WORKER_REQUIRED, status_code=503)

    for path in ("/api/execution", "/api/execution/continue", "/api/chat", "/api/claims/council", "/api/jobs",
                 "/api/uploads", "/api/run", "/api/decisions", "/api/build-review-pack", "/api/reset-demo"):
        app.add_api_route(path, worker_required, methods=["POST"], include_in_schema=False)
    for path in ("/api/run", "/api/review-items", "/api/review-pack", "/api/execution/audit", "/api/jobs", "/api/jobs/{job_id}", "/api/exports/{filename}"):
        app.add_api_route(path, worker_required, methods=["GET"], include_in_schema=False)
    return app


app = create_app()
