"""Behavioral coverage for the deterministic review engine."""

from __future__ import annotations

import csv
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tutupbuku.engine import InputValidationError, ReviewEngine, format_sen, parse_sen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "fixtures" / "Sept2026"


class ReviewEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.case_dir = self.root / "Sept2026"
        shutil.copytree(FIXTURE, self.case_dir)
        self.engine = ReviewEngine(self.case_dir, self.root / "exports")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_integer_sen_amounts_and_bank_balance_checks(self) -> None:
        self.assertEqual(parse_sen("0.10"), 10)
        self.assertEqual(parse_sen("-1,234.56"), -123456)
        self.assertEqual(format_sen(1093670), "10,936.70")
        report = self.engine.validate_case()
        self.assertTrue(report["valid"], report["errors"])
        self.assertTrue(report["checks"]["C2"]["passed"])
        self.assertEqual(report["bank"]["opening_balance_sen"], 1000000)
        self.assertEqual(report["bank"]["closing_balance_sen"], 1093670)

    def test_t1_to_t6_match_conservatively_and_surface_exceptions(self) -> None:
        result = self.engine.run_matching()
        rows = {row["row_id"]: row for row in result["bank_rows"]}
        self.assertEqual((rows["01"]["state"], rows["01"]["proposed_match_id"]), ("proposed_match", "R001"))
        self.assertEqual(rows["02"]["state"], "review_required")
        self.assertEqual(rows["03"]["state"], "review_required")
        self.assertEqual(rows["04"]["reason_code"], "prior_period_document")
        self.assertEqual(rows["05"]["reason_code"], "missing_receipt")
        self.assertEqual(rows["06"]["state"], "unsupported")
        self.assertEqual(rows["06"]["reason_code"], "unsupported_allocation")
        self.assertIn("possible_duplicate_receipt", {item["reason_code"] for item in result["exceptions"]})
        self.assertTrue(result["checks"]["C4"]["passed"])

    def test_t4_row_41_shows_both_sales_candidates_without_guessing(self) -> None:
        result = self.engine.run_matching()
        row = next(item for item in result["bank_rows"] if item["row_id"] == "41")
        self.assertEqual(row["state"], "review_required")
        self.assertEqual(row["reason_code"], "ambiguous_candidates")
        self.assertEqual({item["id"] for item in row["candidates"]}, {"INV-0912", "INV-0915"})

    def test_date_window_is_seven_calendar_days_and_candidates_cannot_be_reused(self) -> None:
        bank_path = self.case_dir / "bank.csv"
        original_bank = bank_path.read_bytes()
        rows = self._read_bank()
        rows[0]["date"] = "2026-09-10"  # The seventh calendar day is included.
        self._write_bank(rows)
        result = self.engine.run_matching()
        row1 = next(item for item in result["bank_rows"] if item["row_id"] == "01")
        self.assertIn("R001", {item["id"] for item in row1["candidates"]})

        bank_path.write_bytes(original_bank)
        rows = self._read_bank()
        rows[0]["date"] = "2026-09-11"  # Eight days after R001: outside the inclusive window.
        self._write_bank(rows)
        result = self.engine.run_matching()
        row1 = next(item for item in result["bank_rows"] if item["row_id"] == "01")
        self.assertNotIn("R001", {item["id"] for item in row1["candidates"]})

        bank_path.write_bytes(original_bank)
        rows = self._read_bank()
        rows.insert(1, {**rows[0], "row_id": "01B", "date": "2026-09-04", "description": "Orchard Stationery second charge"})
        self._write_bank(rows)
        result = self.engine.run_matching()
        shared = [item for item in result["bank_rows"] if item["row_id"] in {"01", "01B"}]
        self.assertEqual({item["state"] for item in shared}, {"review_required"})
        self.assertTrue(all(item["reason_code"] == "source_candidate_reused" for item in shared))

    def test_t7_invalid_sales_schema_blocks_matching_and_export(self) -> None:
        (self.case_dir / "sales.csv").write_text("invoice_no,date,amount\nINV-1,2026-09-01,3.00\n", encoding="utf-8")
        report = self.engine.validate_case()
        self.assertFalse(report["valid"])
        self.assertTrue(any("payment_method" in error for error in report["errors"]))
        with self.assertRaises(InputValidationError):
            self.engine.build_review_pack()
        self.assertFalse((self.root / "exports" / "review_pack_Sept2026").exists())

    def test_t8_interrupted_rebuild_resumes_without_duplicate_rows(self) -> None:
        (self.case_dir / "run_state.json.tmp").write_text("interrupted write", encoding="utf-8")
        first = self.engine.build_review_pack()
        first_snapshot = [path.read_bytes() for path in first]
        second_engine = ReviewEngine(self.case_dir, self.root / "exports")
        second = second_engine.build_review_pack()
        self.assertEqual(first_snapshot, [path.read_bytes() for path in second])
        with (self.root / "exports" / "review_pack_Sept2026" / "01_proposals.csv").open(newline="", encoding="utf-8") as stream:
            proposals = list(csv.DictReader(stream))
        self.assertEqual(len(proposals), 11)

    def test_t9_hostile_receipt_is_data_and_input_hash_stays_unchanged(self) -> None:
        receipt_path = self.case_dir / "receipts" / "R010.png"
        before = self.engine.file_hash(receipt_path)
        self.engine.run_matching()
        self.engine.build_review_pack()
        self.assertEqual(self.engine.file_hash(receipt_path), before)
        extraction = self.engine.get_case()["receipt_fields"]["R010"]
        self.assertIn("cached", extraction["label"].lower())
        self.assertIn("SYSTEM:", extraction["printed_note"])

    def test_t10_changed_inputs_invalidate_decisions_and_change_results(self) -> None:
        self.engine.run_matching()
        self.engine.save_decision("41", "INV-0912", "I confirm INV-0912")
        sales_path = self.case_dir / "sales.csv"
        content = sales_path.read_text(encoding="utf-8-sig")
        content = content.replace("INV-0915,2026-09-17,Tan Construction,1850.00,transfer", "INV-0915,2026-09-18,Tan Construction,1851.00,transfer")
        sales_path.write_text(content, encoding="utf-8")
        updated = ReviewEngine(self.case_dir, self.root / "exports")
        result = updated.run_matching()
        row41 = next(item for item in result["bank_rows"] if item["row_id"] == "41")
        self.assertEqual(row41["state"], "proposed_match")
        self.assertEqual(row41["proposed_match_id"], "INV-0912")
        self.assertEqual(updated.get_case()["decisions"], [])
        self.assertTrue(result["cache_invalidated"])

    def _write_bank(self, rows: list[dict[str, str]]) -> None:
        metadata_path = self.case_dir / "bank_metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        balance = parse_sen(metadata["opening_balance"])
        for row in rows:
            balance += parse_sen(row["amount"])
            row["balance"] = format_sen(balance)
        with (self.case_dir / "bank.csv").open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=["row_id", "date", "description", "amount", "balance"])
            writer.writeheader()
            writer.writerows(rows)
        metadata["closing_balance"] = format_sen(balance)
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    def _read_bank(self) -> list[dict[str, str]]:
        with (self.case_dir / "bank.csv").open(encoding="utf-8-sig", newline="") as stream:
            return list(csv.DictReader(stream))


if __name__ == "__main__":
    unittest.main()
