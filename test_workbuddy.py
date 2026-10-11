#!/usr/bin/env python3
"""Send one AI test through the CodeBuddy gateway configured in .env.

Run: python3 test_workbuddy.py
Or:  python3 test_workbuddy.py "Say hello in one sentence."
Uses only Python's standard library. Each run makes one AI request.
Prints raw server output (run response + every stream line).
"""

import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


DEFAULT_PROMPT = (
    "Reply exactly WORKBUDDY_OK. Do not use tools. "
    "Do not read or modify files."
)


def load_settings():
    values = {}
    env_file = Path(__file__).resolve().with_name(".env")
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            value = value.strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1]
            values[key.strip()] = value
    values.update(os.environ)
    base = values.get("CODEBUDDY_GATEWAY_URL") or values.get("NGROK_URL", "")
    password = values.get("CODEBUDDY_GATEWAY_PASSWORD", "")
    if not base or not password:
        raise RuntimeError(
            "Set CODEBUDDY_GATEWAY_URL (or NGROK_URL) and "
            "CODEBUDDY_GATEWAY_PASSWORD in .env."
        )
    url = urllib.parse.urlsplit(base)
    if url.scheme not in ("http", "https") or not url.hostname:
        raise RuntimeError("The gateway URL must be an HTTP or HTTPS address.")
    if url.username or url.password or url.query or url.fragment:
        raise RuntimeError("The gateway URL must not contain credentials, a query, or a fragment.")
    return base.rstrip("/"), password


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Do not forward the password to another address.


def run_test(prompt, timeout):
    base, password = load_settings()
    opener = urllib.request.build_opener(NoRedirect())
    headers = {
        "Authorization": "Bearer " + password,
        "X-CodeBuddy-Request": "1",
        "ngrok-skip-browser-warning": "1",
    }
    request_id = str(uuid.uuid4())
    payload = {
        "id": request_id,
        "type": "message",
        "source": {
            "platform": "generic",
            "sender": {"id": "python-ai-test"},
            "conversation": {"id": request_id, "type": "direct"},
        },
        "payload": {"text": prompt},
        "timeoutMs": timeout * 1000,
    }
    request = urllib.request.Request(
        base + "/api/v1/runs",
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
    )
    deadline = time.monotonic() + timeout
    with opener.open(request, timeout=timeout) as response:
        raw_body = response.read().decode("utf-8")
    print("RAW RUN RESPONSE:\n" + raw_body, flush=True)
    accepted = json.loads(raw_body).get("data", {})
    run_id = accepted.get("runId")
    if accepted.get("status") != "accepted" or not run_id:
        raise RuntimeError("The gateway did not accept an AI run.")
    print("Run accepted:", run_id, flush=True)
    print("Waiting for the AI response...", flush=True)
    stream_url = base + "/api/v1/runs/" + urllib.parse.quote(run_id, safe="") + "/stream"
    request = urllib.request.Request(stream_url, headers=headers)
    with opener.open(request, timeout=max(1, deadline - time.monotonic())) as response:
        if "text/event-stream" not in response.headers.get("Content-Type", ""):
            raise RuntimeError("The gateway did not return an AI event stream.")
        event, data, received = "message", [], 0
        for raw_line in response:
            received += len(raw_line)
            print("RAW:", raw_line.decode("utf-8", "replace").rstrip("\r\n"), flush=True)
            if received > 262144 or time.monotonic() > deadline:
                raise RuntimeError("The AI test exceeded its size or time limit.")
            line = raw_line.decode("utf-8").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
            elif not line:
                if event == "error":
                    raise RuntimeError("The gateway reported an AI execution error.")
                if data and event == "message":
                    message = json.loads("\n".join(data))
                    if message.get("replyTo") != request_id:
                        raise RuntimeError("The gateway returned a response for another request.")
                    if message.get("status") == "error":
                        raise RuntimeError("The AI run failed; inspect the CodeBuddy logs.")
                    if message.get("status") == "completed":
                        content = message.get("content") or {}
                        answer = content.get("markdown") or content.get("text")
                        if not isinstance(answer, str) or not answer.strip():
                            raise RuntimeError("The AI completed without a text response.")
                        return answer.strip()
                event, data = "message", []
    raise RuntimeError("The stream ended without a final AI response.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default=DEFAULT_PROMPT)
    parser.add_argument("--timeout", type=int, default=120, help="Timeout in seconds (default: 120)")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        answer = run_test(args.prompt, args.timeout)
        print("\nAI response:\n" + answer)
        if args.prompt == DEFAULT_PROMPT and answer != "WORKBUDDY_OK":
            raise RuntimeError("The AI replied but did not return the expected test phrase.")
    except urllib.error.HTTPError as error:
        print(f"Error: gateway returned HTTP {error.code}. Check the URL, password, and ngrok tunnel.", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError) as error:
        print("Error:", error, file=sys.stderr)
        print("Do not assume the run succeeded or automatically resubmit it.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())