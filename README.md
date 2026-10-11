# TutupBuku

**Evidence-linked purchasing and employee-claim review for SMEs.**

TutupBuku helps small businesses turn uploaded invoices, purchase orders, receipts, and employee claims into reviewable records. It extracts document evidence, checks related records, highlights exceptions, and keeps human decisions alongside the source documents.

The current application combines a React review workspace with a Node.js backend. AI proposes document fields and accounting categories; application code validates the proposals, and a reviewer decides what to approve. Approved records can be exported as CSV for downstream review.

**Status:** development prototype. This repository also contains a separate Python month-end review-pack prototype. Live AI providers, cloud deployment, and the complete browser workflow need validation in your environment.

## Features

- **Purchasing review:** quotations, purchase orders, delivery orders, invoices, payment advice, and payment receipts.
- **Employee claims:** receipt review against the stated business purpose, with account-category suggestions when the evidence and company chart of accounts support them.
- **Evidence and checks:** source references, duplicate detection, required-field and arithmetic checks, purchase-order matching, unit-price comparisons, and cumulative PO quantity and amount checks.
- **Human review:** visible findings, corrections with reasons, reprocessing, rejection, and explicit approval.
- **Progress tracking:** processing jobs and agent progress events.
- **Business workspaces:** owner, reviewer, and employee roles, with business-scoped records.
- **Exports:** document and issue CSVs, plus approved purchasing and claim exports.

Supplier and buyer checks compare documents with the company reference data supplied to TutupBuku. They do not establish that a business has been verified against an external registry.

## How the review works

```text
Upload source document
        |
Route to purchasing or employee claims
        |
Extract fields and source references
        |
Run agent checks and deterministic validation
        |
Save a proposal and any review findings
        |
Human review, corrections, and approval
        |
Export approved records as CSV
```

The Node workflow loads nine role instructions from [skills/](skills/). Purchasing checks can run supplier verification, buyer verification, and PO matching concurrently. Eligible claims receive three independent category suggestions from different perspectives.

These roles use the same configured model endpoint. Their concurrency is bounded, and category recommendations must use active codes from the company's chart of accounts. Missing evidence, disagreements, and invalid proposals remain visible for review.

Agent processing never approves a record. Approval requires completed analysis for the current record version and resolved findings.

## Local development

### Requirements

- **Node.js 22 or newer** for the backend.
- **npm** for installing and running the frontend.
- **Poppler and Tesseract**, available on `PATH`, if you want PDF or image extraction.
- A compatible AI endpoint for document analysis. You can start the services without one; uploaded documents will remain `needs_configuration`.

The Node backend uses built-in modules and has no third-party npm dependencies. The frontend has its own dependencies in [frontend/package.json](frontend/package.json).

### 1. Get the repository and configure the backend

For a fresh checkout:

```powershell
git clone https://github.com/CheeGuo/tutupbuku.git
Set-Location tutupbuku
```

From the repository root, create the local environment file if it does not already exist:

```powershell
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}
```

Edit `.env` and use these values for a local backend:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
NGROK_URL=
```

**Clear the example `NGROK_URL` for local development.** A nonempty value makes Vite proxy requests to that URL. The placeholder in [.env.example](.env.example) is not a running backend.

Replace the example `APP_SECRET` with a generated value:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the value in your local `.env`. Configure `AI_BASE_URL` and `AI_MODEL` when you are ready to enable agent processing.

### 2. Start the backend

From the repository root:

```powershell
node --env-file-if-exists=.env src/server.js
```

The backend defaults to port `3000`. Its health endpoint is [http://127.0.0.1:3000/api/health](http://127.0.0.1:3000/api/health).

### 3. Start the frontend

In a second terminal, from the repository root:

```powershell
Set-Location frontend
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies `/api` to the Node backend.

Development sign-in uses an email address to create a local owner workspace. Company reference data starts empty: configure the buyer profile, suppliers, and chart of accounts through the owner master-data API before relying on those checks. See [src/server.js](src/server.js) for `GET /api/master-data` and `PUT /api/master-data`.

Local authentication is restricted to the Vite development origins. The current browser integration still needs verification; see the known limitations below.

### 4. Review a document

1. Upload a purchasing document or a claim receipt with its business purpose.
2. Inspect the processing status and extracted record in **Documents**.
3. Review findings in **Action Items**, record corrections or decisions, and reprocess when needed.
4. Approve eligible records and download the approved CSV export.

The browser upload control currently accepts PDFs and supported images. The backend API also accepts CSV, TSV, and text files.

## Configuration

Backend settings are loaded from the root `.env` file.

