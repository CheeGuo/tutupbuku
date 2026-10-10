"""Black-box MCP stdio smoke test for the WorkBuddy server."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest


class McpProtocolTests(unittest.TestCase):
    def test_initialize_list_tools_and_call_health_check(self) -> None:
        messages = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "tutupbuku-test", "version": "1.0"},
                },
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "health_check", "arguments": {}},
            },
        ]
        completed = subprocess.run(
            [sys.executable, "-m", "tutupbuku.mcp_server"],
            input="".join(json.dumps(item) + "\n" for item in messages),
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        responses = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([item["id"] for item in responses], [1, 2, 3])
        self.assertEqual(responses[0]["result"]["protocolVersion"], "2024-11-05")
        self.assertIn("tools", responses[0]["result"]["capabilities"])
        tools = responses[1]["result"]["tools"]
        health = next((item for item in tools if item["name"] == "health_check"), None)
        self.assertIsNotNone(health)
        self.assertEqual(health["inputSchema"]["type"], "object")
        result = json.loads(responses[2]["result"]["content"][0]["text"])
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["server_version"])


if __name__ == "__main__":
    unittest.main()
