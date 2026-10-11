"""Deterministic rendering and atomic publication of the five review-pack files."""

from __future__ import annotations

import csv
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .engine import format_sen

EXPORT_NAMES = (
    "01_proposals.csv",
    "02_exceptions.md",
    "03_records_summary.md",
    "04_decisions_log.csv",
    "05_manifest.csv",
)


def _csv_safe_text(value: Any) -> str:
    text = "" if value is None else str(value)
    if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + text
    return text


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, Any]], numeric: set[str] | None = None) -> None:
    numeric = numeric or set()
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            safe = {
                key: (value if key in numeric else _csv_safe_text(value))
                for key, value in row.items()
            }
            writer.writerow(safe)


def _pack_reference(case_dir: Path, destination: Path, source_ref: str) -> str:
    path_part, marker, anchor = source_ref.partition("#")
    target = (case_dir / Path(path_part)).resolve()
    if not target.is_relative_to(case_dir.resolve()):
        raise ValueError("source reference escapes the case directory")
    relative = os.path.relpath(target, destination).replace("\\", "/")
    return relative + (f"#{anchor}" if marker else "")


def _markdown_text(value: Any) -> str:
    text = "" if value is None else str(value)
    for token in ("\\", "`", "*", "_", "[", "]", "<", ">", "|"):
        text = text.replace(token, "\\" + token)
    return text.replace("\r", " ").replace("\n", " ")


