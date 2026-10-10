# Agentic Document Intake Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build TutupBuku's purchasing and claims intake workflow with nine executable agent skills, traceable review, user correction, and accounting exports.

**Architecture:** Create a dependency-light Node.js 22 HTTP application. Store local development data separately from existing user data, use Supabase REST and SQL RPC for production persistence, and keep model calls behind a disabled-by-default OpenAI-compatible provider adapter. Run independent checks with bounded parallelism, persist agent progress, and require deterministic validation before records are saved.

**Tech Stack:** Node.js 22 built-ins, browser HTML/CSS/JavaScript, Supabase Postgres/Auth/Storage REST, Docker/AWS ECS deployment files, Tesseract and Poppler in the container for OCR/PDF text extraction.

**Spec:** User's latest finalized workflow in the conversation; supporting earlier design: `TutupBuku — Agentic Month-End Close for SMEs (v3).md` (superseded where it conflicts with the new purchasing/claims intake pivot).

## Global Constraints

- Support purchasing documents in the sequence Quotation > PO > DO > Invoice > Payment Advice > Receipt, while accepting out-of-order uploads and linking each downstream document to its PO.
- Claims include an employee purpose; a fuel receipt paired with “Lunch with Company X” must be flagged, ask for clarification, and remain unapproved until resolved.
- Keep agent proposals separate from deterministic validation and database writes; retain source references and audit history.
- Show per-agent progress and let an operator correct extracted data or resolve issues.
- Provide upload, records/export, and flagged-issues views.
- Create all nine skills beneath `./skills`; the application must load these files explicitly because CodeBuddy's native project-skill discovery path is `.codebuddy/skills`.
- Never send model requests unless an AI endpoint is configured; do not claim WorkBuddy desktop credits are API-accessible without a supported endpoint.
- Preserve existing `.tutupbuku-data/` records and artifacts; use a separate application state file.
- Do not provision AWS resources or incur external service costs in this implementation.

## Review Focus

- Fuel receipt with an unrelated meal purpose stays flagged and unapproved until the employee clarifies it.
- An invoice above PO price, an absent DO, or supplier identity mismatch produces distinct evidence-backed issues.
- Two documents uploaded concurrently against one PO cannot both exceed the remaining quantity or amount.
- AI timeout, malformed JSON, unavailable OCR, or missing AI configuration leaves a visible review/error state and never creates an implicit pass.
- Duplicate retries do not create duplicate records; every stored field retains its source and every human correction is logged.

---

### Task 1: Domain contract, validations, and agent skills

**Files:**
- Create: `package.json`, `.gitignore`
- Create: `src/domain/schema.js`, `src/domain/audit.js`, `src/agents/skills.js`
- Create: `skills/_shared/agent-contract.md`
- Create: `skills/master-agent/SKILL.md`, `skills/docs-agent/SKILL.md`, `skills/supplier-buyer-verification-agent/SKILL.md`, `skills/purchasing-agent/SKILL.md`, `skills/verify-audit-agent/SKILL.md`, `skills/claims-verification-agent/SKILL.md`, `skills/council-of-agents/SKILL.md`, `skills/writing-agent/SKILL.md`, `skills/documentation-db-agent/SKILL.md`
- Test: `test/domain.test.js`, `test/skills.test.js`

**Interfaces:** `validateDocument(input) -> ValidationResult`; `auditClaimRelevance(receipt, purpose) -> Issue[]`; `auditPurchaseChain(po, documents) -> Issue[]`; `loadSkills(root) -> Map<string,string>`.

- [x] Write failing tests for the fuel/lunch mismatch, a price mismatch, missing DO, supplier-name mismatch, source-backed issue shape, and all nine required skill files.
- [x] Run `node --test test/domain.test.js test/skills.test.js`; confirm failures are due to missing implementations.
- [x] Implement pure deterministic validation and the complete nine-skill set with shared input/output contracts, evidence rules, and human-review boundaries.
- [x] Run the focused tests and confirm they pass.

### Task 2: Intake, OCR, AI adapter, and orchestration

**Files:**
- Create: `src/config.js`, `src/ingest/csv.js`, `src/ingest/ocr.js`, `src/ai/provider.js`, `src/agents/runner.js`, `src/workflow/orchestrator.js`
- Modify: `src/agents/skills.js`
- Test: `test/ingest.test.js`, `test/workflow.test.js`

**Interfaces:** `parseCsv(buffer) -> rows`; `extractDocument(file, config) -> extracted fields with provenance`; `runDocumentWorkflow(context, services) -> persisted workflow result`.

- [x] Write failing tests for CSV extraction, unsupported OCR states, provider-disabled behavior, independent verification fan-out, progress events, and per-document result isolation.
- [x] Run the focused tests and verify the expected failures.
- [x] Implement bounded parallel agent runs, status transitions, persisted evidence references, structured-output parsing, and safe failure handling.
- [x] Run focused tests and confirm they pass without making network or model calls.

### Task 3: Persistence, authenticated API, review, and export

**Files:**
- Create: `src/storage/local-store.js`, `src/storage/supabase-store.js`, `src/server.js`, `src/auth.js`, `supabase/migrations/001_agentic_intake.sql`
- Test: `test/api.test.js`, `test/storage.test.js`

**Interfaces:** `createStore(config) -> Store`; API supports upload, job status/events, records, issues, corrections, issue resolution, and CSV export; Supabase writes must scope records to the authenticated owner/business.

- [x] Write failing API/storage tests for valid upload, duplicate retry, owner scoping, live progress, human correction audit, issue resolution, and export contents.
- [x] Run the focused tests and confirm failures are expected.
- [x] Implement isolated local state, Supabase Auth verification and REST persistence, safe file storage, migration/RPCs, and idempotent server-side writes.
- [x] Run focused tests with in-memory/local fixtures only.

### Task 4: Operator interface

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`
- Modify: `src/server.js`
- Test: `test/ui-contract.test.js`

**Interfaces:** Three main views: document upload, records with export, and flagged issues. UI consumes the same API contracts and displays per-agent work, uncertainty, evidence, and human actions.

- [x] Write failing static/API contract tests for the three views, empty/loading/error states, progress updates, and correction controls.
- [x] Run the focused tests and confirm failures.
- [x] Implement responsive keyboard-accessible views and clear pending/review/saved states; no misleading success when required AI/OCR is unavailable.
- [x] Run the focused tests and inspect the served page and changed workflow where browser tooling is available.

### Task 5: AWS packaging, setup documentation, and full verification

**Files:**
- Create: `Dockerfile`, `.env.example`, `infra/aws/README.md`, `README.md`
- Modify: `package.json`
- Test: all files under `test/`

- [x] Add container OCR tools, health check, environment configuration, Supabase migration instructions, and AWS ECS deployment steps without provisioning resources.
- [x] Run `node --test`, all-source JavaScript syntax checks, and the smoke test. The local npm command shim is broken, so npm scripts could not be executed here.
- [x] Confirm the application starts in the smoke harness, health responds, provider-disabled intake fails safely, and `.tutupbuku-data/` is ignored by Git.
- [x] Report the WorkBuddy API compatibility limitation and exact environment requirements for a supported model endpoint.
