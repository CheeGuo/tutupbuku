# Run the existing WorkBuddy account in a Vercel Daemon

This deployment keeps the Vite frontend and FastAPI HTTP service on Vercel and
adds a background worker in the same project. The worker starts the pinned
CodeBuddy CLI, connects to its gateway on loopback, and pulls TutupBuku jobs
from the existing Postgres database. Browser requests reach FastAPI; they do
not reach the daemon directly. No EC2 instance, ngrok tunnel, new database
provider, or AI Gateway account is required by this architecture.

The CLI uses `CODEBUDDY_AUTH_TOKEN` for the existing CodeBuddy account. Running
the CLI in a different container does not establish that a particular account
or hackathon credit allocation permits that use; verify the account's current
access before activating jobs. A container build or passing unit tests does
not verify login, model access, database connectivity, or production readiness.

## Vercel behavior to account for

As checked on 19 October 2026, Daemons is a public beta. It runs containers
continuously, restarts instances after exit, and supports production deployments
only. Preview deployments do not run daemons, and `vercel dev` does not start
them. Promoting a deployment or rolling back production also rolls out the
associated daemon configuration. Instances can stop at any time.

Daemon filesystems are ephemeral. The worker uses temporary runtime files and
checkpoints jobs and workflow state in Postgres. Keep uploads, decisions,
results, and exported artifacts in that durable store; local runtime directories
are working copies. Do not treat the container's home directory as durable
credential storage.

Command idempotency records are retained for seven days. A claimed command
whose outcome cannot be confirmed is marked `unconfirmed` and is not rerun
automatically: replaying a model-backed operation may duplicate upstream work
or charges. Review its saved status and audit before explicitly retrying.

Vercel builds Linux `amd64` images. The root `Dockerfile` combines Python 3.12,
Node.js 22, `@tencent-ai/codebuddy-code@2.164.0`, Tesseract English OCR, and `tini`.
It runs as UID/GID 10001. Its selective `COPY` instructions and `.dockerignore`
exclude local secrets, personal CodeBuddy configuration, uploads, working cases,
exports, dependencies, and virtual environments. Only the explicitly included
CodeBuddy skill and synthetic `demo-fixtures/` baseline are packaged.

Each instance receives deployment environment variables. Vercel also passes
them as image build arguments; this Dockerfile does not declare credential
`ARG`s or write authentication into an image layer. Store credentials as
server-side **Secret** environment variables without a `VITE_` prefix.
Changing environment variables requires a new deployment.

## Configure the worker without starting it

Keep the Vercel project's Root Directory at this repository's root and retain
the existing `services` and `rewrites`. Add this top-level block to `vercel.json`:

```json
{
  "daemons": {
    "worker": {
      "root": ".",
      "entrypoint": "Dockerfile",
      "instances": { "sin1": 0 },
      "resources": { "requests": { "memory": "1Gi" } },
      "terminationGracePeriodSeconds": 60
    }
  }
}
```

This is an addition to the current configuration, not a replacement for it.
Singapore (`sin1`) is an allowed daemon region near Malaysia. Place the
Dockerfile at the repository root because Vercel uses its containing directory
as the build context. A Dockerfile under `deploy/` cannot copy application
files outside that build context.

Do not add a `command` field: Vercel replaces both `ENTRYPOINT` and `CMD` when
it is present, which would bypass the image's `tini` signal handling. The image
already starts `python -m tutupbuku.daemon`.

Zero instances keeps the worker stopped. Scaling overrides in the Vercel
dashboard persist across deployments, so inspect and clear any old override
before relying on the count in the file. Configuring a positive count starts
compute usage. Quotas depend on the account; the per-instance memory choices
are `1Gi`, `2Gi`, `4Gi`, and `8Gi`. Larger choices also receive more CPU. A
valid configuration does not prove that account quota or capacity is available.

## Prepare Postgres and credentials

1. Apply `prisma/daemon.sql` to the existing database through its SQL editor or
   run `python -m tutupbuku.daemon --migrate` in an approved migration session
   with `DATABASE_URL` supplied through the environment. The image contains
   this SQL file. Use an account allowed to create the daemon
   tables and indexes in the TutupBuku schema. This adds the queue and durable
   workflow storage; the hosted API does not apply migrations automatically.
   Inspect the SQL before running it against production and retain existing
   workspace records. Startup never applies this migration implicitly. No new
   provider needs to be provisioned.
2. Keep the existing server-side Production `DATABASE_URL`. The worker and API
   must use the same intended database and schema. The current connection helper
   handles the Prisma-style `schema` query parameter and disables prepared
   statements for the transaction pooler. Do not use a live production queue for
   local experiments.
3. Add `CODEBUDDY_AUTH_TOKEN` as a Production **Secret** using the existing
   account's supported token authentication. Do not commit the token, copy a
   personal `.codebuddy` home, pass it in a Docker build argument, or print it
   while checking configuration. No interactive login state is included in the
   image. The gateway launcher must reject missing credentials and stop rather
   than accept an unauthenticated local gateway. This deployment path does not
   refresh that token; if the issuer gives you a short-lived token, use the
   documented CodeBuddy `apiKeyHelper` mechanism with an approved refresh
   credential before relying on unattended operation. Local gateway readiness
   does not verify that the upstream account token or model access is valid.
