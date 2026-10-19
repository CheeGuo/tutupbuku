-- Additive migration. Run once against the same database used by the hosted API.
-- Match the schema= URL parameter if it is different from tutupbuku.
CREATE SCHEMA IF NOT EXISTS "tutupbuku";
CREATE TABLE IF NOT EXISTS "tutupbuku"."daemon_workspaces" (
    workspace text PRIMARY KEY,
    owner text,
    lease_until timestamptz NOT NULL DEFAULT now(),
    ready boolean NOT NULL DEFAULT false,
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "tutupbuku"."daemon_commands" (
    id text PRIMARY KEY,
    workspace text NOT NULL REFERENCES "tutupbuku"."daemon_workspaces"(workspace),
    method text NOT NULL CHECK (method IN ('GET', 'POST')),
    path text NOT NULL,
    payload jsonb,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_key text,
    fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'unconfirmed')),
    owner text,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (workspace, request_key)
);
CREATE INDEX IF NOT EXISTS daemon_commands_pending ON "tutupbuku"."daemon_commands" (workspace, status, created_at);
ALTER TABLE "tutupbuku"."daemon_workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tutupbuku"."daemon_commands" ENABLE ROW LEVEL SECURITY;
