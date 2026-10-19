"""Single-workspace Vercel Daemon entry point and database mailbox worker."""
from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .daemon_api import validate_target
from .daemon_store import DaemonStoreError, PostgresDaemonStore

HEARTBEAT_SECONDS = 8
IDLE_POLL_SECONDS = 2.0
PRUNE_SECONDS = 900


def _json_response(status: int, message: str) -> dict[str, Any]:
    return {"status": status, "headers": {"Content-Type": "application/json"},
            "body": base64.b64encode(json.dumps({"error": message}, separators=(",", ":")).encode()).decode("ascii")}


class Worker:
    """Claim once, execute once, then atomically save response and filesystem state."""

    def __init__(self, store: Any, runtime: Any, owner: str) -> None:
        self.store = store
        self.runtime = runtime
        self.owner = owner
        self.stop_requested = False

    def step(self) -> bool:
        command = self.store.claim(self.owner)
        if command is None:
            return False
        job_id = command["id"]
        try:
            validate_target(command["method"], command["path"])
        except (KeyError, TypeError, ValueError):
            self.store.complete(self.owner, job_id, _json_response(400, "Worker route is not allowed."), self.runtime.snapshot())
            return True
        try:
            response = self.runtime.handle(command["method"], command["path"], command.get("payload"), command.get("headers"))
            if not isinstance(response, dict) or type(response.get("status")) is not int or not 200 <= response["status"] <= 599:
                raise RuntimeError("invalid response")
            body = response.get("body")
            if not isinstance(body, str):
                raise RuntimeError("invalid response body")
            # Verify its encoding and size before storing the result. The runtime
            # has already handled the request, so malformed replies are uncertain.
            decoded = base64.b64decode(body, validate=True)
            if len(decoded) > 3 * 1024 * 1024:
                raise RuntimeError("response too large")
            headers = response.get("headers", {})
            if not isinstance(headers, dict):
                raise RuntimeError("invalid response headers")
            safe_headers = {str(key): str(value) for key, value in headers.items()
                            if str(key).casefold() in {"content-type", "content-disposition"}
                            and "\r" not in str(value) and "\n" not in str(value)}
            response = {"status": response["status"], "headers": safe_headers, "body": body}
            snapshot = self.runtime.snapshot()
        except Exception:
            # The local request may already have triggered a paid model call or
            # mutation. Never repeat it when the result cannot be confirmed.
            self.store.mark_unconfirmed(self.owner, job_id)
            self.stop_requested = True
            return True
        self.store.complete(self.owner, job_id, response, snapshot)
        return True


