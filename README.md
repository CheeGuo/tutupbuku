# TutupBuku: agentic month-end review

One prompt in, one review pack out. The operator asks for the month-end review; TutupBuku validates the
supplied records, proposes conservative matches, asks about the one thing it cannot settle, and exports
five source-linked files. It prepares a review pack, not a completed accounting close.

## How a run works

`inspect -> validate -> match -> review -> export`

- The deterministic engine (`tutupbuku/engine.py`) does every number: integer-sen arithmetic, bank-balance
  check, exact-amount matching within +-7 days, duplicate and missing-receipt flags, exports.
- The agents run as a main agent with sub-agents (`tutupbuku/agents.py`). Each is a separate
  CodeBuddy call through the gateway, with its own conversation and only its own skill:
  1. **Main agent (plan)**: reads the engine results and picks up to 3 sub-agents, each with a task.
  2. **Sub-agents** (for example `docs-agent`, `verify-audit-agent`): each sees only the evidence it
     needs and returns the shared-contract JSON. They run one after another by default, because the
     CodeBuddy gateway in use puts every call in the same session (parallel calls mixed replies in a
     real run). Set `TUTUPBUKU_PARALLEL_SUB_AGENTS=1` only for a gateway that isolates sessions.
  3. **Main agent (join)**: reads the validated results and decides `ask_human` or `export`.

  The backend controls the flow: allow-listed sub-agents only, at most 5 calls per run, every reply
  schema-checked and size-capped, failed sub-agents reported as "not performed", and the human gate
  enforced by code even if the main agent says export. Agents never change an engine number or match.
  If the gateway is not configured or unreachable the run says so and continues with the engine only.
  Every agent call is audited (prompt SHA-256, raw reply, timing, session, tool use) in
  `.tutupbuku-job-state/agent_calls/` and at `GET /api/execution/audit?run_id=`. A reply that used a tool
  is discarded; the agent phase has a deadline and an hourly run limit.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for diagrams of the whole backend.
- When a bank row has several exact candidates (row 41 in the demo) the run pauses at `waiting_for_input`.
  The operator's answer is saved, the pack is rebuilt from saved state, then the run completes.

## Run it

```powershell
python scripts/generate_fixtures.py          # only if fixtures/Sept2026 is missing (synthetic data)
Set-Location frontend; npm install; npm run build; Set-Location ..
python -m tutupbuku.app --frontend --web-only   # UI and API on http://127.0.0.1:8765
```

For UI development run `npm run dev` in `frontend/` (port 5173, proxies `/api` to 8765).

Copy `workbuddy.env.example` to `.env` and fill in `CODEBUDDY_GATEWAY_URL` (the ngrok URL of the VM's
CodeBuddy gateway) and `CODEBUDDY_GATEWAY_PASSWORD` to enable the agent step. `python test_workbuddy.py`
sends one test message through the same gateway. Each call uses credits.

Use the Windows Python (`py -3.13`) for anything that calls the gateway: the MSYS2 Python on this machine
has no up-to-date CA store and fails TLS verification on the ngrok certificate.

`py -3.13 scripts/eval_agents.py --runs 3` runs the real agent flow three times on fresh copies of the
baseline and reports the results as counts (about 5 gateway calls per run).

## API used by the frontend

| Route | Purpose |
| --- | --- |
| `GET /api/cases`, `GET /api/case?case_id=` | Available cases and the source manifest |
| `POST /api/execution` | Start a run: `{case_id, goal, request_id}` |
| `GET /api/execution[?run_id=]` | Poll the run (stages, events, question, pack) |
| `POST /api/execution/continue` | Answer the question: `{run_id, expected_version, candidate_id, answer, leave_open}` |
| `POST /api/chat` | One chat message to the real main agent through the gateway: `{message, history}` |
| `GET /api/exports/<file>`, `GET /api/source/<path>` | Download a pack file or open a source file |

The lower-level routes (`/api/run`, `/api/decisions`, `/api/build-review-pack`, ...) and the MCP tools
remain for WorkBuddy and tests.

## Tests

```powershell
python -m unittest tests.test_engine tests.test_exports tests.test_mcp_protocol tests.test_mcp_tools tests.test_web_flow tests.test_workbuddy_client tests.test_workbuddy_skill tests.test_execution tests.test_execution_gateway
```

All data is synthetic. See `TutupBuku — Agentic Month-End Close for SMEs (v3).md` for the full spec.
