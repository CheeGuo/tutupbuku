"""MCP tool surface and shared-engine behavior."""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from tutupbuku.mcp_server import MCPServer
from tutupbuku.service import TutupBukuService


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "fixtures" / "Sept2026"
EXPECTED_TOOLS = {
    "health_check",
    "list_cases",
    "get_case",
    "save_receipt_fields",
    "run_matching",
    "get_review_items",
    "save_decision",
    "build_review_pack",
}


class MCPToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "fixtures").mkdir()
        shutil.copytree(FIXTURE, self.root / "fixtures" / "Sept2026")
        self.service = TutupBukuService(self.root, "Sept2026")
        self.server = MCPServer(self.service)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_all_required_tools_are_discoverable_and_backed_by_one_service(self) -> None:
        self.assertEqual({item["name"] for item in self.server.tool_definitions()}, EXPECTED_TOOLS)
        cases = self.server.call_tool("list_cases", {})
        self.assertEqual(cases[0]["case_id"], "Sept2026")
        case = self.server.call_tool("get_case", {"case_id": "Sept2026"})
        self.assertEqual(case["receipt_fields"]["R001"]["cached"], True)
        self.assertIn("cached", case["receipt_fields"]["R001"]["label"].lower())
        match = self.server.call_tool("run_matching", {"case_id": "Sept2026"})
        row41 = next(row for row in match["bank_rows"] if row["row_id"] == "41")
        self.assertEqual({candidate["id"] for candidate in row41["candidates"]}, {"INV-0912", "INV-0915"})
        review = self.server.call_tool("get_review_items", {"case_id": "Sept2026"})
        self.assertIn("41", {item["row_id"] for item in review})
        self.server.call_tool(
            "save_decision",
            {"case_id": "Sept2026", "bank_row_id": "41", "candidate_id": "INV-0915", "answer": "Remittance advice names INV-0915"},
        )
        pack = self.server.call_tool("build_review_pack", {"case_id": "Sept2026"})
        self.assertEqual(set(pack["files"]), {
            "01_proposals.csv", "02_exceptions.md", "03_records_summary.md", "04_decisions_log.csv", "05_manifest.csv"
        })
        self.assertEqual(pack["status"], "Review pack exported")

    def test_invalid_tool_parameters_are_rejected_without_file_access(self) -> None:
        with self.assertRaises(ValueError):
            self.server.call_tool("get_case", {"case_id": "../../secret"})
        with self.assertRaises(ValueError):
            self.server.call_tool(
                "save_decision",
                {"case_id": "Sept2026", "bank_row_id": "41", "candidate_id": "../../bank.csv", "answer": "yes"},
            )

    def test_mcp_jsonrpc_reports_unknown_tool_as_protocol_error(self) -> None:
        response = self.server.handle(
            {"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {"name": "run_shell", "arguments": {}}}
        )
        self.assertEqual(response["id"], 10)
        self.assertEqual(response["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
