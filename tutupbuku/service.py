"""Application service shared by WorkBuddy MCP calls and the browser API."""

from __future__ import annotations

import re
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any

from .engine import ReviewEngine
from .models import SUPPORTED_RECEIPT_SUFFIXES, SUPPORTED_ROOT_FILES


class TutupBukuService:
    def __init__(self, project_root: Path, default_case_id: str = "Sept2026", *,
                 fixtures_root: Path | None = None, persist_input_state: bool = True) -> None:
        self.project_root = Path(project_root).resolve()
        self.fixtures_root = Path(fixtures_root or self.project_root / "fixtures").resolve()
        self.persist_input_state = persist_input_state
        self.output_root = self.project_root
        self.default_case_id = default_case_id
        self._lock = threading.RLock()
        self._engines: dict[str, ReviewEngine] = {}
        self._engine_for(default_case_id)

    def _resolve_case_dir(self, case_id: str) -> Path:
        if not isinstance(case_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", case_id):
            raise ValueError("case_id contains unsupported characters")
        case_dir = (self.fixtures_root / case_id).resolve()
        if not case_dir.is_relative_to(self.fixtures_root) or not case_dir.is_dir():
            raise ValueError("case_id does not identify an available case")
        return case_dir

    def _engine_for(self, case_id: str | None = None) -> ReviewEngine:
        case_id = case_id or self.default_case_id
        with self._lock:
            if case_id not in self._engines:
                case_dir = self._resolve_case_dir(case_id)
                self._engines[case_id] = ReviewEngine(case_dir, self.output_root, case_id,
                                                    persist_input_state=self.persist_input_state)
            return self._engines[case_id]

    def list_cases(self) -> list[dict[str, Any]]:
        if not self.fixtures_root.is_dir():
            return []
        cases: list[dict[str, Any]] = []
        for folder in sorted(self.fixtures_root.iterdir(), key=lambda path: path.name.casefold()):
            if not folder.is_dir() or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", folder.name):
                continue
            try:
                engine = self._engine_for(folder.name)
                item = engine.get_case()
                cases.append(
                    {
                        "case_id": folder.name,
                        "business_name": item["business_name"],
                        "period_start": item["period_start"],
                        "period_end": item["period_end"],
                        "status": "ready" if item["files"] else "missing inputs",
                    }
                )
            except (OSError, ValueError):
                continue
        return cases

    def get_case(self, case_id: str | None = None) -> dict[str, Any]:
        return self._engine_for(case_id).get_case()

    def save_receipt_fields(
        self,
        case_id: str | None,
        receipt_id: str,
        document_date: str,
        supplier: str,
        total_myr: str,
        receipt_number: str = "",
        printed_note: str = "",
    ) -> dict[str, Any]:
        return self._engine_for(case_id).save_receipt_fields(
            receipt_id, document_date, supplier, total_myr, receipt_number, printed_note
        )

    def run_matching(self, case_id: str | None = None) -> dict[str, Any]:
        return self._engine_for(case_id).run_matching()

    def get_review_items(self, case_id: str | None = None) -> list[dict[str, Any]]:
        return self._engine_for(case_id).get_review_items()

    def save_decision(
        self,
        case_id: str | None,
        bank_row_id: str,
        candidate_id: str | None,
        answer: str,
    ) -> dict[str, Any]:
        if candidate_id is not None and not isinstance(candidate_id, str):
            raise ValueError("candidate_id must be a candidate ID or null")
        return self._engine_for(case_id).save_decision(bank_row_id, candidate_id, answer)

    def build_review_pack(self, case_id: str | None = None) -> dict[str, Any]:
        engine = self._engine_for(case_id)
        paths = engine.build_review_pack()
        return {
            "status": "Review pack exported",
            "case_id": engine.case_id,
            "output_dir": paths[0].parent.relative_to(self.project_root).as_posix(),
            "files": [path.name for path in paths],
            "decision_count": len(engine.get_case()["decisions"]),
            "open_item_count": len(engine.run_matching()["exceptions"]),
            "message": "This is a review pack, not a completed accounting close.",
        }

    def upload_source(self, relative_path: str, content: bytes, case_id: str | None = None) -> dict[str, Any]:
        return self._engine_for(case_id).upload_source(relative_path, content)

    def source_path(self, relative_path: str, case_id: str | None = None) -> Path:
        engine = self._engine_for(case_id)
        if not isinstance(relative_path, str) or "\\" in relative_path:
            raise ValueError("source path is invalid")
        parts = relative_path.split("/")
        allowed = (
            relative_path in SUPPORTED_ROOT_FILES
            or (
                len(parts) == 2
                and parts[0] == "receipts"
                and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", Path(parts[1]).stem)
                and Path(parts[1]).suffix.casefold() in SUPPORTED_RECEIPT_SUFFIXES
            )
        )
        if not allowed:
            raise ValueError("source path is not in the supported input set")
        target = (engine.case_dir / Path(relative_path)).resolve()
        if not target.is_relative_to(engine.case_dir) or not target.is_file():
            raise ValueError("source file is not available")
        return target

    def export_path(self, filename: str, case_id: str | None = None) -> Path:
        if filename not in {
            "01_proposals.csv", "02_exceptions.md", "03_records_summary.md", "04_decisions_log.csv", "05_manifest.csv"
        }:
            raise ValueError("export filename is not in the allow-list")
        engine = self._engine_for(case_id)
        if not engine.is_review_pack_current():
            raise ValueError("review pack is stale or has not been built")
        target = (self.output_root / f"review_pack_{engine.case_id}" / filename).resolve()
        expected_root = (self.output_root / f"review_pack_{engine.case_id}").resolve()
        if not target.is_relative_to(expected_root) or not target.is_file():
            raise ValueError("review pack has not been built for that file")
        return target

    def review_pack_status(self, case_id: str | None = None) -> dict[str, Any]:
        engine = self._engine_for(case_id)
        names = [
            "01_proposals.csv",
            "02_exceptions.md",
            "03_records_summary.md",
            "04_decisions_log.csv",
            "05_manifest.csv",
        ]
        try:
            if not engine.is_review_pack_current():
                return {"status": "stale or not built", "files": [], "case_id": engine.case_id}
            files = [self.export_path(name, engine.case_id) for name in names]
        except ValueError:
            return {"status": "stale or not built", "files": [], "case_id": engine.case_id}
        result = engine.run_matching()
        return {
            "status": "Review pack exported",
            "case_id": engine.case_id,
            "files": [path.name for path in files],
            "decision_count": len(engine.get_case()["decisions"]),
            "open_item_count": len(result["exceptions"]),
            "message": "This is a review pack, not a completed accounting close.",
        }
    def reset_demo_data(self, case_id: str, confirmation: str) -> dict[str, Any]:
        """Restore only the named synthetic demo case from its checked-in baseline."""
        if case_id != "Sept2026" or confirmation != "RESET_SYNTHETIC_DEMO":
            raise ValueError("reset is limited to Sept2026 and requires explicit confirmation")
        case_dir = self._resolve_case_dir(case_id)
        template = (self.project_root / "demo-fixtures" / case_id).resolve()
        if not template.is_relative_to(self.project_root) or not template.is_dir():
            raise FileNotFoundError("the synthetic demo baseline is not available")
        stage = self.fixtures_root / f".{case_id}.reset-stage-{uuid.uuid4().hex}"
        backup = self.fixtures_root / f".{case_id}.reset-backup-{uuid.uuid4().hex}"
        if not stage.resolve().is_relative_to(self.fixtures_root) or not backup.resolve().is_relative_to(self.fixtures_root):
            raise ValueError("reset staging path escaped the fixtures directory")
        try:
            shutil.copytree(template, stage)
            case_dir.rename(backup)
            try:
                stage.rename(case_dir)
            except Exception:
                backup.rename(case_dir)
                raise
            shutil.rmtree(backup)
        except Exception:
            if stage.exists():
                shutil.rmtree(stage)
            raise
        with self._lock:
            self._engines.pop(case_id, None)
        restored = self.get_case(case_id)
        return {
            "status": "reset",
            "case_id": case_id,
            "business_name": restored["business_name"],
            "message": "The Sept2026 synthetic case was restored. Re-run checks before reviewing or exporting.",
        }
