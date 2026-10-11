"""Run the loopback browser API and WorkBuddy MCP against one shared case service."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from threading import Thread

from .mcp_server import MCPServer, serve_stdio
from .service import TutupBukuService
from .web import create_server
from .workbuddy import AgentReviewJobs, WorkBuddyClient


def main() -> None:
    parser = argparse.ArgumentParser(description="TutupBuku browser API and MCP server")
    parser.add_argument("--case", default="Sept2026", help="fixture case id (default: Sept2026)")
    parser.add_argument("--port", type=int, default=8765, help="local browser API port (default: 8765)")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
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

    browser = create_server(service, "127.0.0.1", args.port, api_token=api_token, agent_jobs=jobs)
    thread = Thread(target=browser.serve_forever, name="tutupbuku-browser-api", daemon=True)
    thread.start()
    print(f"TutupBuku browser API: http://127.0.0.1:{browser.server_port}/", file=sys.stderr, flush=True)
    try:
        serve_stdio(mcp)
    finally:
        browser.shutdown()
        browser.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()