def render_review_pack(
    *,
    case_id: str,
    case_dir: Path,
    output_root: Path,
    result: dict[str, Any],
    state: dict[str, Any],
    source_manifest: list[dict[str, Any]],
    business_name: str,
    metadata: dict[str, Any],
    opening_balance_sen: int,
    closing_balance_sen: int,
) -> list[Path]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", case_id):
        raise ValueError("case ID contains unsupported path characters")
    output_root.mkdir(parents=True, exist_ok=True)
    destination = output_root / f"review_pack_{case_id}"
    stage = Path(tempfile.mkdtemp(prefix=f".{destination.name}-stage-", dir=output_root))
    backup: Path | None = None
    try:
        proposals = result["bank_rows"]
        proposal_rows: list[dict[str, Any]] = []
        for row in proposals:
            source_refs = [f"bank.csv#row={row['row_id']}" ]
            source_refs.extend(item["source_path"] for item in row.get("candidates", []))
            source_refs.extend(item["source_path"] for item in row.get("unsupported_candidates", []))
            links = [
                f"[{_markdown_text(ref)}]({_pack_reference(case_dir, destination, ref)})"
                for ref in source_refs
            ]
            proposal_rows.append(
                {
                    "row_id": row["row_id"],
                    "bank_date": row["date"],
                    "description": row["description"],
                    "bank_amount_myr": row["amount_myr"],
                    "proposed_match_id": row.get("proposed_match_id") or "",
                    "proposal_type": row.get("match_type") or "",
                    "state": row["state"],
                    "reason_code": row["reason_code"],
                    "reason": row["reason"],
                    "source_refs": "; ".join(links),
                    "decision_id": row.get("decision_id") or "",
                }
            )
        _write_csv(
            stage / "01_proposals.csv",
            ["row_id", "bank_date", "description", "bank_amount_myr", "proposed_match_id", "proposal_type", "state", "reason_code", "reason", "source_refs", "decision_id"],
            proposal_rows,
            numeric={"bank_amount_myr"},
        )

        exception_lines = [
            "# Exceptions and open items",
            "",
            "These are review prompts based only on supplied records. They are not conclusions that a transaction is wrong or that the books are complete.",
            "",
        ]
        if not result["exceptions"]:
            exception_lines.append("No exceptions were raised by the supported checks.")
        for item in result["exceptions"]:
            refs = [
                f"[{_markdown_text(ref)}]({_pack_reference(case_dir, destination, ref)})"
                for ref in item.get("source_refs", [])
            ]
            exception_lines.extend(
                [
                    f"## {_markdown_text(item['title'])}",
                    "",
                    f"- ID: `{_markdown_text(item['exception_id'])}`",
                    f"- Status: {_markdown_text(item['status'])}",
                    f"- Reason code: `{_markdown_text(item['reason_code'])}`",
                    f"- Evidence: {_markdown_text(item['reason'])}",
                    f"- Candidate IDs: {_markdown_text(', '.join(item.get('candidate_ids', [])) or 'none')}",
                    f"- Sources: {'; '.join(refs) if refs else 'none'}",
                    "",
                ]
            )
        (stage / "02_exceptions.md").write_text("\n".join(exception_lines).rstrip() + "\n", encoding="utf-8")

        inflows = sum(row["amount_sen"] for row in proposals if row["amount_sen"] > 0)
        outflows = -sum(row["amount_sen"] for row in proposals if row["amount_sen"] < 0)
        resolved = {"proposed_match", "confirmed_by_operator"}
        matched_inflows = sum(row["amount_sen"] for row in proposals if row["amount_sen"] > 0 and row["state"] in resolved)
        matched_outflows = -sum(row["amount_sen"] for row in proposals if row["amount_sen"] < 0 and row["state"] in resolved)
        unresolved_inflows = sum(row["amount_sen"] for row in proposals if row["amount_sen"] > 0 and row["state"] not in resolved)
        unresolved_outflows = -sum(row["amount_sen"] for row in proposals if row["amount_sen"] < 0 and row["state"] not in resolved)
        report_lines = [
            "# Summary of supplied records, not financial statements",
            "",
            f"Business: {_markdown_text(business_name)}",
            f"Period: {_markdown_text(metadata.get('period_start', ''))} to {_markdown_text(metadata.get('period_end', ''))}",
            "Currency: MYR",
            "",
            "## Bank statement totals",
            "",
            f"- Opening balance: RM {format_sen(opening_balance_sen)}",
            f"- Supplied closing balance: RM {format_sen(closing_balance_sen)}",
            f"- Supplied inflows: RM {format_sen(inflows)}",
            f"- Supplied outflows: RM {format_sen(outflows)}",
            f"- Exact proposals and operator-confirmed inflows: RM {format_sen(matched_inflows)}",
            f"- Exact proposals and operator-confirmed outflows: RM {format_sen(matched_outflows)}",
            f"- Inflows still requiring review: RM {format_sen(unresolved_inflows)}",
            f"- Outflows still requiring review: RM {format_sen(unresolved_outflows)}",
            "",
            "## Review status",
            "",
            f"- Bank rows: {len(proposals)}",
            f"- Operator decisions recorded: {len(state.get('decisions', []))}",
            f"- Open exceptions: {len(result['exceptions'])}",
            f"- Matching rule version: `{result['rule_version']}`",
            f"- Date window: inclusive ±{result['date_window_days']} calendar days",
            "",
            "This pack summarizes the supplied records only. It is not an accounting close, a profit calculation, tax advice, or proof that every transaction was supplied.",
        ]
        (stage / "03_records_summary.md").write_text("\n".join(report_lines) + "\n", encoding="utf-8")

        decisions = state.get("decisions", [])
        _write_csv(
            stage / "04_decisions_log.csv",
            ["decision_id", "timestamp_utc", "bank_row_id", "candidate_id", "answer", "effect"],
            decisions,
        )

        manifest_rows = []
        for entry in source_manifest:
            manifest_rows.append(
                {
                    "path": entry["path"],
                    "sha256": entry["sha256"],
                    "size_bytes": entry["size_bytes"],
                    "status": entry["status"],
                    "processing": entry["processing"],
                }
            )
        _write_csv(stage / "05_manifest.csv", ["path", "sha256", "size_bytes", "status", "processing"], manifest_rows, numeric={"size_bytes"})

        if {path.name for path in stage.iterdir()} != set(EXPORT_NAMES):
            raise RuntimeError("review pack does not contain exactly the five expected files")
        if destination.exists():
            backup = Path(tempfile.mkdtemp(prefix=f".{destination.name}-backup-", dir=output_root))
            backup.rmdir()
            os.replace(destination, backup)
        try:
            os.replace(stage, destination)
        except Exception:
            if backup is not None and backup.exists() and not destination.exists():
                os.replace(backup, destination)
            raise
        if backup is not None and backup.exists():
            shutil.rmtree(backup)
        return [destination / name for name in EXPORT_NAMES]
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
