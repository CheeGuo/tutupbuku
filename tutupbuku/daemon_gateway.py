"""Own a pinned CodeBuddy gateway inside the worker's Linux container.

CODEBUDDY_AUTH_TOKEN authenticates the existing CodeBuddy account upstream.
CODEBUDDY_GATEWAY_PASSWORD protects only the private loopback HTTP service.
An injected account token is not refreshed by this module. Readiness checks
only the local gateway; they neither submit a model request nor prove credits
or upstream account authorization.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import Mapping
from urllib.error import URLError
from urllib.request import Request, urlopen

from .workbuddy import WorkBuddyClient, WorkBuddyError

CODEBUDDY_VERSION = "2.164.0"
GATEWAY_URL = "http://127.0.0.1:8081"
STARTUP_TIMEOUT_SECONDS = 60


def _valid_secret(value: str | None) -> bool:
    return isinstance(value, str) and bool(value) and not any(character.isspace() for character in value)


class GatewayProcess:
    """Start and stop the foreground CLI without reading cached credentials."""

    def __init__(self, project_root: Path, env: Mapping[str, str] | None = None) -> None:
        self.project_root = Path(project_root).resolve()
        self._env = dict(os.environ if env is None else env)
        self._process: subprocess.Popen | None = None
        self._client: WorkBuddyClient | None = None

    @property
    def configured(self) -> bool:
        """Presence/format only; never expose, validate remotely, or export a token."""
        return _valid_secret(self._env.get("CODEBUDDY_AUTH_TOKEN"))

    @property
    def healthy(self) -> bool:
        """Check only that the local child and its loopback health endpoint respond."""
        return bool(self._process is not None and self._process.poll() is None and self._health_ready())

    def start(self) -> WorkBuddyClient:
        if self._process is not None and self._process.poll() is None and self._client is not None:
            return self._client
        self.stop()
        if not self.configured:
            raise WorkBuddyError(
                "An existing-account CODEBUDDY_AUTH_TOKEN must be securely configured for the worker.",
                "GATEWAY_NOT_CONFIGURED",
            )
        executable = shutil.which("codebuddy", path=self._env.get("PATH"))
        if not executable:
            raise WorkBuddyError("The pinned CodeBuddy CLI is not installed in the worker.", "GATEWAY_EXECUTABLE")
        password = self._env.get("CODEBUDDY_GATEWAY_PASSWORD") or secrets.token_urlsafe(32)
        if not _valid_secret(password):
            raise WorkBuddyError("The private gateway password has an invalid format.", "GATEWAY_CONFIG")
        child_env = self._env.copy()
        # Keep this worker on the account-token path, including when a host has
        # unrelated provider credentials or a custom model endpoint configured.
        child_env.pop("CODEBUDDY_API_KEY", None)
        child_env.pop("CODEBUDDY_BASE_URL", None)
        child_env.update(
            CODEBUDDY_GATEWAY_PASSWORD=password,
            CODEBUDDY_GATEWAY_AUTH="password",
            CODEBUDDY_FORCE_HEADLESS_BUNDLE="1",
            DISABLE_AUTOUPDATER="1",
        )
        try:
            version = subprocess.run(
                [executable, "--version"],
                cwd=self.project_root,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            raise WorkBuddyError("The CodeBuddy CLI version could not be verified.", "GATEWAY_EXECUTABLE") from None
        if version.returncode != 0 or version.stdout.strip() != CODEBUDDY_VERSION:
            raise WorkBuddyError(
                f"The worker requires CodeBuddy CLI {CODEBUDDY_VERSION}.",
                "GATEWAY_VERSION",
            )
        command = [
            executable,
            "--serve", "--host", "127.0.0.1", "--port", "8081",
            "--auth", "password", "--agent", "cli",
            "--permission-mode", "dontAsk", "--tools", "",
            "--strict-mcp-config", "--no-session-persistence",
        ]
        try:
            self._process = subprocess.Popen(
                command,
                cwd=self.project_root,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            raise WorkBuddyError("The private CodeBuddy gateway could not be started.", "GATEWAY_START_FAILED") from None
        try:
            deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    raise WorkBuddyError(
                        "The private CodeBuddy gateway exited before becoming ready.",
                        "GATEWAY_START_FAILED",
                    )
                if self._health_ready():
                    self._client = WorkBuddyClient(GATEWAY_URL, password=password)
                    return self._client
                time.sleep(0.25)
            raise WorkBuddyError(
                "The private CodeBuddy gateway did not become ready before the startup timeout.",
                "GATEWAY_START_TIMEOUT",
            )
        except BaseException:
            self.stop()
            raise

    @staticmethod
    def _health_ready() -> bool:
        # The documented health endpoint is exempt from authentication. Do not
        # send either account or gateway credentials during readiness polling.
        try:
            request = Request(f"{GATEWAY_URL}/api/v1/health", headers={"Accept": "application/json"})
            with urlopen(request, timeout=1) as response:
                raw = response.read(8193)
            if len(raw) > 8192:
                return False
            value = json.loads(raw)
            return isinstance(value, dict) and isinstance(value.get("data"), dict) and value["data"].get("status") == "ok"
        except (URLError, OSError, ValueError, UnicodeDecodeError):
            return False

    def stop(self) -> None:
        process, self._process = self._process, None
        self._client = None
        if process is None:
            return
        try:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError):
            # Cleanup must not replace the original startup/worker error or
            # expose details supplied by the child process.
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass

    def __enter__(self) -> WorkBuddyClient:
        return self.start()

    def __exit__(self, *args: object) -> None:
        self.stop()
