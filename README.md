# TutupBuku Agentic Document Intake

TutupBuku accepts purchasing documents and employee claim receipts, extracts evidence, runs bounded parallel checks, and saves a reviewable proposal. It does not post transactions to accounting software. A person resolves findings and approves each record.

## What is implemented

- Automatic Master Agent routing into purchasing or employee claims; operators can also select a workflow manually. Purchasing intake supports quotations, purchase orders, delivery orders, invoices, payment advice, and receipts. Later documents can be linked to an existing PO even when uploads arrive out of order.
- Supplier and buyer identity checks, missing-step and duplicate checks, unit-price comparisons, and cumulative PO amount/quantity guards. Partial invoices are allowed; combined consumption above the PO is held for review.
- Claims intake with purpose verification. A fuel receipt paired with a lunch purpose is flagged and held before category recommendation or description writing.
- Three independent parallel account-category recommendations, limited to active codes from the configured business chart of accounts.
- Source references, human corrections, issue resolutions, approval events, business scoping, duplicate detection, progress events, and CSV export.
- Nine executable role skills loaded from `./skills`.
- Local JSON storage for development; Supabase Auth, Postgres, and private Storage for production. AWS ECS packaging is included.

The agents propose and explain. Application code checks required values, arithmetic, master data, PO balances, approval state, and tenant access. Agent processing never approves a document.

## Run locally

Requires Node.js 22 or newer. The app uses Node built-ins and does not require npm packages.

```powershell
Copy-Item .env.example .env
node --env-file=.env src/server.js
```

Open [http://localhost:3000](http://localhost:3000). Local development sign-in asks only for an email and is not suitable for a shared or public deployment. Local data is written to `.tutupbuku-data/state.json` and `.tutupbuku-data/uploads/`; other existing files in that folder are left alone. This directory is ignored by Git.

CSV, TSV, and text files work without system OCR tools. PDF and image OCR requires Poppler and Tesseract. Set `OCR_LANGUAGES=eng+msa` when Malay trained data is installed; the Docker image includes English and Malay language data and uses both by default.

Set `AI_BASE_URL` and `AI_MODEL` to enable agent calls. `AI_API_KEY` is optional for an endpoint that does not require a key. The provider must accept OpenAI-compatible `/chat/completions` requests and structured JSON output. Without a configured endpoint, uploads are saved but remain `needs_configuration`; they are not marked analyzed.

The accounting workflow adapter does not connect to WorkBuddy desktop credit balances. Use only a documented API endpoint you are authorized to call. A local Ollama-compatible endpoint can be used without buying hosted model credits, subject to your laptop's capacity. If you tunnel a local server with ngrok for development, keep the URL private, require authentication, and do not treat the tunnel as production hosting.

## Test the website connection to CodeBuddy on AWS

A separate HTML page provides a **Run AWS agent test** button. Its authenticated backend sends one fixed request through the documented CodeBuddy CLI HTTP API and displays a confirmed final `AWS_BUDDY_OK` reply. Page loading and status checks do not call the model. The CodeBuddy gateway password stays on the backend; browser access uses a different operator password.

See [Ubuntu/AWS connection demo setup](docs/agent-connection-demo.md) for exact commands. The demo runs on port 3001, with a dedicated tool-free CodeBuddy gateway on loopback port 8081 and an ngrok HTTPS endpoint. It uses the existing CLI account login rather than a separate model API key. Its purpose is to test the connection; it does not connect the accounting workflows or demonstrate parallel agents. Existing accounting permissions and approval behavior are unchanged.

Live AWS, public HTTPS, and credit consumption through this new button still require verification on your VM. Automated tests use a mock gateway and do not spend credits.

## Check the implementation

```powershell
node --test
$files = Get-ChildItem -Path src,public,scripts,test -Recurse -Filter *.js
foreach ($file in $files) { node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node scripts/smoke.js
```

These commands work without installing npm packages. The smoke test uses temporary local storage, makes no model/network-provider call, uploads a text fixture, and verifies that missing AI configuration remains visible. It removes only its own temporary directory. Convenience npm scripts are also provided if the npm CLI is installed correctly.

## Production setup

Production requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. The service-role key stays server-side and must be stored as a Secrets Manager secret in ECS. Apply `supabase/migrations/001_agentic_intake.sql` to a new Supabase project before starting the service; review the migration and backup policy with your database owner. Create a Supabase Auth user or enable permitted email signup. See [AWS deployment notes](infra/aws/README.md).

Membership roles are `owner`, `reviewer`, and `employee`. An employee can upload and see only their own claims; a reviewer or owner can resolve findings and approve. Only owners can edit company reference data. To add a registered Supabase Auth user, a project administrator must insert that user's Auth UUID and the target business UUID into `public.business_memberships` with the chosen role. Membership administration/invitations are not exposed in the app yet. Local development sign-in creates isolated owner-only workspaces.

After creating the user in Supabase Auth, get both UUIDs from the Supabase dashboard, then run this reviewed SQL in the project SQL editor:

```sql
insert into public.business_memberships (business_id, user_id, role)
values ('<business-uuid>', '<auth-user-uuid>', 'employee')
on conflict (business_id, user_id) do update set role = excluded.role;
```

The Supabase migration has been authored but not applied or tested against a live project in this workspace. Likewise, no AWS resources have been created by this implementation. Provide the AI endpoint/model/key as environment configuration or ECS secrets if you want cloud-model processing; that can incur provider charges. The production accounting workflow does not currently provide a WorkBuddy-credits API bridge; the separate connection demo above is limited to one fixed test request.

## Data and operational limits

Uploads are capped at 15 MiB. PDF text extraction checks up to 30 pages; OCR content truncation creates a review finding. The service records originals and derived data in private storage and tenant-scoped tables. Configure Supabase backups, retention, region, access controls, and production monitoring before using real accounting records. Exports are CSV drafts for downstream review, not approved journal postings.
