"""Small dependency-free MCP stdio server used by WorkBuddy.

The server exposes deterministic local tools. It is not an AI model; WorkBuddy
remains responsible for planning, receipt reading, and operator conversation.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Mapping
from typing import Any, TextIO

from . import __version__

PROTOCOL_VERSION = "2024-11-05"


def health_check() -> dict[str, str]:
    """Return process health without claiming that an AI model is available."""
    return {"status": "ok", "server_version": __version__}


def _health_tool() -> dict[str, Any]:
    return {
        "name": "health_check",
        "description": "Check that the local TutupBuku deterministic tool server is running.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    }


def _object_schema(properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": False,
    }


def _service_tool_definitions() -> list[dict[str, Any]]:
    case = {"type": "string", "description": "Case ID returned by list_cases, usually Sept2026."}
    return [
        {
            "name": "list_cases",
            "description": "List available local TutupBuku review cases.",
            "inputSchema": _object_schema(),
        },
        {
            "name": "get_case",
            "description": "Read the case profile, input manifest, cached receipt fields and saved decisions.",
            "inputSchema": _object_schema({"case_id": case}, ["case_id"]),
        },
        {
            "name": "save_receipt_fields",
            "description": "Save fields WorkBuddy or the operator read from one receipt image; this never edits the image.",
            "inputSchema": _object_schema(
                {
                    "case_id": case,
                    "receipt_id": {"type": "string"},
                    "document_date": {"type": "string", "description": "YYYY-MM-DD printed on the receipt."},
                    "supplier": {"type": "string"},
                    "total_myr": {"type": "string", "description": "MYR total with exactly two decimal places."},
                    "receipt_number": {"type": "string"},
                    "printed_note": {"type": "string", "description": "Optional printed note, kept as untrusted receipt data."},
                },
                ["case_id", "receipt_id", "document_date", "supplier", "total_myr"],
            ),
        },
        {
            "name": "run_matching",
            "description": "Validate input schemas and bank balances, then produce conservative exact-match proposals and exceptions.",
            "inputSchema": _object_schema({"case_id": case}, ["case_id"]),
        },
        {
            "name": "get_review_items",
            "description": "Return bank rows that need review, with candidates, reason codes and source references.",
            "inputSchema": _object_schema({"case_id": case}, ["case_id"]),
        },
        {
            "name": "save_decision",
            "description": "Record the operator's answer for one review row. candidate_id must be a shown candidate or null for neither.",
            "inputSchema": _object_schema(
                {
                    "case_id": case,
                    "bank_row_id": {"type": "string"},
                    "candidate_id": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    "answer": {"type": "string", "description": "Operator's grounded answer, at most 1000 characters."},
                },
                ["case_id", "bank_row_id", "candidate_id", "answer"],
            ),
        },
        {
            "name": "build_review_pack",
            "description": "Revalidate, rebuild from saved extraction and decisions, and export the five local review-pack files.",
            "inputSchema": _object_schema({"case_id": case}, ["case_id"]),
        },
    ]


class MCPServer:
    """Handle the MCP initialization and tool subset over newline JSON-RPC."""

    def __init__(self, service: Any | None = None, *, agent_mode: bool = False, job_audit: Any | None = None) -> None:
        if agent_mode and job_audit is None:
            raise ValueError("agent mode requires a job audit service")
        self._service = service
        self.agent_mode = agent_mode
        self._job_audit = job_audit
        self._tools: dict[str, tuple[dict[str, Any], Callable[..., Any]]] = {
            "health_check": (_health_tool(), self._call_health),
        }
        if service is not None:
            for definition in _service_tool_definitions():
                name = definition["name"]
                if agent_mode and name in {"save_decision", "build_review_pack"}:
                    continue
                if agent_mode:
                    schema = definition["inputSchema"]
                    schema["properties"]["agent_job_id"] = {"type": "string", "description": "Active TutupBuku review job ID."}
                    schema["required"] = [*schema.get("required", []), "agent_job_id"]
                self._tools[name] = (definition, lambda arguments, tool_name=name: self._call_service(tool_name, arguments))
        self._initialized = False

    def _call_health(self, arguments: Mapping[str, Any]) -> dict[str, str]:
        if arguments:
            raise ValueError("health_check accepts no arguments")
        return health_check()

    def _call_service(self, name: str, arguments: Mapping[str, Any]) -> Any:
        if self._service is None:
            raise ValueError("case tools are not configured")
        definition = self._tools[name][0]
        schema = definition["inputSchema"]
        allowed = set(schema.get("properties", {}))
        required = set(schema.get("required", []))
        missing = required - set(arguments)
        extra = set(arguments) - allowed
        if missing:
            raise ValueError("missing required arguments: " + ", ".join(sorted(missing)))
        if extra:
            raise ValueError("unexpected arguments: " + ", ".join(sorted(extra)))
        call_arguments = dict(arguments)
        job_id = None
        if self.agent_mode:
            job_id = call_arguments.pop("agent_job_id", None)
            if not isinstance(job_id, str) or not job_id:
                raise ValueError("agent_job_id is required for review tools")
        handler = getattr(self._service, name)
        try:
            result = handler(**call_arguments)
        except TypeError as exc:
            raise ValueError(str(exc)) from exc
        if self.agent_mode:
            self._job_audit.record_tool_call(job_id, name)
        return result

    def tool_definitions(self) -> list[dict[str, Any]]:
        return [definition for definition, _handler in self._tools.values()]

    def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None) -> Any:
        entry = self._tools.get(name)
        if entry is None:
            raise KeyError(f"unknown tool: {name}")
        return entry[1](arguments or {})

    def handle(self, request: Mapping[str, Any]) -> dict[str, Any] | None:
        request_id = request.get("id")
        method = request.get("method")
        if request.get("jsonrpc") != "2.0" or not isinstance(method, str):
            return self._error(request_id, -32600, "Invalid Request")

        if method == "notifications/initialized":
            self._initialized = True
            return None
        if method == "notifications/cancelled":
            return None
        if method == "ping":
            return self._result(request_id, {})
        if method == "initialize":
            params = request.get("params")
            requested = params.get("protocolVersion") if isinstance(params, Mapping) else None
            # This implementation speaks the stable 2024-11-05 stdio/tool subset.
            selected_version = requested if requested == PROTOCOL_VERSION else PROTOCOL_VERSION
            return self._result(
                request_id,
                {
                    "protocolVersion": selected_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "tutupbuku", "version": __version__},
                },
            )
        if method == "tools/list":
            return self._result(request_id, {"tools": self.tool_definitions()})
        if method == "tools/call":
            params = request.get("params")
            if not isinstance(params, Mapping) or not isinstance(params.get("name"), str):
                return self._error(request_id, -32602, "tools/call requires a tool name")
            args = params.get("arguments", {})
            if not isinstance(args, Mapping):
                return self._error(request_id, -32602, "tool arguments must be an object")
            try:
                result = self.call_tool(params["name"], args)
            except KeyError as exc:
                return self._error(request_id, -32602, str(exc).strip("'"))
            except (ValueError, TypeError) as exc:
                return self._error(request_id, -32602, str(exc))
            except Exception as exc:  # Keep internal failures out of stdout/protocol details.
                return self._tool_result(request_id, {"error": str(exc)}, is_error=True)
            return self._tool_result(request_id, result)
        if request_id is None:
            return None
        return self._error(request_id, -32601, f"Method not found: {method}")

    @staticmethod
    def _result(request_id: Any, value: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": value}

    @staticmethod
    def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    @staticmethod
    def _tool_result(request_id: Any, value: Any, is_error: bool = False) -> dict[str, Any]:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
        return MCPServer._result(
            request_id,
            {"content": [{"type": "text", "text": text}], "isError": is_error},
        )


def serve_stdio(server: MCPServer | None = None, reader: TextIO | None = None, writer: TextIO | None = None) -> None:
    """Read one JSON-RPC message per line and write protocol-only stdout."""
    server = server or MCPServer()
    reader = reader or sys.stdin
    writer = writer or sys.stdout
    for line in reader:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, Mapping):
                response = MCPServer._error(None, -32600, "Invalid Request")
            else:
                response = server.handle(message)
        except json.JSONDecodeError as exc:
            response = MCPServer._error(None, -32700, f"Parse error at character {exc.pos}")
        except Exception as exc:
            response = MCPServer._error(None, -32603, f"Internal error: {exc}")
        if response is not None:
            writer.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n")
            writer.flush()


def main() -> None:
    serve_stdio()


if __name__ == "__main__":
    main()
