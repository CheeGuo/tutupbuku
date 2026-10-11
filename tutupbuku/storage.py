"""Portable, atomic JSON state and allow-listed source file storage."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from .models import SUPPORTED_RECEIPT_SUFFIXES, SUPPORTED_ROOT_FILES


class CaseStorage:
    def __init__(self, case_dir: Path) -> None:
        self.case_dir = Path(case_dir).resolve()
        if not self.case_dir.is_dir():
            raise FileNotFoundError(f"case directory not found: {self.case_dir}")
        self.state_path = self.case_dir / "run_state.json"

    def load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {
                "state_version": 1,
                "rule_version": "2026-10-10.1",
                "source_hashes": {},
                "receipt_fields": {},
                "decisions": [],
                "last_matching": None,
            }
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"saved run_state.json is unreadable: {exc}") from exc
        if not isinstance(state, dict) or state.get("state_version") != 1:
            raise ValueError("unsupported or invalid run_state.json version")
        state.setdefault("source_hashes", {})
        state.setdefault("receipt_fields", {})
        state.setdefault("decisions", [])
        state.setdefault("last_matching", None)
        state["rule_version"] = "2026-10-10.1"
        return state

    def save_state(self, state: dict[str, Any]) -> None:
        payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        self._atomic_write(self.state_path, payload.encode("utf-8"))

    def source_paths(self) -> list[Path]:
        paths: list[Path] = []
        for path in self.case_dir.rglob("*"):
            if not path.is_file() or path.name == "run_state.json" or path.name.startswith((".run_state.json-", "run_state.json.")):
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(self.case_dir):
                continue
            paths.append(path)
        return sorted(paths, key=lambda item: item.relative_to(self.case_dir).as_posix().casefold())

    def source_hashes(self) -> dict[str, str]:
        return {
            path.relative_to(self.case_dir).as_posix(): self.sha256(path.read_bytes())
            for path in self.source_paths()
        }

    @staticmethod
    def sha256(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    def source_manifest(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for path in self.source_paths():
            relative = path.relative_to(self.case_dir).as_posix()
            receipt = relative.startswith("receipts/")
            supported = (
                relative in SUPPORTED_ROOT_FILES
                or (receipt and path.suffix.casefold() in SUPPORTED_RECEIPT_SUFFIXES)
            )
            entries.append(
                {
                    "path": relative,
                    "sha256": self.sha256(path.read_bytes()),
                    "size_bytes": path.stat().st_size,
                    "supported": supported,
                    "status": "supplied" if supported else "unsupported file",
                }
            )
        return entries

    def write_source(self, relative_path: str, content: bytes) -> Path:
        """Write only a supported input path, atomically and within the case."""
        if not isinstance(relative_path, str) or "\\" in relative_path:
            raise ValueError("upload path must use a relative slash-separated name")
        parsed = PurePosixPath(relative_path)
        if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
            raise ValueError("upload path is not allowed")
        if len(parsed.parts) == 1:
            allowed = parsed.name in SUPPORTED_ROOT_FILES
        else:
            allowed = (
                len(parsed.parts) == 2
                and parsed.parts[0] == "receipts"
                and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", Path(parsed.name).stem) is not None
                and Path(parsed.name).suffix.casefold() in SUPPORTED_RECEIPT_SUFFIXES
            )
        if not allowed:
            raise ValueError("unsupported input path")
        target = self.case_dir.joinpath(*parsed.parts)
        if not target.resolve().is_relative_to(self.case_dir):
            raise ValueError("upload path escapes the case directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(target, content)
        return target

    @staticmethod
    def _atomic_write(target: Path, content: bytes) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle, name = tempfile.mkstemp(prefix=f".{target.name}-", suffix=".tmp", dir=target.parent)
        temp_path = Path(name)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, target)
        finally:
            temp_path.unlink(missing_ok=True)
