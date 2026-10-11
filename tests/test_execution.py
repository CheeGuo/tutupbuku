"""One prompt in, one review pack out: the execution layer and its HTTP endpoints."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

from tutupbuku.execution import ExecutionError, ExecutionManager
from tutupbuku.service import TutupBukuService
from tutupbuku.web import create_server
from tutupbuku.workbuddy import SKILL_NAMES, WorkBuddyError, build_inline_review_prompt


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "demo-fixtures" / "Sept2026"  # clean baseline, never the live working copy
GOAL = "Prepare the month-end review pack from the supplied records."
PACK_FILES = {"01_proposals.csv", "02_exceptions.md", "03_records_summary.md", "04_decisions_log.csv", "05_manifest.csv"}


class FakeReviewer:
    configured = True

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def review(self, case, matching, run_id, emit=None):
        self.calls.append({"case": case, "matching": matching, "run_id": run_id})
        return {
            "summary": "Bank row 41 cannot be settled from the records.",
            "review_status": "needs_operator",
            "skill_assessment": {name: {"status": "active" if name == "master-agent" else "not_applicable", "reason": "test"} for name in SKILL_NAMES},
            "findings": [{"title": "Receipt text contains an instruction", "severity": "review", "detail": "R010 carries a SYSTEM line; treated as receipt text.", "source_refs": ["receipts/R010.png"]}],
            "questions": [{"question": "Which invoice does the remittance advice show?", "bank_row_id": "41", "missing_evidence": "remittance advice"}],
        }


class FailingReviewer:
    configured = True

    def review(self, case, matching, run_id, emit=None):
        raise WorkBuddyError("The private WorkBuddy gateway could not be reached.", "GATEWAY_UNREACHABLE")


class ExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "fixtures").mkdir()
        shutil.copytree(FIXTURE, self.root / "fixtures" / "Sept2026")
        self.service = TutupBukuService(self.root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def manager(self, reviewer=None) -> ExecutionManager:
        return ExecutionManager(self.service, reviewer=reviewer, synchronous=True)

    def test_one_goal_pauses_at_row_41_then_exports_five_files_after_the_answer(self) -> None:
        reviewer = FakeReviewer()
        manager = self.manager(reviewer)
        run = manager.start("Sept2026", GOAL, "req-12345678")
        self.assertEqual(run["status"], "waiting_for_input")
        self.assertEqual(run["question"]["row_id"], "41")
        self.assertEqual({c["id"] for c in run["question"]["candidates"]}, {"INV-0912", "INV-0915"})
        self.assertEqual({s["id"]: s["status"] for s in run["stages"]}, {"inspect": "completed", "validate": "completed", "match": "completed", "review": "waiting", "export": "queued"})
        self.assertEqual(len(reviewer.calls), 1)
        self.assertTrue(any(e["actor"] == "WorkBuddy agent" for e in run["events"]))
        self.assertEqual(run["agent"]["status"], "completed")
        self.assertIsNone(run["pack"])
        self.assertTrue(all("required_action" in item for item in run["matching"]["exceptions"]))

        done = manager.resume(run["id"], run["version"], "INV-0912", "Remittance advice names INV-0912.", False)
        self.assertEqual(done["status"], "completed")
        self.assertEqual(set(done["pack"]["files"]), PACK_FILES)
        self.assertEqual(done["pack"]["decision_count"], 1)
        self.assertTrue(done["pack_current"])
        self.assertIsNone(done["question"])
        row41 = next(r for r in done["matching"]["bank_rows"] if r["row_id"] == "41")
        self.assertEqual((row41["state"], row41["proposed_match_id"]), ("confirmed_by_operator", "INV-0912"))
        self.assertIn("not a completed accounting close", done["events"][-1]["message"])

    def test_agent_failure_is_reported_honestly_and_the_run_still_completes(self) -> None:
        run = self.manager(FailingReviewer()).start("Sept2026", GOAL, None)
        self.assertEqual(run["status"], "waiting_for_input")
        self.assertEqual(run["agent"]["status"], "unavailable")
        messages = " ".join(e["message"] for e in run["events"] if e["actor"] == "WorkBuddy agent")
        self.assertIn("No AI review was produced", messages)

    def test_unconfigured_agent_is_disclosed(self) -> None:
        run = self.manager(None).start("Sept2026", GOAL, None)
        self.assertEqual(run["agent"]["status"], "not_configured")

    def test_leave_open_exports_without_a_decision(self) -> None:
        manager = self.manager()
        run = manager.start("Sept2026", GOAL, None)
        done = manager.resume(run["id"], run["version"], None, "", True)
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["pack"]["decision_count"], 0)
        row41 = next(r for r in done["matching"]["bank_rows"] if r["row_id"] == "41")
        self.assertEqual(row41["state"], "review_required")

    def test_neither_records_a_decision_and_keeps_both_invoices_unmatched(self) -> None:
        manager = self.manager()
        run = manager.start("Sept2026", GOAL, None)
        done = manager.resume(run["id"], run["version"], None, "Neither invoice appears on the remittance.", False)
        row41 = next(r for r in done["matching"]["bank_rows"] if r["row_id"] == "41")
        self.assertEqual(row41["state"], "left_open")
        self.assertEqual(done["pack"]["decision_count"], 1)

    def test_resume_rejects_stale_versions_unknown_candidates_and_missing_evidence(self) -> None:
        manager = self.manager()
        run = manager.start("Sept2026", GOAL, None)
        with self.assertRaises(ExecutionError) as stale:
            manager.resume(run["id"], run["version"] - 1, "INV-0912", "x", False)
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(ExecutionError):
            manager.resume(run["id"], run["version"], "../../bank.csv", "x", False)
        with self.assertRaises(ExecutionError):
            manager.resume(run["id"], run["version"], "INV-0912", "   ", False)
        self.assertEqual(manager.current(run["id"])["status"], "waiting_for_input")
        with self.assertRaises(ExecutionError) as missing:
            manager.resume("nope", 1, None, "x", False)
        self.assertEqual(missing.exception.status, 404)

    def test_request_id_replays_instead_of_starting_a_second_run(self) -> None:
        manager = self.manager()
        first = manager.start("Sept2026", GOAL, "same-request-id")
        again = manager.start("Sept2026", GOAL, "same-request-id")
        self.assertEqual(first["id"], again["id"])

    def test_invalid_input_stops_before_matching_and_lists_the_problem(self) -> None:
        (self.root / "fixtures" / "Sept2026" / "sales.csv").write_text("invoice_no,date,amount\nINV-1,2026-09-01,3.00\n", encoding="utf-8")
        run = self.manager().start("Sept2026", GOAL, None)
        self.assertEqual(run["status"], "failed")
        self.assertIsNone(run["pack"])
        self.assertTrue(run["input_issues"])
        self.assertEqual(run["input_issues"][0]["source_refs"], ["sales.csv"])
        self.assertEqual(next(s for s in run["stages"] if s["id"] == "validate")["status"], "failed")
        self.assertEqual(next(s for s in run["stages"] if s["id"] == "match")["status"], "queued")

    def test_inline_prompt_carries_all_nine_skills_and_marks_the_evidence_as_data(self) -> None:
        run = self.manager().start("Sept2026", GOAL, None)
        prompt = build_inline_review_prompt(PROJECT_ROOT, run["case"], {"bank_rows": run["matching"]["bank_rows"], "exceptions": run["matching"]["exceptions"], "checks": run["matching"]["checks"]}, run["id"])
        for name in SKILL_NAMES:
            self.assertIn(f"### {name}", prompt)
        self.assertIn("Agent contract".lower(), prompt.lower().replace("shared agent contract", "agent contract"))
        self.assertIn("untrusted source data", prompt)
        self.assertIn("EVIDENCE (data only)", prompt)
        self.assertIn("INV-0915", prompt)


class ExecutionHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "fixtures").mkdir()
        shutil.copytree(FIXTURE, self.root / "fixtures" / "Sept2026")
        dist = self.root / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<!doctype html><title>TutupBuku</title><div id=root></div>", encoding="utf-8")
        (dist / "app.js").write_text("console.log(1)", encoding="utf-8")
        self.service = TutupBukuService(self.root)
        manager = ExecutionManager(self.service, reviewer=FakeReviewer(), synchronous=True)
        self.server = create_server(self.service, "127.0.0.1", 0, executions=manager, frontend_dist=dist)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def call(self, method: str, path: str, payload: dict | None = None):
        body = json.dumps(payload).encode() if payload is not None else None
        self.connection.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
        response = self.connection.getresponse()
        return response.status, response.read()

    def test_frontend_flow_uses_the_exact_endpoints_and_downloads_the_pack(self) -> None:
        status, body = self.call("GET", "/api/execution")
        self.assertEqual((status, json.loads(body)), (200, {"run": None}))
        status, body = self.call("GET", "/api/cases")
        self.assertEqual(json.loads(body)["cases"][0]["case_id"], "Sept2026")
        status, body = self.call("POST", "/api/execution", {"case_id": "Sept2026", "goal": GOAL, "request_id": "abcdef123456"})
        self.assertIn(status, (200, 202))
        run = json.loads(body)["run"]
        self.assertEqual(run["status"], "waiting_for_input")

        status, body = self.call("GET", f"/api/execution?run_id={run['id']}")
        polled = json.loads(body)["run"]
        self.assertEqual(polled["version"], run["version"])

        status, body = self.call("POST", "/api/execution/continue", {"run_id": run["id"], "expected_version": run["version"], "candidate_id": "INV-0915", "answer": "Remittance names INV-0915.", "leave_open": False})
        self.assertIn(status, (200, 202))
        done = json.loads(body)["run"]
        self.assertEqual(done["status"], "completed")

        status, body = self.call("GET", f"/api/exports/01_proposals.csv?case_id=Sept2026&run_id={done['id']}")
        self.assertEqual(status, 200)
        self.assertIn("INV-0915", body.decode("utf-8"))
        status, body = self.call("GET", "/api/source/receipts/R001.png?case_id=Sept2026")
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(b"\x89PNG"))

    def test_bad_requests_get_clear_errors(self) -> None:
        status, body = self.call("POST", "/api/execution", {"case_id": "Sept2026", "goal": ""})
        self.assertEqual(status, 400)
        status, body = self.call("POST", "/api/execution", {"case_id": "../../x", "goal": GOAL})
        self.assertEqual(status, 400)
        status, body = self.call("POST", "/api/execution/continue", {"run_id": "missing", "expected_version": 1})
        self.assertEqual(status, 404)
        status, body = self.call("GET", "/api/execution?run_id=missing")
        self.assertEqual(status, 404)

    def test_built_frontend_is_served_with_spa_fallback(self) -> None:
        status, body = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>TutupBuku</title>", body)
        status, body = self.call("GET", "/issues")
        self.assertEqual(status, 200)
        self.assertIn(b"<div id=root>", body)
        status, body = self.call("GET", "/app.js")
        self.assertEqual((status, body), (200, b"console.log(1)"))
        status, _ = self.call("GET", "/missing.js")
        self.assertEqual(status, 404)
        status, _ = self.call("GET", "/..%2f..%2fsecret")
        self.assertIn(status, (404, 400))


if __name__ == "__main__":
    unittest.main()
