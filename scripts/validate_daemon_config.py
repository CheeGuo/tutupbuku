"""Check the supported Daemons deployment configuration without network access.

Constraints were checked against https://openapi.vercel.sh/vercel.json and
https://vercel.com/docs/daemons/config-reference on 2026-10-19. This checks the
current daemon fields and local paths, not the full Vercel project schema,
account quotas, a container build, credentials, or worker readiness.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


REGIONS = frozenset({
    "iad1", "cle1", "cdg1", "sfo1", "arn1", "bom1", "cpt1", "dub1", "fra1",
    "gru1", "hkg1", "hnd1", "icn1", "kix1", "lhr1", "pdx1", "sin1", "syd1", "yul1",
})
FIELDS = frozenset({
    "root", "entrypoint", "instances", "command", "resources", "terminationGracePeriodSeconds",
})
NAME = re.compile(r"[a-z]+(?:(?:_|__|-+)[a-z]+)*")


def _contained_path(value: Any, parent: Path, label: str, errors: list[str]) -> Path | None:
    if not isinstance(value, str) or not 1 <= len(value) <= 512:
        errors.append(f"{label} must be a nonempty path of at most 512 characters.")
        return None
    try:
        path = Path(value)
        if path.is_absolute():
            raise ValueError("absolute path")
        resolved = (parent / path).resolve()
        if not resolved.is_relative_to(parent):
            raise ValueError("path outside parent")
        return resolved
    except (OSError, ValueError):
        errors.append(f"{label} must stay inside {parent}.")
        return None


def validate_config(config: Any, project_root: Path) -> list[str]:
    """Return configuration errors; never connect, install, deploy, or run code."""
    errors: list[str] = []
    if not isinstance(config, dict):
        return ["The project configuration must be a JSON object."]
    daemons = config.get("daemons")
    if not isinstance(daemons, dict) or not 1 <= len(daemons) <= 100:
        return ["daemons must contain between 1 and 100 named daemon configurations."]
    project_root = Path(project_root).resolve()
    for name, daemon in daemons.items():
        label = f"daemons.{name}"
        if not isinstance(name, str) or len(name) > 64 or NAME.fullmatch(name) is None:
            errors.append(f"{label}: invalid daemon name.")
        if not isinstance(daemon, dict):
            errors.append(f"{label} must be an object.")
            continue
        unknown = set(daemon) - FIELDS
        if unknown:
            errors.append(f"{label}: unsupported fields: {', '.join(sorted(unknown))}.")
        for field in ("root", "entrypoint", "instances"):
            if field not in daemon:
                errors.append(f"{label}.{field} is required.")

        root = _contained_path(daemon.get("root"), project_root, f"{label}.root", errors)
        if root is not None:
            if not root.is_dir():
                errors.append(f"{label}.root does not exist as a directory.")
            entrypoint = _contained_path(daemon.get("entrypoint"), root, f"{label}.entrypoint", errors)
            if entrypoint is not None and not entrypoint.is_file():
                errors.append(f"{label}.entrypoint does not exist as a file.")

        instances = daemon.get("instances")
        if not isinstance(instances, dict) or not instances:
            errors.append(f"{label}.instances must map regions to instance counts.")
        else:
            for region, count in instances.items():
                if region not in REGIONS:
                    errors.append(f"{label}.instances: unsupported region {region!r}.")
                if type(count) is not int or not 0 <= count <= 100:
                    errors.append(f"{label}.instances.{region} must be an integer from 0 to 100.")

        if "command" in daemon:
            command = daemon["command"]
            if (not isinstance(command, list) or not 1 <= len(command) <= 128
                    or any(not isinstance(item, str) or not 1 <= len(item) <= 4096 for item in command)):
                errors.append(f"{label}.command must contain 1 to 128 nonempty string arguments.")

        if "resources" in daemon:
            resources = daemon["resources"]
            requests = resources.get("requests") if isinstance(resources, dict) else None
            if (not isinstance(resources, dict) or set(resources) != {"requests"}
                    or not isinstance(requests, dict) or set(requests) != {"memory"}
                    or requests["memory"] not in ("1Gi", "2Gi", "4Gi", "8Gi")):
                errors.append(f"{label}.resources.requests.memory must be 1Gi, 2Gi, 4Gi, or 8Gi.")

        if "terminationGracePeriodSeconds" in daemon:
            grace = daemon["terminationGracePeriodSeconds"]
            if type(grace) is not int or not 0 <= grace <= 3600:
                errors.append(f"{label}.terminationGracePeriodSeconds must be an integer from 0 to 3600.")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[1] / "vercel.json")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"Cannot read configuration: {exc}", file=sys.stderr)
        return 1
    errors = validate_config(config, args.config.resolve().parent)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("Daemon configuration valid (offline structural and path checks; no image build or runtime check).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
