"""One-prompt, one-pack execution of the month-end review.

A run goes: inspect -> validate -> match -> review -> export. The deterministic engine does the
numbers. A WorkBuddy (CodeBuddy) agent, given the role skills and the engine results, explains the
evidence and asks grounded questions. The run pauses for the operator only when the engine marks a
row ambiguous, then resumes from the saved decision and exports the five-file review pack.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .engine import InputValidationError
from .service import TutupBukuService
from .workbuddy import WorkBuddyClient, WorkBuddyError, build_inline_review_prompt, parse_review_result

STAGES = (
    ("inspect", "Inspect supplied evidence", "Input inspector"),
    ("validate", "Validate schemas and balances", "Validation engine"),
    ("match", "Propose conservative matches", "Matching engine"),
    ("review", "Ask about ambiguity", "WorkBuddy agent + human review gate"),
    ("export", "Build the five-file review pack", "Export builder"),
)
ACTIVE = {"running", "waiting_for_input"}
MAX_AGENT_RUNS_PER_HOUR = int(os.environ.get("TUTUPBUKU_MAX_AGENT_RUNS_PER_HOUR", "10"))
MAX_COUNCILS_PER_HOUR = int(os.environ.get("TUTUPBUKU_MAX_COUNCILS_PER_HOUR", "10"))  # each council is 7 gateway calls
MAX_CHAT_MESSAGES_PER_HOUR = int(os.environ.get("TUTUPBUKU_MAX_CHAT_MESSAGES_PER_HOUR", "60"))
MAX_EVENTS = 200
# Hard caps on what the agent can put on screen, whatever it returns.
AGENT_MAX_FINDINGS = 6
AGENT_MAX_QUESTIONS = 3
AGENT_MAX_SUMMARY = 400
AGENT_MAX_DETAIL = 300
AGENT_MAX_TITLE = 120
REQUIRED_ACTIONS = {
    "ambiguous_candidates": "Choose the supported candidate in the checkpoint, or record that it is neither.",
    "source_candidate_reused": "Confirm which bank row each receipt or invoice belongs to; one source cannot be allocated twice.",
    "possible_duplicate_receipt": "Check whether the two receipts are one purchase scanned twice or two genuine purchases.",
    "prior_period_document": "Confirm the document date and payment date are both intended; the receipt is kept as supplied.",
    "missing_receipt": "Upload the receipt for this bank outflow, or leave it open for the accountant.",
    "unmatched_inflow": "Check whether this inflow is a transfer sale; cash sales are excluded from matching.",
    "unsupported_allocation": "Split, part and net payments are not allocated by this prototype; review with the accountant.",
    "unmatched_receipt": "Find the bank row that paid this receipt, or leave it open.",
    "unmatched_sale_invoice": "Check whether the customer has paid; this is not a conclusion that payment is missing.",
    "operator_selected_neither": "Leave open for the accountant.",
}


class ExecutionError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _clip(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clip_review(result: dict[str, Any]) -> dict[str, Any]:
    """Bound the agent's output so one verbose reply cannot flood the run or the screen."""
    return {
        "summary": _clip(result.get("summary"), AGENT_MAX_SUMMARY),
        "review_status": result.get("review_status"),
        "skill_assessment": {name: {"status": item["status"], "reason": _clip(item.get("reason"), 160)} for name, item in result.get("skill_assessment", {}).items()},
        "findings": [
            {"title": _clip(f.get("title"), AGENT_MAX_TITLE), "severity": _clip(f.get("severity"), 12) or "review", "detail": _clip(f.get("detail"), AGENT_MAX_DETAIL), "source_refs": [_clip(r, 80) for r in f.get("source_refs", [])[:3]]}
            for f in result.get("findings", [])[:AGENT_MAX_FINDINGS]
        ],
        "questions": [
            {"question": _clip(q.get("question"), AGENT_MAX_DETAIL), "bank_row_id": _clip(q.get("bank_row_id"), 16), "missing_evidence": _clip(q.get("missing_evidence"), 160)}
            for q in result.get("questions", [])[:AGENT_MAX_QUESTIONS]
        ],
        "omitted": {
            "findings": result.get("omitted", {}).get("findings", 0) + max(0, len(result.get("findings", [])) - AGENT_MAX_FINDINGS),
            "questions": result.get("omitted", {}).get("questions", 0) + max(0, len(result.get("questions", [])) - AGENT_MAX_QUESTIONS),
        },
        "run_id": result.get("run_id"),
        "decision": result.get("decision"),
        "agents": result.get("agents", []),
        "follow_ups": result.get("follow_ups", []),
        "calls": result.get("calls"),
        "audit": result.get("audit"),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class WorkBuddyReviewer:
    """Send the skills and the engine results to the CodeBuddy gateway (loopback or ngrok)."""

    def __init__(self, project_root: Path, client: WorkBuddyClient) -> None:
        self.project_root = Path(project_root)
        self.client = client

    @property
    def configured(self) -> bool:
        return self.client.configured

    def review(self, case: dict[str, Any], matching: dict[str, Any], run_id: str, emit=None) -> dict[str, Any]:
        prompt = build_inline_review_prompt(self.project_root, case, matching, run_id)
        response = self.client.run_prompt(prompt, job_id=run_id)
        result = parse_review_result(response["text"])
        result["run_id"] = response.get("run_id")
        return clip_review(result)


class ExecutionManager:
    def __init__(self, service: TutupBukuService, *, reviewer: WorkBuddyReviewer | Any | None = None, state_file: Path | None = None, synchronous: bool = False, max_agent_runs_per_hour: int = MAX_AGENT_RUNS_PER_HOUR) -> None:
        self.service = service
        self.max_agent_runs_per_hour = max_agent_runs_per_hour
        self._chat_times: list[float] = []
        self.reviewer = reviewer
        self.synchronous = synchronous  # tests run the phases inline
        self.state_file = Path(state_file) if state_file else service.project_root / ".tutupbuku-job-state" / "executions.json"
        self._lock = threading.RLock()
        self._runs: list[dict[str, Any]] = []
        self._load()

    # ---- persistence -------------------------------------------------------------------------
    def _load(self) -> None:
        if not self.state_file.exists():
            return
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
            runs = raw["runs"] if isinstance(raw, dict) and isinstance(raw.get("runs"), list) else []
        except (OSError, json.JSONDecodeError, KeyError):
            return
        self._runs = [run for run in runs if isinstance(run, dict) and isinstance(run.get("id"), str)][-10:]
        for run in self._runs:
            if run.get("status") == "running":
                run["status"] = "failed"
                run["error"] = "The service restarted during this run. Nothing was exported by it; start the review again."
                for stage in run.get("stages", []):
                    if stage["status"] == "running":
                        stage["status"] = "failed"
                run["version"] = run.get("version", 0) + 1

    def _save(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"version": 1, "runs": self._runs[-10:]}, ensure_ascii=False, indent=1) + "\n"
            handle, name = tempfile.mkstemp(prefix=".executions-", suffix=".tmp", dir=self.state_file.parent)
            try:
                with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                    stream.write(payload)
                os.replace(name, self.state_file)
            finally:
                Path(name).unlink(missing_ok=True)
        except OSError:
            pass  # State persistence is best effort; the engine's own run_state.json is the source of truth.

    # ---- helpers -----------------------------------------------------------------------------
    def _find(self, run_id: str) -> dict[str, Any] | None:
        return next((run for run in self._runs if run["id"] == run_id), None)

    def _touch(self, run: dict[str, Any]) -> None:
        run["version"] += 1
        self._save()

    def _event(self, run: dict[str, Any], actor: str, message: str, stage: str | None = None) -> None:
        with self._lock:
            run["next_event_id"] += 1
            event = {"id": run["next_event_id"], "timestamp": _now(), "actor": actor, "message": message}
            if stage:
                event["stage"] = stage
            run["events"].append(event)
            run["events"] = run["events"][-MAX_EVENTS:]
            self._touch(run)

    def _stage(self, run: dict[str, Any], stage_id: str, status: str, detail: str | None = None) -> None:
        with self._lock:
            for stage in run["stages"]:
                if stage["id"] == stage_id:
                    stage["status"] = status
                    if detail is not None:
                        stage["detail"] = detail
            self._touch(run)

    def public(self, run: dict[str, Any] | None) -> dict[str, Any] | None:
        if run is None:
            return None
        with self._lock:
            view = json.loads(json.dumps({key: value for key, value in run.items() if key not in {"next_event_id", "request_id", "leave_open", "agent_budget_exceeded"}}))
        try:
            view["pack_current"] = self.service._engine_for(run["case_id"]).is_review_pack_current() if run.get("pack") else None
        except (ValueError, OSError):
            view["pack_current"] = False
        return view

    # ---- public API --------------------------------------------------------------------------
    def current(self, run_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            run = self._find(run_id) if run_id else (self._runs[-1] if self._runs else None)
            return self.public(run)

    def start(self, case_id: str | None, goal: str, request_id: str | None) -> dict[str, Any]:
        if not isinstance(goal, str) or not goal.strip() or len(goal) > 2000:
            raise ExecutionError("Enter a goal of 1 to 2000 characters.")
        if request_id is not None and (not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id)):
            raise ExecutionError("request_id is invalid.")
        case_id = case_id or self.service.default_case_id
        self.service._resolve_case_dir(case_id)  # raises ValueError for an unknown case
        with self._lock:
            if request_id:
                existing = next((run for run in self._runs if run.get("request_id") == request_id), None)
                if existing:
                    return self.public(existing)  # idempotent replay
            if any(run["status"] == "running" for run in self._runs):
                raise ExecutionError("A review run is already in progress. Wait for it to finish.", 409)
            for older in self._runs:
                if older["status"] == "waiting_for_input":
                    older["status"] = "failed"
                    older["error"] = "Replaced by a newer run before the question was answered."
                    older["question"] = None
                    self._touch(older)
            hour_ago = datetime.now(timezone.utc).timestamp() - 3600
            recent_agent_runs = sum(
                1 for older in self._runs
                if (older.get("agent") or {}).get("status") not in {None, "not_configured", "budget_exceeded"}
                and datetime.fromisoformat(older["started_at"]).timestamp() >= hour_ago
            )
            run = {
                "agent_budget_exceeded": recent_agent_runs >= self.max_agent_runs_per_hour,
                "id": str(uuid.uuid4()), "request_id": request_id, "case_id": case_id, "goal": goal.strip(),
                "status": "running", "started_at": _now(), "version": 1, "next_event_id": 0,
                "stages": [{"id": sid, "label": label, "executor": executor, "status": "queued", "detail": ""} for sid, label, executor in STAGES],
                "events": [], "case": None, "matching": None, "review_items": [], "question": None, "pack": None,
                "pack_current": None, "error": None, "input_issues": [], "agent": None, "leave_open": False,
            }
            self._runs.append(run)
            self._runs = self._runs[-10:]
            self._save()
        self._event(run, "Orchestrator", f"Goal received for case {case_id}. Running the month-end review: inspect, validate, match, review, export.")
        self._launch(run, self._phase_prepare)
        return self.public(run)

    def resume(self, run_id: str, expected_version: Any, candidate_id: Any, answer: Any, leave_open: Any) -> dict[str, Any]:
        with self._lock:
            run = self._find(run_id) if isinstance(run_id, str) else None
            if run is None:
                raise ExecutionError("Run not found.", 404)
            if run["status"] != "waiting_for_input" or not run.get("question"):
                raise ExecutionError("This run is not waiting for an answer.", 409)
            if expected_version != run["version"]:
                raise ExecutionError("The run changed since you loaded it. Reload and answer the current question.", 409)
            question = run["question"]
            if leave_open is True:
                run["leave_open"] = True
            else:
                if candidate_id is not None and (not isinstance(candidate_id, str) or candidate_id not in {c["id"] for c in question["candidates"]}):
                    raise ExecutionError("Choose one of the displayed candidates, or neither.")
                if not isinstance(answer, str) or not answer.strip() or len(answer) > 1000:
                    raise ExecutionError("Explain the evidence behind your answer (1 to 1000 characters).")
            row_id = question["row_id"]
        if leave_open is not True:
            try:
                decision = self.service.save_decision(run["case_id"], row_id, candidate_id, answer)
            except ValueError as exc:
                raise ExecutionError(str(exc)) from exc
            self._event(run, "Operator", f"Answered bank row {row_id}: {decision['effect']}", "review")
        else:
            self._event(run, "Operator", f"Exported with bank row {row_id} left unresolved.", "review")
        with self._lock:
            run["status"] = "running"
            run["question"] = None
            self._touch(run)
        self._stage(run, "review", "running", "Applying your answer")
        self._launch(run, self._phase_after_answer)
        return self.public(run)

    def chat(self, message: Any, history: Any, case_id: str | None = None) -> dict[str, Any]:
        """Send one operator chat message to the main agent through the gateway."""
        if not isinstance(message, str) or not message.strip() or len(message) > 1000:
            raise ExecutionError("Enter a message of 1 to 1000 characters.")
        reviewer = self.reviewer
        if reviewer is None or not getattr(reviewer, "configured", False) or not hasattr(reviewer, "chat"):
            raise ExecutionError("The WorkBuddy agent is not configured on this server (set CODEBUDDY_GATEWAY_URL and CODEBUDDY_GATEWAY_PASSWORD in .env).", 503)
        now = time.monotonic()
        with self._lock:
            self._chat_times = [t for t in self._chat_times if now - t < 3600]
            if len(self._chat_times) >= MAX_CHAT_MESSAGES_PER_HOUR:
                raise ExecutionError(f"The chat limit of {MAX_CHAT_MESSAGES_PER_HOUR} messages per hour is reached. Try again later.", 429)
            self._chat_times.append(now)
        safe_history = []
        if isinstance(history, list):
            for item in history[-6:]:
                if isinstance(item, dict) and item.get("role") in {"user", "agent"} and isinstance(item.get("text"), str):
                    safe_history.append({"role": item["role"], "text": item["text"][:500]})
        case_id = case_id or self.service.default_case_id
        try:
            case = self.service.get_case(case_id)
            case_summary = {"case_id": case_id, "business_name": case.get("business_name"), "period": [case.get("period_start"), case.get("period_end")], "files": len(case.get("files", [])), "saved_decisions": len(case.get("decisions", []))}
        except (ValueError, OSError):
            case_summary = {"case_id": case_id, "available": False}
        latest = self.current()
        run_summary = None
        if latest:
            run_summary = {"status": latest["status"], "question_row": (latest.get("question") or {}).get("row_id"), "pack": latest.get("pack"), "error": latest.get("error"),
                           "stages": {s["id"]: s["status"] for s in latest.get("stages", [])}}
        try:
            return reviewer.chat(message.strip(), safe_history, {"case": case_summary, "latest_run": run_summary})
        except WorkBuddyError as exc:
            raise ExecutionError(f"The WorkBuddy agent could not answer ({exc.code}): {str(exc).rstrip('.')}.", 502) from exc

    def council(self, claim: Any, accounts: Any) -> dict[str, Any]:
        """Ask the claim council (three members, peer review, chairman) for a recommendation on one expense claim."""
        from .council import ClaimCouncil

        if not isinstance(claim, dict) or not isinstance(accounts, list) or not 1 <= len(accounts) <= 50:
            raise ExecutionError("Send the claim and 1 to 50 chart-of-account entries.")
        chart = []
        for item in accounts:
            if not isinstance(item, dict) or not isinstance(item.get("code"), str) or not isinstance(item.get("name"), str) or not 0 < len(item["code"]) <= 20:
                raise ExecutionError("Each account needs a code and a name.")
            entry = {"code": item["code"], "name": item["name"][:80]}
            if isinstance(item.get("useWhen"), str) and item["useWhen"].strip():
                entry["use_when"] = item["useWhen"][:300]
            chart.append(entry)
        receipt = claim.get("receipt") if isinstance(claim.get("receipt"), dict) else {}
        items = receipt.get("items") if isinstance(receipt.get("items"), list) else []
        safe = {
            "employee": str(claim.get("employee") or "")[:120],
            "stated_purpose": str(claim.get("purpose") or "")[:1000],
            "receipt": {
                "merchant": str(receipt.get("merchant") or "")[:120], "date": str(receipt.get("date") or "")[:20],
                "total_myr": str(receipt.get("total_myr") or "")[:20], "tax_myr": str(receipt.get("tax_myr") or "")[:20],
                "reference": str(receipt.get("reference") or "")[:60],
                "items": [{"description": str(i.get("description") or "")[:160], "quantity": i.get("quantity"), "total_myr": str(i.get("total_myr") or "")[:20]}
                          for i in items[:30] if isinstance(i, dict)],
            },
        }
        reviewer = self.reviewer
        if reviewer is None or not getattr(reviewer, "configured", False) or not hasattr(reviewer, "_call"):
            raise ExecutionError("The WorkBuddy agent is not configured on this server (set CODEBUDDY_GATEWAY_URL and CODEBUDDY_GATEWAY_PASSWORD in .env).", 503)
        now = time.monotonic()
        with self._lock:
            self._council_times = [t for t in getattr(self, "_council_times", []) if now - t < 3600]
            if len(self._council_times) >= MAX_COUNCILS_PER_HOUR:
                raise ExecutionError(f"The claim council limit of {MAX_COUNCILS_PER_HOUR} claims per hour is reached. Try again later.", 429)
            self._council_times.append(now)
        try:
            return ClaimCouncil(reviewer).run(safe, chart)
        except WorkBuddyError as exc:
            raise ExecutionError(f"The claim council could not finish ({exc.code}): {str(exc).rstrip('.')}.", 502) from exc

    def audit(self, run_id: str) -> dict[str, Any] | None:
        """The per-call agent audit (prompt hash, raw reply, timing, tool use) for one run."""
        if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", run_id):
            return None
        with self._lock:
            if self._find(run_id) is None:
                return None
        directory = getattr(self.reviewer, "audit_dir", None)
        target = Path(directory) / f"{run_id}.json" if directory else None
        if target is None or not target.is_file():
            return {"run_id": run_id, "calls": []}
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"run_id": run_id, "calls": [], "error": "audit file is unreadable"}

    # ---- phases (run on a worker thread) -------------------------------------------------------
    def _launch(self, run: dict[str, Any], phase) -> None:
        def target() -> None:
            try:
                phase(run)
            except ExecutionError as exc:
                self._fail(run, str(exc))
            except InputValidationError as exc:
                self._fail(run, str(exc))
            except WorkBuddyError as exc:
                self._fail(run, str(exc))
            except Exception as exc:  # keep the run visible instead of dying silently
                self._fail(run, f"The review stopped unexpectedly: {exc}")

        if self.synchronous:
            target()
        else:
            threading.Thread(target=target, name=f"tutupbuku-run-{run['id'][:8]}", daemon=True).start()

    def _fail(self, run: dict[str, Any], message: str) -> None:
        with self._lock:
            run["status"] = "failed"
            run["error"] = message
            for stage in run["stages"]:
                if stage["status"] in {"running", "waiting"}:
                    stage["status"] = "failed"
                    stage["detail"] = message
            self._touch(run)
        self._event(run, "Orchestrator", f"Stopped safely: {message} No review pack was approved by this failure.")

    def _phase_prepare(self, run: dict[str, Any]) -> None:
        case_id = run["case_id"]
        self._stage(run, "inspect", "running")
        case = self.service.get_case(case_id)
        with self._lock:
            run["case"] = case
        files = case["files"]
        saved = len(case.get("decisions", []))
        extra = f" Resuming with {saved} saved operator decision(s)." if saved else ""
        self._event(run, "Input inspector", f"Listed {len(files)} supplied files with SHA-256 hashes. Receipt fields are cached synthetic extraction, not live OCR.{extra}", "inspect")
        self._stage(run, "inspect", "completed", f"{len(files)} files listed")

        self._stage(run, "validate", "running")
        report = self.service._engine_for(case_id).validate_case()
        if not report["valid"]:
            issues = self._input_issues(report["errors"])
            with self._lock:
                run["input_issues"] = issues
            self._stage(run, "validate", "failed", f"{len(issues)} input problem(s)")
            self._event(run, "Validation engine", "Input validation failed; nothing was matched or exported.", "validate")
            raise ExecutionError("Input validation failed: " + "; ".join(report["errors"][:3]))
        bank = report["bank"]
        self._event(run, "Validation engine", f"Schemas valid. Bank balance reconciles: {bank['row_count']} rows, opening plus signed rows equals closing, in integer sen.", "validate")
        self._stage(run, "validate", "completed", f"{bank['row_count']} bank rows balanced")

        self._stage(run, "match", "running")
        matching = self.service.run_matching(case_id)
        self._store_matching(run, matching)
        rows = matching["bank_rows"]
        proposed = sum(1 for row in rows if row["state"] in {"proposed_match", "confirmed_by_operator"})
        self._event(run, "Matching engine", f"{proposed} of {len(rows)} bank rows have a conservative match; {len(matching['exceptions'])} exceptions need attention.", "match")
        self._stage(run, "match", "completed", f"{proposed} matched, {len(matching['exceptions'])} exceptions")

        self._stage(run, "review", "running", "WorkBuddy agent is reviewing the evidence")
        self._agent_review(run, case, matching)
        self._after_review(run)

    def _phase_after_answer(self, run: dict[str, Any]) -> None:
        matching = self.service.run_matching(run["case_id"])
        self._store_matching(run, matching)
        self._after_review(run)

    def _after_review(self, run: dict[str, Any]) -> None:
        question = None if run.get("leave_open") else self._next_question(run)
        if question:
            with self._lock:
                run["question"] = question
                run["status"] = "waiting_for_input"
                self._touch(run)
            self._stage(run, "review", "waiting", f"Bank row {question['row_id']} needs your answer")
            names = ", ".join(c["id"] for c in question["candidates"])
            self._event(run, "Review gate", f"Bank row {question['row_id']} ({question['description']}) has {len(question['candidates'])} exact candidates: {names}. The engine will not choose between them. Which one does your evidence support?", "review")
            return
        self._stage(run, "review", "completed", "No unresolved ambiguity left to ask about" if not run.get("leave_open") else "Left unresolved at your request")
        self._export(run)

    def _export(self, run: dict[str, Any]) -> None:
        self._stage(run, "export", "running")
        pack = self.service.build_review_pack(run["case_id"])
        with self._lock:
            run["pack"] = {key: pack[key] for key in ("files", "open_item_count", "decision_count", "message")}
            run["status"] = "completed"
            self._touch(run)
        self._stage(run, "export", "completed", f"{len(pack['files'])} files")
        self._event(run, "Export builder", f"Review pack exported: {pack['decision_count']} decision(s) recorded, {pack['open_item_count']} item(s) still open. This is a review pack, not a completed accounting close.", "export")

    # ---- pieces ----------------------------------------------------------------------------
    def _store_matching(self, run: dict[str, Any], matching: dict[str, Any]) -> None:
        exceptions = [{**item, "required_action": REQUIRED_ACTIONS.get(item["reason_code"], "Review the listed evidence.")} for item in matching["exceptions"]]
        view = {"bank_rows": matching["bank_rows"], "exceptions": exceptions, "checks": matching["checks"]}
        with self._lock:
            run["matching"] = json.loads(json.dumps(view))
            run["review_items"] = [row for row in view["bank_rows"] if row["state"] in {"review_required", "unsupported"}]
            self._touch(run)

    @staticmethod
    def _next_question(run: dict[str, Any]) -> dict[str, Any] | None:
        for row in run["matching"]["bank_rows"]:
            if row["state"] == "review_required" and row["reason_code"] == "ambiguous_candidates" and len(row["candidates"]) > 1:
                return json.loads(json.dumps(row))
        return None

    @staticmethod
    def _input_issues(errors: list[str]) -> list[dict[str, Any]]:
        issues = []
        for index, message in enumerate(errors, start=1):
            match = re.match(r"([A-Za-z0-9_./-]+\.(?:csv|json|md|png|jpe?g))(?: row (\d+))?", message.replace("missing required input: ", "").replace("unsupported input file: ", ""))
            source = match.group(1) if match else "case folder"
            issues.append({
                "id": f"INPUT-{index:02d}", "message": message, "source_refs": [source] if match else [],
                "location": f"{source}, row {match.group(2)}" if match and match.group(2) else source,
                "required_action": "Correct or replace this input, then start the review again. Nothing was exported.",
            })
        return issues

    def _agent_review(self, run: dict[str, Any], case: dict[str, Any], matching: dict[str, Any]) -> None:
        reviewer = self.reviewer
        if reviewer is None or not getattr(reviewer, "configured", False):
            note = "WorkBuddy is not configured on this server (set CODEBUDDY_GATEWAY_URL and CODEBUDDY_GATEWAY_PASSWORD in .env). No AI review was produced; continuing with the deterministic checks only."
            with self._lock:
                run["agent"] = {"status": "not_configured", "message": note}
            self._event(run, "WorkBuddy agent", note, "review")
            return
        if run.get("agent_budget_exceeded"):
            note = f"The hourly agent limit ({self.max_agent_runs_per_hour} runs per hour) is reached, so no AI calls were made for this run. Continuing with the deterministic checks only."
            with self._lock:
                run["agent"] = {"status": "budget_exceeded", "message": note}
            self._event(run, "WorkBuddy agent", note, "review")
            return
        self._event(run, "WorkBuddy agent", "Sending the role skills and the engine results to WorkBuddy through the gateway. Receipt fields are cached synthetic extraction.", "review")

        def emit(actor: str, message: str) -> None:
            self._event(run, actor, message, "review")
            self._stage(run, "review", "running", f"{actor}: {message[:80]}")

        try:
            result = reviewer.review(case, matching, run["id"], emit=emit)
        except WorkBuddyError as exc:
            note = f"WorkBuddy could not complete the review ({exc.code}): {str(exc).rstrip(chr(46))}. No AI review was produced; continuing with the deterministic checks only."
            with self._lock:
                run["agent"] = {"status": "unavailable", "message": note, "code": exc.code}
            self._event(run, "WorkBuddy agent", note, "review")
            return
        result = clip_review(result)
        with self._lock:
            run["agent"] = {"status": "completed", "result": result, "message": result["summary"]}
        self._event(run, "WorkBuddy agent", result["summary"], "review")
        groups: dict[str, list[str]] = {"active": [], "conditional": [], "not_applicable": []}
        for name, item in result["skill_assessment"].items():
            groups[item["status"]].append(name)
        self._event(run, "WorkBuddy agent", "Skills — active: " + (", ".join(groups["active"]) or "none") + "; conditional: " + (", ".join(groups["conditional"]) or "none") + "; not applicable: " + (", ".join(groups["not_applicable"]) or "none") + ".", "review")
        for finding in result["findings"]:
            refs = f" [{'; '.join(finding['source_refs'])}]" if finding["source_refs"] else ""
            self._event(run, "WorkBuddy agent", f"{finding['severity'].upper()} — {finding['title']}: {finding['detail']}{refs}", "review")
        for question in result["questions"]:
            row = f"Row {question['bank_row_id']}: " if question["bank_row_id"] else ""
            self._event(run, "WorkBuddy agent", f"Question — {row}{question['question']}", "review")
        decision = result.get("decision") or {}
        pending = self._next_question(run)
        if decision.get("decision") == "export" and pending:
            self._event(run, "Orchestrator", f"The main agent proposed export, but the engine marks bank row {pending['row_id']} as ambiguous. The human gate is enforced by code, so the run will ask you first.", "review")
        elif decision.get("decision") == "ask_human" and decision.get("bank_row_id") and pending and decision["bank_row_id"] != pending["row_id"]:
            self._event(run, "Orchestrator", f"The main agent asked about row {decision['bank_row_id']}; the engine's ambiguous row is {pending['row_id']}, so that is the question shown.", "review")
        audit = result.get("audit") or {}
        if audit.get("shared_session"):
            self._event(run, "Orchestrator", "Gateway note: every agent call ran in the same CodeBuddy session, so the gateway does not isolate agent contexts. Each prompt is self-contained and sub-agents ran one after another to keep replies apart.", "review")
        if audit.get("extracted_replies"):
            self._event(run, "Orchestrator", f"{audit['extracted_replies']} reply(ies) also contained another agent's output; only the part for the right agent was used (see the audit).", "review")
        if result.get("calls"):
            self._event(run, "Orchestrator", f"Agent calls this run: {result['calls']} (main agent plan and join, plus {len([a for a in result.get('agents', []) if a.get('role') == 'sub'])} sub-agent(s)).", "review")
        omitted = result["omitted"]
        if omitted["findings"] or omitted["questions"]:
            self._event(run, "WorkBuddy agent", f"Output limited for readability: {omitted['findings']} more finding(s) and {omitted['questions']} more question(s) were not shown.", "review")
