"""Deterministic validation, matching, decisions and review-pack orchestration."""

from __future__ import annotations

import csv
import json
import re
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .models import Candidate, DATE_WINDOW_DAYS, RULE_VERSION, BankRow, MAX_UPLOAD_BYTES
from .storage import CaseStorage

_MONEY_RE = re.compile(r"^([+-]?)(\d+|\d{1,3}(?:,\d{3})*)\.(\d{2})$")
_EXPECTED_BANK_COLUMNS = ["row_id", "date", "description", "amount", "balance"]
_EXPECTED_SALES_COLUMNS = ["invoice_no", "date", "customer", "amount", "payment_method"]
_COVERED_STATES = {"proposed_match", "review_required", "unsupported", "confirmed_by_operator", "left_open"}


class InputValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("Input validation failed: " + "; ".join(errors))


def parse_sen(value: str | int) -> int:
    """Parse an amount with exactly two decimals into integer sen."""
    if isinstance(value, bool):
        raise ValueError("amount must be a decimal string with two places")
    text = str(value).strip()
    match = _MONEY_RE.fullmatch(text)
    if not match:
        raise ValueError(f"invalid MYR amount {text!r}; use exactly two decimal places")
    sign, whole, fraction = match.groups()
    amount = int(whole.replace(",", "")) * 100 + int(fraction)
    return -amount if sign == "-" else amount


def format_sen(amount_sen: int) -> str:
    sign = "-" if amount_sen < 0 else ""
    absolute = abs(amount_sen)
    return f"{sign}{absolute // 100:,}.{absolute % 100:02d}"


def _parse_date(value: str) -> date:
    parsed = date.fromisoformat(value.strip())
    if parsed.isoformat() != value.strip():
        raise ValueError("date must use YYYY-MM-DD")
    return parsed