| Setting | Purpose |
| --- | --- |
| `NODE_ENV`, `HOST`, `PORT` | Runtime mode and backend listening address. |
| `APP_SECRET` | Signs local development sessions. |
| `DATA_DIR` | Local storage directory; defaults to `.tutupbuku-data`. |
| `AI_BASE_URL`, `AI_MODEL` | Required to enable Node agent processing. The provider must accept `/chat/completions` requests with JSON output. |
| `AI_API_KEY` | Provider credential, when the endpoint requires one. |
| `AI_TIMEOUT_MS` | Model-request timeout; example value is `45000`. |
| `MAX_PARALLEL_JOBS` | Concurrent document jobs; default is `2`. |
| `OCR_LANGUAGES` | Tesseract language selection; defaults to `eng`. Use `eng+msa` only when both trained-language datasets are installed. |
| `NGROK_URL` | Backend tunnel origin used by the frontend configuration. Leave empty for local Node development. |
| `TUTUPBUKU_DEV_PROXY_SECRET` | Shared backend/Vite secret for local development through a tunnel. |
| `TUTUPBUKU_ALLOWED_ORIGINS` | Comma-separated frontend origins allowed to call a deployed backend. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase authentication and persistent storage settings. Required by production mode. |

For a separately deployed frontend, set `VITE_API_BASE_URL` to the backend HTTPS origin. The current frontend production build requires `NGROK_URL` or `VITE_API_BASE_URL` to be set. Register the frontend's exact origin in the backend's `TUTUPBUKU_ALLOWED_ORIGINS`.

Keep AI credentials, the Supabase service-role key, and proxy secrets on the backend. Use Supabase authentication for public deployments; development email sign-in is intended for private local use.

See [frontend/README.md](frontend/README.md) for frontend configuration and build details.

## Storage and access

Local development stores application state in `.tutupbuku-data/state.json` and source uploads in `.tutupbuku-data/uploads/`. This directory is ignored by Git.

The production storage adapter uses Supabase Auth, Postgres, and private document storage. Apply these migrations in order:

1. [001_agentic_intake.sql](supabase/migrations/001_agentic_intake.sql)
2. [002_review_and_versioning.sql](supabase/migrations/002_review_and_versioning.sql)

| Role | Access |
| --- | --- |
| Owner | Manage company reference data, review records, and approve documents. |
| Reviewer | Review records, resolve findings, and approve documents. |
| Employee | Upload and view their own claims. |

Production memberships are maintained in `public.business_memberships`; an invitation or membership-management screen is not implemented.

## Separate month-end prototype

The [tutupbuku/](tutupbuku/) Python package implements a separate bank-statement and sales-matching workflow. It uses integer-sen arithmetic, conservative matching, operator decisions, and a five-file review pack:

```text
01_proposals.csv
02_exceptions.md
03_records_summary.md
04_decisions_log.csv
05_manifest.csv
```

It requires Python 3.12 and prepared case data. The frontend's `/month-end-api` proxy targets this service on port `8765`. The expected `fixtures/` and `demo-fixtures/` directories are absent from this checkout, so the Python demo is not ready to run from a fresh clone.

WorkBuddy/CodeBuddy gateway and MCP integration code belongs to this separate workflow. The Node document pipeline uses its configured AI HTTP provider; it does not automatically use desktop WorkBuddy credits.

## Repository structure

```text
frontend/               React + TypeScript review workspace
src/server.js           Node HTTP API and frontend bundle serving
src/processor.js        Extraction and validated document proposals
src/agents/             Role loading and agent execution
src/workflow/           Workflow orchestration and concurrency
src/domain/             Schemas and deterministic accounting checks
src/ingest/             Tabular parsing and OCR adapters
src/storage/            Local and Supabase persistence
skills/                 Nine agent-role instructions and shared contract
tutupbuku/              Separate Python month-end and MCP prototype
test/                   Node tests
tests/                  Python tests
supabase/migrations/    Database schema and access policies
infra/aws/              AWS deployment preparation notes
```

There is also a separate React source copy under root `src/`. Use `frontend/` for the documented development and build commands.

## Checks and current limitations

The root test command is:

```powershell
node --test
```

This README is based on source inspection; it does not establish that the complete test suite or live integrations pass.

Known limitations in the current checkout:

- Some test and npm script paths reference missing `public/` or `src/agent-demo/` files. The full test suite and older agent-demo instructions need reconciliation with the current layout.
- The Dockerfile also references the absent `public/` directory and does not package `frontend/dist/`. [AWS deployment notes](infra/aws/README.md) are preparation material and need updating before use with this frontend.
- Local authentication checks request origins. Browser requests through the development proxy need end-to-end validation; serving a built frontend on port `3000` alone is not a verified local sign-in setup.
- The frontend retains calls to the separate Python review service; that section requires its own service and case data.
- Uploads are limited to **15 MiB**. PDF extraction reads up to **30 pages**, and other extraction/context limits apply. Review truncation findings and the original source.
- OCR and AI output can be incomplete or incorrect. Human review remains required.
- TutupBuku prepares proposals and review exports. It does not post to an accounting system, execute payments, complete an accounting close, or issue tax or e-invoice compliance decisions.

## License

Licensed under the [Apache License 2.0](LICENSE).
