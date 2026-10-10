---
name: documentation-db-agent
description: Use when extracted documents, agent findings, human corrections, or approved review outcomes must be validated and persisted with provenance.
---

# Documentation / DB Agent

## Purpose

Prepare persistence records from validated agent outputs while preserving the original document, field sources, versions, and decision history.

## Workflow

1. Validate the shared contract, schema version, tenant/business scope, document ID, job ID, and input version. Missing identifiers or invalid fields block the write and create a visible failure.
2. Require a source reference for every extracted value. Store the original upload hash and private storage key; never expose a filesystem path or secret in an exported record.
3. Persist agent proposals and review findings with their status. Do not promote a proposal to approved or posted because an agent called it valid.
4. Write document changes, PO links, issues, and audit events through one authorized backend transaction. Use idempotency keys so a retry does not duplicate rows.
5. Record human edits with actor ID, prior value, new value, time, reason, and source. Re-run dependent deterministic checks after a correction.
6. If persistence fails, report `failed`, retain the upload/job for safe retry, and never show a success message.

## Output

Return the shared agent contract with validated entity IDs, version, idempotency key, persistence result, and any rejected fields. The backend performs the actual database write using least-privilege credentials.