4. Keep `TUTUPBUKU_DAEMON_ENABLED=0` during configuration-only preparation.
   Activation uses `TUTUPBUKU_DAEMON_ENABLED=1` and requires `DATABASE_URL`.
   This project-level flag is shared by the worker and hosted API. With the
   flag enabled, API readiness must remain false until a ready worker has a
   recent heartbeat; do not submit jobs before checking that state.
   `TUTUPBUKU_WORKER_WORKSPACE` defaults to `default`; the API and worker must
   agree on the intended workspace. `TUTUPBUKU_WORKER_MAX_COMMANDS_PER_HOUR`
   defaults to `120` and caps worker commands, not every upstream model call.
   The daemon reads its injected environment and does not automatically load
   a parent `.env` file.
5. Leave the existing public API authentication configuration unchanged during
   this migration. `TUTUPBUKU_API_TOKEN` is optional; if enabled it requires an
   `Authorization: Bearer` header on API requests. The current frontend does
   not add that header automatically, so enabling it needs corresponding client
   or proxy work first. The private loopback gateway uses its own protection.

## Protect credit-backed endpoints

The current app does not authenticate end users. When the daemon is enabled,
its chat, council and execution routes can make calls using the configured
WorkBuddy account. Protect the public hostname with an access control before
scaling the worker. The connected Vercel project currently reports SSO
protection for Vercel-owned domains, with custom domains exempt; verify the
actual Exabytes hostname and any aliases separately. The command budget limits
volume but is not user authentication.

Keep a positive instance count and API queue activation out of the initial
configuration-only deployment. That permits the image/configuration to be
reviewed without launching an unauthenticated worker. A full hosted staging
test needs an isolated project's production deployment and separate test data;
a normal preview cannot verify a daemon.

## Verify locally

Run the offline checks with the repository's Python 3.12 environment:

```powershell
.\.dist\vercel-api-venv\Scripts\python.exe -m unittest discover -s tests -p test_daemon_config.py -v
.\.dist\vercel-api-venv\Scripts\python.exe scripts/validate_daemon_config.py
```

The validator checks current daemon fields, region names, limits, and local
paths without network access or secret access. It checks this repository's
supported configuration subset, not the entire Vercel schema, account quotas,
credentials, image compatibility, or live behavior. The proposed block was
also checked separately against the official Daemons JSON subschema.

With Docker Desktop's Linux engine running, build and inspect the image without
starting the worker or making model calls:

```powershell
docker build --platform linux/amd64 --tag tutupbuku-daemon:check .
docker run --rm --entrypoint sh tutupbuku-daemon:check -c 'id; python --version; node --version; codebuddy --version; tesseract --version'
```

No credentials are needed for these checks. Use a separate, git-ignored runtime
environment file for an explicitly authorized local worker test. Pass secrets
with `--env-file`, not command-line values. Stopping a container or replacing an
instance must leave checkpointed jobs and files available in Postgres.

During preparation on this Windows host, Python 3.12.14 and the existing test
environment were available. Docker client 29.1.2 was present, but its engine was
unavailable; an image build and Linux CLI startup were therefore not verified.
Isolated database tests can use the development-only PGlite 0.5.10 and
`@electric-sql/pglite-socket` 0.2.13 installation under ignored
`.dist/daemon-pg/`. It exercises PostgreSQL SQL through the real `psycopg`
wire connection without contacting the user's database. PGlite multiplexes
connections onto one database connection, so those tests do not establish
independent PostgreSQL transaction concurrency or production behavior.

## Activate and verify the complete flow

After the migration, credentials, image, and target project have been verified,
set `TUTUPBUKU_DAEMON_ENABLED=1` and start one instance in Singapore as part of
the production rollout. Check startup logs without exposing tokens. Confirm
that the worker can start its protected loopback gateway, connect to the
intended database, and report a recent ready heartbeat before using the API's
queued operations. Keep the
HTTP service available through the existing `/api/` routes.

Use an explicitly authorized synthetic case for the first model-backed run.
That upstream request is needed to verify actual account authentication and
model access; a local gateway health check cannot establish either.
Verify submission, durable queue claim, status polling, human review pause and
resume, export retrieval, and recovery after replacing the worker. Check the
database and saved artifacts rather than relying only on an HTTP health check
or an accepted job response. A queued job is not a completed review.

To stop work, set every instance count to zero and clear any positive scaling
override; the shutdown handler must drain or checkpoint the current job. Set
`TUTUPBUKU_DAEMON_ENABLED=0` for the next deployment to disable hosted queue
operations as well. Keep durable database data for recovery. Rollback may
restart older worker code; check database compatibility before promoting an
older deployment.

Official references: [Daemons](https://vercel.com/docs/daemons),
[configuration reference](https://vercel.com/docs/daemons/config-reference),
[project JSON schema](https://openapi.vercel.sh/vercel.json),
[environment variables](https://vercel.com/docs/environment-variables), and
[Singapore region](https://vercel.com/docs/pricing/regional-pricing/sin1).