def _normalise_name(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _names_overlap(left: str, right: str) -> bool:
    left_words = set(_normalise_name(left).split())
    right_words = set(_normalise_name(right).split())
    return bool(left_words and right_words and (left_words <= right_words or right_words <= left_words or left_words & right_words))


class ReviewEngine:
    """One case's deterministic rules and JSON run state.

    The HTTP UI and MCP server share the same engine instance in the local app.
    Inputs are only read here; explicit UI uploads are the only write path.
    """

    def __init__(self, case_dir: Path, output_root: Path, case_id: str | None = None, *, persist_input_state: bool = True) -> None:
        self.storage = CaseStorage(Path(case_dir))
        self.case_dir = self.storage.case_dir
        self.output_root = Path(output_root).resolve()
        self.case_id = case_id or self.case_dir.name
        self._lock = threading.RLock()
        self._state = self.storage.load_state()
        self.persist_input_state = persist_input_state
        self._validated_data: dict[str, Any] = {}
        self._input_change_pending = self._sync_input_hashes()

    @staticmethod
    def file_hash(path: Path) -> str:
        return CaseStorage.sha256(Path(path).read_bytes())

    def _sync_input_hashes(self) -> bool:
        current = self.storage.source_hashes()
        previous = self._state.get("source_hashes", {})
        if not previous:
            # Bind any seed cache only when its recorded image hash agrees.
            for receipt_id, fields in list(self._state.get("receipt_fields", {}).items()):
                image_hash = current.get(self._receipt_path_for_id(receipt_id))
                if not image_hash or fields.get("source_sha256") != image_hash:
                    self._state["receipt_fields"].pop(receipt_id, None)
            self._state["source_hashes"] = current
            self._state["last_matching"] = None
            self._state.pop("built_pack_signature", None)
            if self.persist_input_state:
                self.storage.save_state(self._state)
            return False
        if current == previous:
            return False

        self._state["decisions"] = []
        self._state["last_matching"] = None
        self._state.pop("built_pack_signature", None)
        for receipt_id, fields in list(self._state.get("receipt_fields", {}).items()):
            image_hash = current.get(self._receipt_path_for_id(receipt_id))
            if not image_hash or fields.get("source_sha256") != image_hash:
                self._state["receipt_fields"].pop(receipt_id, None)
        self._state["source_hashes"] = current
        if self.persist_input_state:
            self.storage.save_state(self._state)
        return True

    def _receipt_path_for_id(self, receipt_id: str) -> str | None:
        matches = [
            path.relative_to(self.case_dir).as_posix()
            for path in self.storage.source_paths()
            if path.parent.name == "receipts" and path.stem == receipt_id
        ]
        return matches[0] if len(matches) == 1 else None

    def _source_manifest(self) -> list[dict[str, Any]]:
        manifest = self.storage.source_manifest()
        fields = self._state.get("receipt_fields", {})
        for entry in manifest:
            if entry["path"].startswith("receipts/"):
                receipt_id = Path(entry["path"]).stem
                extraction = fields.get(receipt_id)
                entry["processing"] = (
                    "cached extraction"
                    if extraction and extraction.get("cached")
                    else "extracted fields available"
                    if extraction
                    else "awaiting WorkBuddy extraction"
                )
            else:
                entry["processing"] = "validated by deterministic engine" if entry["supported"] else "unsupported"
        return manifest

    def get_case(self) -> dict[str, Any]:
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or self._input_change_pending
            profile = self._read_profile_text()
            metadata = self._read_json(self.case_dir / "bank_metadata.json")
            return {
                "case_id": self.case_id,
                "business_name": self._business_name(profile),
                "period_start": metadata.get("period_start"),
                "period_end": metadata.get("period_end"),
                "currency": metadata.get("currency", "MYR"),
                "profile": profile,
                "files": self._source_manifest(),
                "receipt_fields": json.loads(json.dumps(self._state.get("receipt_fields", {}))),
                "decisions": json.loads(json.dumps(self._state.get("decisions", []))),
                "rule_version": RULE_VERSION,
                "date_window_days": DATE_WINDOW_DAYS,
                "cached_extraction_notice": "Any seeded receipt fields are cached synthetic extraction, not live OCR.",
            }

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _read_profile_text(self) -> str:
        path = self.case_dir / "profile.md"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    @staticmethod
    def _business_name(profile: str) -> str | None:
        match = re.search(r"^\s*-?\s*Business name:\s*(.+?)\s*$", profile, re.IGNORECASE | re.MULTILINE)
        return match.group(1) if match else None

    def validate_case(self) -> dict[str, Any]:
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or self._input_change_pending
            errors: list[str] = []
            manifest = self._source_manifest()
            manifest_by_path = {entry["path"]: entry for entry in manifest}
            required = {"profile.md", "bank.csv", "bank_metadata.json", "sales.csv"}
            missing = sorted(required - set(manifest_by_path))
            errors.extend(f"missing required input: {name}" for name in missing)
            unsupported = [entry["path"] for entry in manifest if not entry["supported"]]
            errors.extend(f"unsupported input file: {name}" for name in unsupported)
            receipt_paths = [entry["path"] for entry in manifest if entry["path"].startswith("receipts/")]
            if len(receipt_paths) != 10:
                errors.append(f"expected 10 receipt images, found {len(receipt_paths)}")
            receipt_ids = [Path(name).stem for name in receipt_paths]
            if len(receipt_ids) != len(set(receipt_ids)):
                errors.append("receipt image file stems must be unique")
            for relative in receipt_paths:
                image = (self.case_dir / Path(relative)).read_bytes()
                if not (image.startswith(b"\x89PNG\r\n\x1a\n") or image.startswith(b"\xff\xd8\xff")):
                    errors.append(f"receipt image is not PNG or JPEG: {relative}")

            profile = self._read_profile_text()
            business_name = self._business_name(profile)
            if not business_name:
                errors.append("profile.md must include Business name:")

            metadata = self._read_json(self.case_dir / "bank_metadata.json")
            opening_sen = closing_sen = None
            period_start = period_end = None
            try:
                if metadata.get("currency") != "MYR":
                    raise ValueError("bank_metadata.json currency must be MYR")
                opening_sen = parse_sen(metadata["opening_balance"])
                closing_sen = parse_sen(metadata["closing_balance"])
                period_start = _parse_date(metadata["period_start"])
                period_end = _parse_date(metadata["period_end"])
                if period_end < period_start:
                    raise ValueError("period_end is before period_start")
            except (KeyError, TypeError, ValueError) as exc:
                errors.append(f"bank_metadata.json: {exc}")

            bank_rows: list[BankRow] = []
            bank_balance_errors: list[str] = []
            bank_path = self.case_dir / "bank.csv"
            if bank_path.is_file():
                try:
                    raw_bank = self._read_csv(bank_path, _EXPECTED_BANK_COLUMNS)
                    seen: set[str] = set()
                    running = opening_sen
                    for index, item in enumerate(raw_bank, start=2):
                        try:
                            row_id = item["row_id"].strip()
                            if not row_id or row_id in seen:
                                raise ValueError("row_id must be non-empty and unique")
                            seen.add(row_id)
                            row_date = _parse_date(item["date"])
                            amount_sen = parse_sen(item["amount"])
                            balance_sen = parse_sen(item["balance"])
                            if not item["description"].strip():
                                raise ValueError("description is required")
                            if period_start and period_end and not period_start <= row_date <= period_end:
                                raise ValueError("bank date is outside the selected month")
                            if running is None:
                                raise ValueError("opening balance is invalid")
                            running += amount_sen
                            if running != balance_sen:
                                bank_balance_errors.append(
                                    f"bank.csv row {index}: running balance should be {format_sen(running)}"
                                )
                            bank_rows.append(BankRow(row_id, row_date, item["description"].strip(), amount_sen, balance_sen))
                        except (TypeError, ValueError) as exc:
                            errors.append(f"bank.csv row {index}: {exc}")
                    if running is not None and closing_sen is not None and running != closing_sen:
                        bank_balance_errors.append(
                            f"closing balance should be {format_sen(running)}, metadata says {format_sen(closing_sen)}"
                        )
                except (OSError, UnicodeError, ValueError) as exc:
                    errors.append(f"bank.csv: {exc}")
            errors.extend(bank_balance_errors)

            sales_rows: list[dict[str, Any]] = []
            sales_path = self.case_dir / "sales.csv"
            if sales_path.is_file():
                try:
                    raw_sales = self._read_csv(sales_path, _EXPECTED_SALES_COLUMNS)
                    seen_invoices: set[str] = set()
                    for index, item in enumerate(raw_sales, start=2):
                        try:
                            invoice_no = item["invoice_no"].strip()
                            if not invoice_no or invoice_no in seen_invoices:
                                raise ValueError("invoice_no must be non-empty and unique")
                            seen_invoices.add(invoice_no)
                            method = item["payment_method"].strip().casefold()
                            if method not in {"cash", "transfer"}:
                                raise ValueError("payment_method must be cash or transfer")
                            customer = item["customer"].strip()
                            if not customer:
                                raise ValueError("customer is required")
                            sales_rows.append(
                                {
                                    "invoice_no": invoice_no,
                                    "date": _parse_date(item["date"]),
                                    "customer": customer,
                                    "amount_sen": parse_sen(item["amount"]),
                                    "payment_method": method,
                                }
                            )
                        except (TypeError, ValueError) as exc:
                            errors.append(f"sales.csv row {index}: {exc}")
                except (OSError, UnicodeError, ValueError) as exc:
                    errors.append(f"sales.csv: {exc}")

            c1_ok = not missing and not unsupported and len(receipt_paths) == 10 and len(receipt_ids) == len(set(receipt_ids))
            c2_ok = bool(opening_sen is not None and closing_sen is not None and bank_rows and not bank_balance_errors)
            if not bank_rows:
                c2_ok = False
            self._validated_data = {
                "profile": profile,
                "business_name": business_name,
                "metadata": metadata,
                "period_start": period_start,
                "period_end": period_end,
                "opening_balance_sen": opening_sen,
                "closing_balance_sen": closing_sen,
                "bank_rows": bank_rows,
                "sales_rows": sales_rows,
                "receipt_paths": receipt_paths,
                "manifest": manifest,
            }
            return {
                "valid": not errors,
                "errors": errors,
                "checks": {
                    "C1": {"passed": c1_ok, "detail": f"{len(manifest)} supplied files listed; supported input set checked."},
                    "C2": {"passed": c2_ok, "detail": "Opening + signed rows = each running balance and closing balance, in sen."},
                    "C3": {"passed": None, "detail": "Evaluated during matching."},
                    "C4": {"passed": None, "detail": "Evaluated during matching."},
                },
                "bank": {
                    "opening_balance_sen": opening_sen,
                    "closing_balance_sen": closing_sen,
                    "row_count": len(bank_rows),
                },
                "manifest": manifest,
            }

    @staticmethod
    def _read_csv(path: Path, expected_columns: list[str]) -> list[dict[str, str]]:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames is None:
                raise ValueError("CSV is empty or has no header")
            if reader.fieldnames != expected_columns:
                missing = [name for name in expected_columns if name not in reader.fieldnames]
                extra = [name for name in reader.fieldnames if name not in expected_columns]
                detail = []
                if missing:
                    detail.append("missing columns: " + ", ".join(missing))
                if extra or reader.fieldnames != expected_columns:
                    detail.append("expected columns in this order: " + ", ".join(expected_columns))
                raise ValueError("; ".join(detail))
            rows: list[dict[str, str]] = []
            for row in reader:
                if None in row:
                    raise ValueError("a data row contains extra comma-separated fields")
                rows.append({key: (value or "").strip() for key, value in row.items()})
            if not rows:
                raise ValueError("CSV contains no data rows")
            return rows

    def _receipt_candidates(self, period_start: date) -> list[Candidate]:
        output: list[Candidate] = []
        fields_by_id = self._state.get("receipt_fields", {})
        for receipt_id, fields in fields_by_id.items():
            source_path = self._receipt_path_for_id(receipt_id)
            if not source_path:
                continue
            if fields.get("source_sha256") != self._state.get("source_hashes", {}).get(source_path):
                continue
            try:
                candidate_date = _parse_date(fields["document_date"])
                total_sen = parse_sen(fields["total_myr"])
                supplier = str(fields["supplier"]).strip()
                if not supplier or total_sen <= 0:
                    continue
            except (KeyError, TypeError, ValueError):
                continue
            output.append(Candidate(receipt_id, "receipt", candidate_date, supplier, total_sen, source_path))
        return output

    def _sale_candidates(self, sales: list[dict[str, Any]]) -> list[Candidate]:
        return [
            Candidate(item["invoice_no"], "sale", item["date"], item["customer"], item["amount_sen"], "sales.csv#" + item["invoice_no"])
            for item in sales
            if item["payment_method"] == "transfer"
        ]

    @staticmethod
    def _within_window(left: date, right: date) -> bool:
        return abs((left - right).days) <= DATE_WINDOW_DAYS

    def _unsupported_group(self, bank: BankRow, receipts: list[Candidate], sales: list[Candidate]) -> list[Candidate]:
        candidates = receipts if bank.amount_sen < 0 else sales
        relevant = [
            item for item in candidates
            if self._within_window(bank.date, item.date) and _names_overlap(item.name, bank.description)
        ]
        target = abs(bank.amount_sen)
        # The fixed scope does not allocate split, part or net settlements.
        for index, first in enumerate(relevant):
            for second in relevant[index + 1 :]:
                if first.kind == second.kind and first.name.casefold() == second.name.casefold() and first.amount_sen + second.amount_sen == target:
                    return [first, second]
        mismatched = [item for item in relevant if item.amount_sen != target]
        return mismatched[:1]

    def run_matching(self) -> dict[str, Any]:
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or self._input_change_pending
            report = self.validate_case()
            if not report["valid"]:
                raise InputValidationError(report["errors"])
            data = self._validated_data
            bank_rows: list[BankRow] = data["bank_rows"]
            receipts = self._receipt_candidates(data["period_start"])
            sales = self._sale_candidates(data["sales_rows"])
            all_candidates = {item.id: item for item in [*receipts, *sales]}
            edges: dict[str, list[Candidate]] = {}
            for bank in bank_rows:
                pool = receipts if bank.amount_sen < 0 else sales
                target = abs(bank.amount_sen)
                edges[bank.row_id] = [
                    item for item in pool
                    if item.amount_sen == target and self._within_window(bank.date, item.date)
                ]
            use_count = Counter(candidate.id for values in edges.values() for candidate in values)

            duplicate_groups: dict[tuple[str, date, int], list[Candidate]] = defaultdict(list)
            for receipt in receipts:
                duplicate_groups[(" ".join(_normalise_name(receipt.name).split()), receipt.date, receipt.amount_sen)].append(receipt)
            duplicate_ids = {
                receipt.id
                for group in duplicate_groups.values() if len(group) > 1
                for receipt in group
            }

            latest_decision: dict[str, dict[str, Any]] = {}
            for decision in self._state.get("decisions", []):
                latest_decision[decision["bank_row_id"]] = decision
            reserved = {
                str(item.get("candidate_id")): row_id
                for row_id, item in latest_decision.items()
                if item.get("candidate_id")
            }
            proposals: list[dict[str, Any]] = []
            claimed: dict[str, str] = dict(reserved)
            for bank in bank_rows:
                candidates = edges[bank.row_id]
                candidate_ids = {item.id for item in candidates}
                decision = latest_decision.get(bank.row_id)
                row = {
                    "row_id": bank.row_id,
                    "date": bank.date.isoformat(),
                    "description": bank.description,
                    "amount_sen": bank.amount_sen,
                    "amount_myr": format_sen(bank.amount_sen),
                    "candidates": [self._candidate_dict(item) for item in candidates],
                    "proposed_match_id": None,
                    "match_type": None,
                    "state": "review_required",
                    "reason_code": "unmatched_bank_row",
                    "reason": "No exact candidate is supported by the supplied records.",
                    "decision_id": decision.get("decision_id") if decision else None,
                }
                shared = any(use_count[item.id] > 1 for item in candidates)
                if decision is not None:
                    selected_id = decision.get("candidate_id")
                    if selected_id is None:
                        row.update(state="left_open", reason_code="operator_selected_neither", reason="Operator selected neither candidate; transaction remains unclassified.")
                    elif selected_id not in candidate_ids:
                        row.update(state="review_required", reason_code="stale_decision", reason="The saved choice is no longer supported by the current candidates.")
                    elif claimed.get(selected_id) not in {None, bank.row_id}:
                        row.update(state="review_required", reason_code="source_candidate_reused", reason="This receipt or invoice is already allocated to another bank row.")
                    else:
                        chosen = all_candidates[selected_id]
                        claimed[selected_id] = bank.row_id
                        row.update(
                            proposed_match_id=selected_id,
                            match_type=chosen.kind,
                            state="confirmed_by_operator",
                            reason_code="operator_decision",
                            reason="Operator confirmed this candidate; see the saved decision log.",
                        )
                elif shared:
                    row.update(state="review_required", reason_code="source_candidate_reused", reason="A source candidate appears against multiple bank rows; no receipt or invoice is reused.")
                elif len(candidates) > 1:
                    row.update(state="review_required", reason_code="ambiguous_candidates", reason=f"{len(candidates)} exact candidates fall within the {DATE_WINDOW_DAYS}-day window.")
                elif len(candidates) == 1:
                    candidate = candidates[0]
                    if candidate.kind == "receipt" and candidate.id in duplicate_ids:
                        row.update(state="review_required", reason_code="possible_duplicate_receipt", reason="This receipt belongs to a same-supplier, same-date, same-amount look-alike pair.")
                    elif candidate.kind == "receipt" and candidate.date < data["period_start"]:
                        row.update(state="review_required", reason_code="prior_period_document", reason="Receipt document date is before the review month; payment date is kept separately.")
                    elif claimed.get(candidate.id) not in {None, bank.row_id}:
                        row.update(state="review_required", reason_code="source_candidate_reused", reason="This receipt or invoice is already allocated to another bank row.")
                    else:
                        claimed[candidate.id] = bank.row_id
                        row.update(
                            proposed_match_id=candidate.id,
                            match_type=candidate.kind,
                            state="proposed_match",
                            reason_code="exact_unique_candidate",
                            reason=f"One exact amount candidate is within the inclusive {DATE_WINDOW_DAYS}-calendar-day window.",
                        )
                else:
                    unsupported = self._unsupported_group(bank, receipts, sales)
                    if unsupported:
                        row.update(
                            state="unsupported",
                            reason_code="unsupported_allocation",
                            reason="A split, part or net allocation may be involved; the prototype does not allocate it.",
                            unsupported_candidates=[self._candidate_dict(item) for item in unsupported],
                        )
                    elif bank.amount_sen < 0:
                        row.update(state="review_required", reason_code="missing_receipt", reason="No supplied receipt matches this bank outflow.")
                    else:
                        row.update(state="review_required", reason_code="unmatched_inflow", reason="No exact transfer-sale candidate matches this bank inflow; cash sales are excluded.")
                proposals.append(row)

            exceptions = self._build_exceptions(proposals, receipts, sales, duplicate_groups)
            covered = len(proposals) == len(bank_rows) and all(row["state"] in _COVERED_STATES for row in proposals)
            c3_ok = all(
                row["state"] not in {"proposed_match", "confirmed_by_operator"}
                or (row["proposed_match_id"] and row["proposed_match_id"] in {item["id"] for item in row["candidates"]})
                for row in proposals
            ) and len([row["proposed_match_id"] for row in proposals if row["proposed_match_id"]]) == len(
                {row["proposed_match_id"] for row in proposals if row["proposed_match_id"]}
            )
            result = {
                "case_id": self.case_id,
                "rule_version": RULE_VERSION,
                "date_window_days": DATE_WINDOW_DAYS,
                "bank_rows": proposals,
                "exceptions": exceptions,
                "checks": {
                    "C1": report["checks"]["C1"],
                    "C2": report["checks"]["C2"],
                    "C3": {"passed": c3_ok, "detail": "Only exact unique candidates are proposed; candidate IDs are not reused."},
                    "C4": {"passed": covered, "detail": f"{len(proposals)} of {len(bank_rows)} bank rows have an explicit state."},
                },
                "validation": report,
                "cache_invalidated": self._input_change_pending,
            }
            self._state["last_matching"] = result
            self.storage.save_state(self._state)
            self._input_change_pending = False
            return result

    @staticmethod
    def _candidate_dict(candidate: Candidate) -> dict[str, Any]:
        value = candidate.as_dict()
        value["amount_myr"] = format_sen(candidate.amount_sen)
        return value

    def _build_exceptions(
        self,
        proposals: list[dict[str, Any]],
        receipts: list[Candidate],
        sales: list[Candidate],
        duplicate_groups: dict[tuple[str, date, int], list[Candidate]],
    ) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for row in proposals:
            if row["state"] in {"proposed_match", "confirmed_by_operator"}:
                continue
            sources = [f"bank.csv#row={row['row_id']}"]
            sources.extend(item["source_path"] for item in row.get("candidates", []))
            sources.extend(item["source_path"] for item in row.get("unsupported_candidates", []))
            output.append(
                {
                    "exception_id": f"EXC-BANK-{row['row_id']}",
                    "bank_row_id": row["row_id"],
                    "reason_code": row["reason_code"],
                    "priority": 1 if row["reason_code"] in {"ambiguous_candidates", "source_candidate_reused", "unsupported_allocation"} else 2,
                    "title": f"Bank row {row['row_id']}: {row['reason_code'].replace('_', ' ')}",
                    "reason": row["reason"],
                    "candidate_ids": [item["id"] for item in row.get("candidates", [])],
                    "source_refs": sources,
                    "status": row["state"],
                }
            )
        for group in duplicate_groups.values():
            if len(group) > 1:
                first = group[0]
                output.append(
                    {
                        "exception_id": "EXC-DUP-" + "-".join(sorted(item.id for item in group)),
                        "bank_row_id": "",
                        "reason_code": "possible_duplicate_receipt",
                        "priority": 1,
                        "title": f"Possible duplicate receipts: {first.name} on {first.date.isoformat()}",
                        "reason": f"{len(group)} receipts share supplier, document date and total. Both are retained for review.",
                        "candidate_ids": [item.id for item in group],
                        "source_refs": [item.source_path for item in group],
                        "status": "review_required",
                    }
                )

        matched = {row["proposed_match_id"] for row in proposals if row.get("proposed_match_id")}
        unresolved_candidates = {
            item["id"]
            for row in proposals if row["state"] in {"review_required", "unsupported"}
            for item in [*row.get("candidates", []), *row.get("unsupported_candidates", [])]
        }
        for receipt in receipts:
            if receipt.id not in matched and receipt.id not in unresolved_candidates and receipt.id not in {candidate_id for group in duplicate_groups.values() if len(group) > 1 for candidate_id in [item.id for item in group]}:
                output.append(
                    {
                        "exception_id": f"EXC-RECEIPT-{receipt.id}",
                        "bank_row_id": "",
                        "reason_code": "unmatched_receipt",
                        "priority": 3,
                        "title": f"Receipt {receipt.id} has no matching bank row",
                        "reason": "The receipt is retained; no exact bank outflow within the date window was found.",
                        "candidate_ids": [receipt.id],
                        "source_refs": [receipt.source_path],
                        "status": "review_required",
                    }
                )
        for sale in sales:
            if sale.id not in matched and sale.id not in unresolved_candidates:
                output.append(
                    {
                        "exception_id": f"EXC-SALE-{sale.id}",
                        "bank_row_id": "",
                        "reason_code": "unmatched_sale_invoice",
                        "priority": 3,
                        "title": f"Transfer invoice {sale.id} has no confirmed bank match",
                        "reason": "The invoice remains on the unmatched list; this is not a conclusion that payment is missing.",
                        "candidate_ids": [sale.id],
                        "source_refs": [sale.source_path],
                        "status": "review_required",
                    }
                )
        return sorted(output, key=lambda item: (item["priority"], item["bank_row_id"], item["exception_id"]))

    def get_review_items(self) -> list[dict[str, Any]]:
        result = self.run_matching()
        return [
            row for row in result["bank_rows"]
            if row["state"] in {"review_required", "unsupported"}
        ]

    def save_receipt_fields(
        self,
        receipt_id: str,
        document_date: str,
        supplier: str,
        total_myr: str,
        receipt_number: str = "",
        printed_note: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or self._input_change_pending
            source_path = self._receipt_path_for_id(receipt_id)
            if not source_path:
                raise ValueError("receipt_id must identify exactly one supplied receipt image")
            _parse_date(document_date)
            parse_sen(total_myr)
            supplier = supplier.strip()
            if not supplier or len(supplier) > 200 or len(receipt_number) > 100 or len(printed_note) > 1000:
                raise ValueError("supplier, receipt number or printed note has an invalid length")
            previous = self._state.get("receipt_fields", {}).get(receipt_id, {})
            fields = {
                "document_date": document_date,
                "supplier": supplier,
                "total_myr": total_myr,
                "receipt_number": receipt_number.strip(),
                "printed_note": printed_note.strip(),
                "cached": False,
                "label": "Fresh fields supplied by WorkBuddy or the operator; verify against the image.",
                "source_sha256": self._state["source_hashes"][source_path],
            }
            comparable = ("document_date", "supplier", "total_myr", "receipt_number", "printed_note")
            if any(previous.get(key) != fields.get(key) for key in comparable):
                self._state["decisions"] = []
                self._state["last_matching"] = None
                self._state.pop("built_pack_signature", None)
            self._state.setdefault("receipt_fields", {})[receipt_id] = fields
            self.storage.save_state(self._state)
            return {"receipt_id": receipt_id, **fields}

    def save_decision(self, bank_row_id: str, candidate_id: str | None, answer: str) -> dict[str, Any]:
        with self._lock:
            answer = answer.strip() if isinstance(answer, str) else ""
            if not answer or len(answer) > 1000:
                raise ValueError("answer must contain 1 to 1000 characters")
            result = self.run_matching()
            row = next((item for item in result["bank_rows"] if item["row_id"] == str(bank_row_id)), None)
            if not row:
                raise ValueError("bank_row_id is not in this case")
            if row["state"] not in {"review_required", "unsupported"}:
                raise ValueError("this bank row does not need a saved decision")
            if candidate_id is not None:
                candidate_ids = {item["id"] for item in row.get("candidates", [])}
                if candidate_id not in candidate_ids:
                    raise ValueError("candidate_id must be one of the candidates shown for this bank row")
                used_elsewhere = {
                    decision.get("candidate_id")
                    for decision in self._state.get("decisions", [])
                    if decision.get("bank_row_id") != str(bank_row_id) and decision.get("candidate_id")
                }
                if candidate_id in used_elsewhere:
                    raise ValueError("a receipt or invoice cannot be allocated to two bank rows")
            sequence = len(self._state.get("decisions", [])) + 1
            chosen = next((item for item in row.get("candidates", []) if item["id"] == candidate_id), None) if candidate_id else None
            decision = {
                "decision_id": f"DEC-{sequence:03d}",
                "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "bank_row_id": str(bank_row_id),
                "candidate_id": candidate_id,
                "answer": answer,
                "effect": (
                    f"Confirmed {candidate_id} as the candidate for bank row {bank_row_id}."
                    if chosen else f"Recorded that bank row {bank_row_id} matches neither displayed candidate; it remains unclassified."
                ),
            }
            self._state.setdefault("decisions", []).append(decision)
            self._state["last_matching"] = None
            self._state.pop("built_pack_signature", None)
            self.storage.save_state(self._state)
            return decision

    def build_review_pack(self) -> list[Path]:
        with self._lock:
            result = self.run_matching()
            report = result["validation"]
            if not report["valid"] or not result["checks"]["C1"]["passed"] or not result["checks"]["C2"]["passed"]:
                raise InputValidationError(report["errors"] or ["C1 or C2 failed"])
            if not result["checks"]["C3"]["passed"] or not result["checks"]["C4"]["passed"]:
                raise InputValidationError(["C3 matching or C4 bank-row coverage check failed"])
            from .exports import render_review_pack

            paths = render_review_pack(
                case_id=self.case_id,
                case_dir=self.case_dir,
                output_root=self.output_root,
                result=result,
                state=self._state,
                source_manifest=self._source_manifest(),
                business_name=self._validated_data["business_name"] or self.case_id,
                metadata=self._validated_data["metadata"],
                opening_balance_sen=self._validated_data["opening_balance_sen"],
                closing_balance_sen=self._validated_data["closing_balance_sen"],
            )
            self._state["built_pack_signature"] = self._current_pack_signature()
            self.storage.save_state(self._state)
            return paths

    def _current_pack_signature(self) -> str:
        payload = {
            "rule_version": RULE_VERSION,
            "source_hashes": self._state.get("source_hashes", {}),
            "receipt_fields": self._state.get("receipt_fields", {}),
            "decisions": self._state.get("decisions", []),
        }
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return CaseStorage.sha256(encoded)

    def is_review_pack_current(self) -> bool:
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or self._input_change_pending
            return self._state.get("built_pack_signature") == self._current_pack_signature()

    def upload_source(self, relative_path: str, content: bytes) -> dict[str, Any]:
        if not isinstance(content, bytes) or not content or len(content) > MAX_UPLOAD_BYTES:
            raise ValueError(f"upload must be between 1 byte and {MAX_UPLOAD_BYTES} bytes")
        if relative_path.startswith("receipts/"):
            suffix = Path(relative_path).suffix.casefold()
            if suffix == ".png" and not content.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("receipt content does not have a PNG signature")
            if suffix in {".jpg", ".jpeg"} and not content.startswith(b"\xff\xd8\xff"):
                raise ValueError("receipt content does not have a JPEG signature")
        target = self.storage.write_source(relative_path, content)
        with self._lock:
            self._input_change_pending = self._sync_input_hashes() or True
        return {"path": target.relative_to(self.case_dir).as_posix(), "sha256": self.file_hash(target), "saved": True}
