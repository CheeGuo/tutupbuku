# Deploy the Python API and frontend on Vercel

The repository's `vercel.json` uses Vercel Services (currently beta). It builds
the Vite frontend in `frontend/` and the FastAPI app `tutupbuku.api:app` together.
Requests under `/api/` go to Python; other requests go to the frontend. Frontend
deep links fall back to `index.html`.

## What this deployment supports

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | API availability, configured storage, and whether the optional worker has a fresh heartbeat |
| `GET /api/records` | Read the Supabase workspace records and version |
| `POST /api/records` | Save records with the existing optimistic version check |
| `GET /api/cases`, `GET /api/case?case_id=Sept2026` | Browse the committed synthetic case without writing state into the deployment |
| `GET /api/source/<path>?case_id=Sept2026` | Read an allow-listed source file from that case |
| `POST /api/extract` | Extract an uploaded PDF or image using the worker when enabled; hosted API extraction otherwise |

Image extraction uses the existing OCR implementation and requires a Tesseract
installation. The native Python deployment does not include Tesseract; images
that need it return an extraction error. A container deployment can supply it.
The hosted API limits JSON requests to 4 MiB, including base64 overhead.

The local `python -m tutupbuku.app --frontend --web-only` server retains the full
workflow. The optional Vercel Daemon runs that same workflow in a container and
uses the existing Postgres database for its command queue and recoverable files.
Keep the daemon at zero instances until `prisma/daemon.sql` is applied and the
existing-account WorkBuddy token is securely configured. Setup, recovery limits,
and activation steps are in [the daemon deployment guide](VERCEL_DAEMON_DEPLOYMENT.md).

With `TUTUPBUKU_DAEMON_ENABLED=1`, execution, chat, claim council, uploads,
decisions, extraction and exports are sent to the worker. The browser polls a
same-origin job ID; it never connects to the worker or WorkBuddy gateway. If the
worker is offline, the API refuses new work. A command whose model-call outcome
cannot be confirmed is marked unconfirmed and is not automatically repeated.
With the flag unset, the existing hosted behavior remains: durable workflow
routes return HTTP 503 with `code: "DURABLE_WORKER_REQUIRED"`.

## Configure the existing Vercel project

1. In the `tutupbuku` project's Settings, set **Root Directory** to the repository
   root (clear a value such as `frontend`). Vercel must see `vercel.json`,
   `Dockerfile`, `pyproject.toml`, `tutupbuku/`, and `demo-fixtures/`.
2. Remove project-level build/install/output overrides intended only for the
   frontend. The two services now own their build settings in `vercel.json`.
3. In **Settings > Environment Variables**, set `DATABASE_URL` as a server-side
   secret for **Production**. Get the transaction-pooler connection string from
   Supabase's Connect panel. Keep `schema=tutupbuku` in the URL; the existing
   Python connection helper removes Prisma-only URL parameters before connecting.
   Use a separate test database for Preview if you want to test a preview.
4. Ensure the `tutupbuku` tables exist. If the API reports missing tables, use
   `prisma/init.sql` in Supabase's SQL editor, or the existing Prisma setup with
   `DATABASE_URL` and `DIRECT_URL`. The hosted API does not run schema migrations.
5. Deploy a preview containing these changes. After verifying it, deploy the
   same changes to Production using the existing Git integration or Vercel UI.
   Environment-variable changes require a new deployment.

Never add a `VITE_` prefix to `DATABASE_URL`: the browser does not need database
credentials. The hosted app reads Vercel's injected environment, not a bundled
`.env` file. Without a valid Postgres URL it returns an explicit configuration
error rather than falling back to a temporary local records file.

`TUTUPBUKU_API_TOKEN` remains optional. When set, every API request requires
`Authorization: Bearer <token>`. The current frontend does not add that header
automatically, so enabling the token requires an authenticated proxy or client.

## Verify after deployment

- `/api/health`: HTTP 200 means the Python app loaded. `storage_configured: true`
  only confirms configuration presence, not a successful database connection.
  With the daemon enabled, `worker.online: true` means the worker holds a recent
  lease and its local gateway is ready; it does not prove WorkBuddy account
  authentication or credit access.
- `/api/records`: HTTP 200 with `storage.mode: "supabase"`, a `version`, and
  `records` confirms that the API read the database.
- `/api/cases`: HTTP 200 with the Sept2026 case confirms committed inputs are
  included in the backend bundle.
- A frontend deep link such as `/documents` should open the SPA.

HTTP 404 from Vercel means the service routing/root configuration is still
wrong. HTTP 503 JSON from `/api/records` means Python is running; inspect the
reported database configuration, driver, connectivity, or schema error.

## Local verification

Use Python 3.12, as specified in `pyproject.toml`:

```powershell
python -m venv .dist/vercel-api-venv
.\.dist\vercel-api-venv\Scripts\python.exe -m pip install -e ".[test]"
.\.dist\vercel-api-venv\Scripts\python.exe -m unittest discover -s tests -p test_vercel_api.py -v
```

The hosted API tests use temporary local records and an isolated synthetic case.
They do not claim to verify a live Supabase connection or a Vercel deployment.

References: [Vercel Services](https://vercel.com/docs/services),
[Python runtime](https://vercel.com/docs/functions/runtimes/python),
[Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).
