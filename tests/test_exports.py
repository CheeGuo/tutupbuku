"""Review-pack file and repeatability checks."""

from __future__ import annotations

import csv
import shutil
import tempfile
import unittest
from pathlib import Path

from tutupbuku.engine import ReviewEngine


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "demo-fixtures" / "Sept2026"  # clean baseline, never the live working copy
EXPECTED = {
    "01_proposals.csv",
    "02_exceptions.md",
    "03_records_summary.md",
    "04_decisions_log.csv",
    "05_manifest.csv",
}


class ReviewPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.case_dir = self.root / "Sept2026"
        shutil.copytree(FIXTURE, self.case_dir)
        self.engine = ReviewEngine(self.case_dir, self.root / "exports")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_five_exports_are_complete_source_linked_and_repeatable(self) -> None:
        first = self.engine.build_review_pack()
        self.assertEqual({path.name for path in first}, EXPECTED)
        snapshot = {path.name: path.read_bytes() for path in first}
        second = self.engine.build_review_pack()
        self.assertEqual(snapshot, {path.name: path.read_bytes() for path in second})

        proposals = self.root / "exports" / "review_pack_Sept2026" / "01_proposals.csv"
        with proposals.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 11)
        self.assertTrue(all(row["source_refs"] for row in rows))
        summary = (proposals.parent / "03_records_summary.md").read_text(encoding="utf-8")
        self.assertTrue(summary.startswith("# Summary of supplied records, not financial statements"))

    def test_operator_decision_changes_row_41_and_is_rebuilt_from_state(self) -> None:
        first = self.engine.build_review_pack()
        before = (self.root / "exports" / "review_pack_Sept2026" / "01_proposals.csv").read_bytes()
        self.engine.save_decision("41", "INV-0912", "The remittance advice identifies INV-0912")
        self.engine.build_review_pack()
        after = (self.root / "exports" / "review_pack_Sept2026" / "01_proposals.csv").read_bytes()
        self.assertNotEqual(before, after)
        with (self.root / "exports" / "review_pack_Sept2026" / "01_proposals.csv").open(newline="", encoding="utf-8") as stream:
            row41 = next(row for row in csv.DictReader(stream) if row["row_id"] == "41")
        self.assertEqual(row41["state"], "confirmed_by_operator")
        self.assertEqual(row41["proposed_match_id"], "INV-0912")
        with (self.root / "exports" / "review_pack_Sept2026" / "04_decisions_log.csv").open(newline="", encoding="utf-8") as stream:
            decisions = list(csv.DictReader(stream))
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["bank_row_id"], "41")
        before_repeat = {path.name: path.read_bytes() for path in self.engine.build_review_pack()}
        repeat = self.engine.build_review_pack()
        self.assertEqual(before_repeat, {path.name: path.read_bytes() for path in repeat})


if __name__ == "__main__":
    unittest.main()