def _worker_environment(env: dict[str, str]) -> dict[str, str]:
    """Give the agent CLI only its account token and basic process settings."""
    safe = {key: env[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI") if env.get(key)}
    token = env.get("CODEBUDDY_AUTH_TOKEN", "")
    if token:
        safe["CODEBUDDY_AUTH_TOKEN"] = token
    return safe


def _store_from_environment(env: dict[str, str]) -> PostgresDaemonStore:
    url = (env.get("DATABASE_URL") or "").strip()
    if not url.startswith(("postgres://", "postgresql://")):
        raise DaemonStoreError("The worker requires a PostgreSQL DATABASE_URL.", code="DATABASE_NOT_CONFIGURED")
    try:
        max_posts = int(env.get("TUTUPBUKU_WORKER_MAX_COMMANDS_PER_HOUR", "120"))
    except ValueError:
        raise DaemonStoreError("TUTUPBUKU_WORKER_MAX_COMMANDS_PER_HOUR must be an integer.", 400, "WORKER_CONFIG") from None
    return PostgresDaemonStore(url, workspace=env.get("TUTUPBUKU_WORKER_WORKSPACE", "default"),
                               max_posts_per_hour=max_posts)


def _run(store: PostgresDaemonStore, env: dict[str, str], *, source_root: Path | None = None) -> int:
    from .daemon_gateway import GatewayProcess
    from .daemon_runtime import LocalRuntime, restore_files
    from .workbuddy import WorkBuddyError

    root = Path(source_root or Path(__file__).resolve().parents[1]).resolve()
    owner = str(uuid.uuid4())
    if not store.acquire(owner):
        print("A worker already owns this workspace; this instance is stopping.", file=sys.stderr, flush=True)
        return 1

    stop = threading.Event()
    lease_lost = threading.Event()
    runtime: LocalRuntime | None = None
    gateway: GatewayProcess | None = None
    heartbeat: threading.Thread | None = None
    tempdir: tempfile.TemporaryDirectory | None = None

    def heartbeat_loop() -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                if gateway is not None and not gateway.healthy:
                    stop.set()
                    gateway.stop()
                    return
                # Persist the filesystem once per confirmed command (and on
                # clean shutdown), not on every lease tick. A command in
                # progress remains running and becomes unconfirmed on takeover.
                if not store.checkpoint(owner, None, ready=runtime is not None):
                    lease_lost.set()
                    stop.set()
                    if gateway is not None:
                        gateway.stop()
                    return
            except Exception:
                # A missed fence/heartbeat means this container cannot safely
                # keep using the account or write state. Stop upstream requests.
                lease_lost.set()
                stop.set()
                if gateway is not None:
                    gateway.stop()
                return

    def on_signal(_signum, _frame) -> None:
        stop.set()
        if gateway is not None:
            gateway.stop()

    previous_handlers: dict[int, Any] = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            previous_handlers[signum] = signal.signal(signum, on_signal)
        except (ValueError, OSError):
            pass

    try:
        tempdir = tempfile.TemporaryDirectory(prefix="tutupbuku-worker-")
        state_root = Path(tempdir.name)
        heartbeat = threading.Thread(target=heartbeat_loop, name="tutupbuku-lease-heartbeat", daemon=True)
        heartbeat.start()
        restore_files(state_root, store.restore())

        if not env.get("CODEBUDDY_AUTH_TOKEN"):
            raise WorkBuddyError("Configure the existing-account CODEBUDDY_AUTH_TOKEN secret before starting a worker.",
                                 "GATEWAY_NOT_CONFIGURED")
        gateway = GatewayProcess(root, env=_worker_environment(env))
        client = gateway.start()
        if stop.is_set():
            return 1

        runtime = LocalRuntime(root, state_root, client, synchronous=True)
        runtime.start()
        if not store.checkpoint(owner, runtime.snapshot(), ready=True):
            lease_lost.set()
            raise DaemonStoreError("Worker lease was lost during startup.", 409, "LEASE_LOST")
        print("WorkBuddy worker is ready for its configured workspace.", file=sys.stderr, flush=True)
        worker = Worker(store, runtime, owner)
        last_prune = time.monotonic()
        while not stop.is_set():
            try:
                did_work = worker.step()
            except DaemonStoreError:
                stop.set()
                break
            except Exception:
                stop.set()
                break
            if worker.stop_requested:
                stop.set()
                break
            if time.monotonic() - last_prune >= PRUNE_SECONDS:
                try:
                    store.prune()
                except Exception:
                    stop.set()
                    break
                last_prune = time.monotonic()
            if not did_work:
                stop.wait(IDLE_POLL_SECONDS)
        return 1 if lease_lost.is_set() else 0
    except WorkBuddyError as exc:
        print(f"Worker startup stopped ({exc.code}).", file=sys.stderr, flush=True)
        return 1
    except (DaemonStoreError, OSError, ValueError):
        print("Worker startup stopped because its database or saved workspace is unavailable.", file=sys.stderr, flush=True)
        return 1
    except Exception:
        print("Worker startup stopped because its local runtime could not be initialized.", file=sys.stderr, flush=True)
        return 1
    finally:
        stop.set()
        if gateway is not None:
            gateway.stop()
        if heartbeat is not None and heartbeat is not threading.current_thread():
            heartbeat.join(timeout=20)
        if runtime is not None:
            try:
                store.checkpoint(owner, runtime.snapshot(), ready=False)
            except Exception:
                pass
            runtime.stop()
        if tempdir is not None:
            tempdir.cleanup()
        try:
            store.release(owner)
        except Exception:
            pass
        for signum, handler in previous_handlers.items():
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the TutupBuku Vercel Daemon worker")
    parser.add_argument("--migrate", action="store_true", help="apply the explicit additive daemon SQL migration and exit")
    args = parser.parse_args()
    env = dict(os.environ)
    try:
        store = _store_from_environment(env)
        if args.migrate:
            store.initialize()
            print("Daemon tables and indexes are ready.", file=sys.stderr, flush=True)
            return
        if env.get("TUTUPBUKU_DAEMON_ENABLED") != "1":
            raise DaemonStoreError("Set TUTUPBUKU_DAEMON_ENABLED=1 only after database migration and account setup.",
                                   code="WORKER_DISABLED")
        if not env.get("CODEBUDDY_AUTH_TOKEN"):
            raise DaemonStoreError("Configure the existing-account CODEBUDDY_AUTH_TOKEN secret before scaling this worker.",
                                   code="GATEWAY_NOT_CONFIGURED")
        raise SystemExit(_run(store, env))
    except DaemonStoreError as exc:
        print(f"{exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None
    except ValueError as exc:
        print(f"{exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
