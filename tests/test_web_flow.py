"""End-to-end tests for the local browser API and shared case state."""

from __future__ import annotations

import base64
import csv
import json
import shutil
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

from tutupbuku.service import TutupBukuService
from tutupbuku.web import create_server


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "fixtures" / "Sept2026"


class BrowserFlowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "fixtures").mkdir()
        shutil.copytree(FIXTURE, self.root / "fixtures" / "Sept2026")
        self.service = TutupBukuService(self.root)
        self.server = create_server(self.service, "127.0.0.1", 0)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=4)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request_json(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        self.connection.request(method, path, body=body, headers=headers)
        response = self.connection.getresponse()
        result = json.loads(response.read().decode("utf-8"))
        return response.status, result

    def test_ui_decision_rebuilds_downloadable_pack_through_shared_state(self) -> None:
        self.connection.request("GET", "/")
        page = self.connection.getresponse()
        html = page.read().decode("utf-8")
        self.assertEqual(page.status, 200)
        for screen in ("Inputs", "Review", "Review Pack"):
            self.assertIn(screen, html)

        status, case = self.request_json("GET", "/api/case?case_id=Sept2026")
        self.assertEqual(status, 200)
        self.assertEqual(case["case_id"], "Sept2026")
        self.assertIn("cached synthetic extraction", case["cached_extraction_notice"].lower())

        status, run = self.request_json("POST", "/api/run", {"case_id": "Sept2026"})
        self.assertEqual(status, 200, run)
        status, items = self.request_json("GET", "/api/review-items?case_id=Sept2026")
        self.assertEqual(status, 200)
        row41 = next(item for item in items["items"] if item["row_id"] == "41")
        self.assertEqual({candidate["id"] for candidate in row41["candidates"]}, {"INV-0912", "INV-0915"})

        status, first_pack = self.request_json("POST", "/api/build-review-pack", {"case_id": "Sept2026"})
        self.assertEqual(status, 200, first_pack)
        self.assertEqual(self.service.review_pack_status("Sept2026")["status"], "Review pack exported")

        status, decision = self.request_json(
            "POST",
            "/api/decisions",
            {
                "case_id": "Sept2026",
                "bank_row_id": "41",
                "candidate_id": "INV-0912",
                "answer": "The remittance advice identifies INV-0912.",
            },
        )
        self.assertEqual(status, 200, decision)
        self.assertEqual(self.service.get_case("Sept2026")["decisions"][0]["candidate_id"], "INV-0912")
        self.assertEqual(self.service.review_pack_status("Sept2026")["status"], "stale or not built")
        with self.assertRaisesRegex(ValueError, "stale"):
            self.service.export_path("01_proposals.csv", "Sept2026")

        status, pack = self.request_json("POST", "/api/build-review-pack", {"case_id": "Sept2026"})
        self.assertEqual(status, 200, pack)
        self.assertEqual(len(pack["files"]), 5)
        self.assertIn("not a completed accounting close", pack["message"].lower())

        self.connection.request("GET", "/api/exports/01_proposals.csv?case_id=Sept2026")
        proposal_response = self.connection.getresponse()
        proposal_text = proposal_response.read().decode("utf-8")
        self.assertEqual(proposal_response.status, 200)
        self.assertIn("confirmed_by_operator", proposal_text)
        self.assertIn("INV-0912", proposal_text)

        self.connection.request("GET", "/api/exports/04_decisions_log.csv?case_id=Sept2026")
        log_response = self.connection.getresponse()
        log_text = log_response.read().decode("utf-8")
        self.assertEqual(log_response.status, 200)
        self.assertIn("INV-0912", log_text)

        status, reloaded = self.request_json("GET", "/api/case?case_id=Sept2026")
        self.assertEqual(status, 200)
        self.assertEqual(reloaded["decisions"][0]["candidate_id"], "INV-0912")

    def test_upload_rejects_unsafe_names_large_files_and_fake_receipt_images(self) -> None:
        case_dir = self.root / "fixtures" / "Sept2026"
        original_hashes = self.service.get_case("Sept2026")["files"]
        payload = base64.b64encode(b"not an image").decode("ascii")

        status, error = self.request_json(
            "POST", "/api/uploads", {"case_id": "Sept2026", "path": "../bank.csv", "file_base64": payload}
        )
        self.assertEqual(status, 400)
        self.assertIn("error", error)

        too_large = base64.b64encode(b"x" * (5 * 1024 * 1024 + 1)).decode("ascii")
        status, error = self.request_json(
            "POST",
            "/api/uploads",
            {"case_id": "Sept2026", "path": "receipts/R001.png", "file_base64": too_large},
        )
        self.assertEqual(status, 413)
        self.assertIn("error", error)

        status, error = self.request_json(
            "POST",
            "/api/uploads",
            {"case_id": "Sept2026", "path": "receipts/R001.png", "file_base64": payload},
        )
        self.assertEqual(status, 400)
        self.assertIn("error", error)
        self.assertEqual((case_dir / "receipts" / "R001.png").read_bytes(), (FIXTURE / "receipts" / "R001.png").read_bytes())
        self.assertEqual(self.service.get_case("Sept2026")["files"], original_hashes)


if __name__ == "__main__":
    unittest.main()
