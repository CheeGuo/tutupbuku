"""Run the loopback browser API (and optionally the WorkBuddy MCP server) against one shared case service.

Typical local use, from the repository root:

    python -m tutupbuku.app --frontend --web-only

serves the built React app from frontend/dist and the /api on http://127.0.0.1:8765. If .env holds
CODEBUDDY_GATEWAY_URL (or NGROK_URL) and CODEBUDDY_GATEWAY_PASSWORD, each run sends the role skills
and the engine results to WorkBuddy through that gateway.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from threading import Thread

from .agents import AgentOrchestrator
from .execution import ExecutionManager
from .mcp_server import MCPServer, serve_stdio
from .records import build_record_store
from .service import TutupBukuService
from .web import create_server
from .workbuddy import AgentReviewJobs, WorkBuddyClient, WorkBuddyError


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines from .env without overriding variables that are already set."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        value = value.strip()
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = value.strip('"')
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def ensure_working_case(project_root: Path, case_id: str) -> None:
    """Create fixtures/<case> from the committed baseline when the working copy is missing."""
    working = project_root / "fixtures" / case_id
    baseline = project_root / "demo-fixtures" / case_id
    if not working.exists() and baseline.is_dir():
        shutil.copytree(baseline, working)


def build_reviewer(project_root: Path) -> AgentOrchestrator | None:
    url = os.environ.get("CODEBUDDY_GATEWAY_URL") or os.environ.get("NGROK_URL") or ""
    password = os.environ.get("CODEBUDDY_GATEWAY_PASSWORD", "")
    if not url or not password:
        return None
    try:
        client = WorkBuddyClient(
            base_url=url,
            password=password,
            timeout_seconds=int(os.environ.get("TUTUPBUKU_AGENT_TIMEOUT_SECONDS", "180")),
        )
    except WorkBuddyError as exc:
        print(f"WorkBuddy gateway not used: {exc}", file=sys.stderr, flush=True)
        return None
    return AgentOrchestrator(project_root, client, deadline_seconds=int(os.environ.get("TUTUPBUKU_AGENT_DEADLINE_SECONDS", "600")), parallel=os.environ.get("TUTUPBUKU_PARALLEL_SUB_AGENTS") == "1")


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    load_env_file(project_root / ".env")

    parser = argparse.ArgumentParser(description="TutupBuku browser API and MCP server")
    parser.add_argument("--case", default="Sept2026", help="fixture case id (default: Sept2026)")
    parser.add_argument("--port", type=int, default=8765, help="local browser API port (default: 8765)")
    parser.add_argument("--frontend", action="store_true", help="also serve the built React app from frontend/dist")
    parser.add_argument("--web-only", action="store_true", help="serve HTTP only; do not start the MCP stdio server")
    args = parser.parse_args()

    ensure_working_case(project_root, args.case)
    service = TutupBukuService(project_root, args.case)
    agent_mode = os.environ.get("TUTUPBUKU_AGENT_MODE") == "1"
    api_token = os.environ.get("TUTUPBUKU_API_TOKEN") or None
    jobs = None
    mcp = MCPServer(service)
    if agent_mode:
        gateway_password = os.environ.get("CODEBUDDY_GATEWAY_PASSWORD", "")
        if not api_token or len(api_token) < 32 or not gateway_password:
            raise SystemExit("WorkBuddy mode requires TUTUPBUKU_API_TOKEN and CODEBUDDY_GATEWAY_PASSWORD; no service was started.")
        client = WorkBuddyClient(
            base_url=os.environ.get("CODEBUDDY_GATEWAY_URL", "http://127.0.0.1:8081"),
            password=gateway_password,
            timeout_seconds=int(os.environ.get("TUTUPBUKU_AGENT_TIMEOUT_SECONDS", "180")),
        )
        jobs = AgentReviewJobs(project_root, service, client)
        mcp = MCPServer(service, agent_mode=True, job_audit=jobs)

    reviewer = build_reviewer(project_root)
    executions = ExecutionManager(service, reviewer=reviewer)
    frontend_dist = (project_root / "frontend" / "dist") if args.frontend else None
    if frontend_dist is not None and not (frontend_dist / "index.html").is_file():
        print("Warning: frontend/dist/index.html not found. Run `npm run build` in the frontend folder.", file=sys.stderr, flush=True)

    records = build_record_store(dict(os.environ), project_root)
    storage = records.status()
    print(f"Records: {records.mode} - {'OK' if storage['ok'] else 'NOT AVAILABLE'}: {storage['message']}", file=sys.stderr, flush=True)
    browser = create_server(service, "127.0.0.1", args.port, api_token=api_token, agent_jobs=jobs, executions=executions, frontend_dist=frontend_dist, records=records)
    print(f"TutupBuku browser API: http://127.0.0.1:{browser.server_port}/", file=sys.stderr, flush=True)
    print("WorkBuddy agent: " + ("configured (main agent + sub-agents, each a separate gateway call)" if reviewer else "not configured (runs use the deterministic engine only)"), file=sys.stderr, flush=True)

    if args.web_only:
        try:
            browser.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            browser.server_close()
        return

    thread = Thread(target=browser.serve_forever, name="tutupbuku-browser-api", daemon=True)
    thread.start()
    try:
        serve_stdio(mcp)
    finally:
        browser.shutdown()
        browser.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
