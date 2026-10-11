"""Workspace records: validation, the Prisma column mapping, the file store, the HTTP API, and (when the
database is reachable) a real round trip through Supabase Postgres."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
import uuid
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

from tutupbuku.records import (COLUMNS, LocalRecords, PostgresRecords, RecordStoreError, build_record_store,
                               connection_settings, object_to_params, row_to_object, validate_records)
from tutupbuku.service import TutupBukuService
from tutupbuku.web import create_server

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PROJECT_ROOT / "demo-fixtures" / "Sept2026"


def sample(prefix: str = "T") -> dict:
    doc_po = {"id": f"{prefix}-DOC-PO", "docType": "purchase_order", "flow": "purchasing", "filename": "po.pdf",
              "fields": [{"key": "poNumber", "label": "PO number", "kind": "text", "value": "SFSB-PO-1", "confidence": 0.98},
                         {"key": "total", "label": "Total", "kind": "money", "value": "84.81", "sen": 8481}],
              "lines": [{"id": "l1", "description": "Steel plate", "quantity": 2, "unitSen": 4000, "totalSen": 8000}],
              "status": "VERIFIED", "hash": "abc", "version": 1, "uploadedAt": "2026-09-17T08:00:00Z", "uploadedBy": "Aina",
              "sourceUrl": "/sample-docs/po.pdf"}
    doc_inv = {"id": f"{prefix}-DOC-INV", "docType": "invoice", "flow": "purchasing", "filename": "inv.pdf", "fields": [], "lines": [],
               "status": "NEEDS_REVIEW", "hash": "def", "version": 2, "uploadedAt": "2026-09-20T08:00:00Z", "uploadedBy": "Aina", "note": "re-uploaded"}
    doc_rcpt = {"id": f"{prefix}-DOC-RCPT", "docType": "claim_receipt", "flow": "claims", "filename": "r.jpg", "fields": [], "lines": [],
                "status": "EXTRACTED", "hash": "ghi", "version": 1, "uploadedAt": "2026-09-21T08:00:00Z", "uploadedBy": "Ben"}
    return {
        "docs": [doc_po, doc_inv, doc_rcpt],
        "links": [{"id": f"{prefix}-LNK-1", "sourceId": doc_inv["id"], "targetId": doc_po["id"], "relationship": "for_po", "confidence": 0.9, "confirmedBy": None}],
        "claims": [{"id": f"{prefix}-CLM-1", "employee": "Ben", "receiptDocId": doc_rcpt["id"], "employeePurpose": "Lunch with Company X",
                    "categoryCode": None, "categoryConfidence": 0.4, "categoryReasoning": "fuel vs lunch", "alternativeCodes": ["6100"],
                    "standardizedDescription": "", "findings": ["Purpose mismatch"], "status": "NEEDS_REVIEW",
                    "decision": {"by": "Aina", "at": "2026-09-22", "reason": "ask"}}],
        "issues": [{"id": f"{prefix}-ISS-1", "ruleCode": "PRICE_MISMATCH", "typeLabel": "Price", "title": "Price differs", "severity": "HIGH",
                    "status": "OPEN", "docIds": [doc_inv["id"], doc_po["id"]], "candidateIds": [doc_po["id"]], "detected": "now", "why": "x",
                    "suggested": ["Ask supplier"], "evidence": [{"label": "Unit", "expected": "40.00", "found": "41.00"}], "createdAt": "2026-09-20"}],
        "audit": [{"id": f"{prefix}-AUD-1", "timestamp": "2026-09-20T08:00:00Z", "actor": "Aina", "actorKind": "human",
                   "action": "Uploaded", "entityId": doc_inv["id"], "next": "NEEDS_REVIEW"}],
    }


class ValidationAndMappingTests(unittest.TestCase):
    def test_validation_rejects_bad_shapes(self) -> None:
        good = sample()
        self.assertIs(validate_records(good), good)
        for bad in ({}, {**good, "extra": []}, {**good, "docs": "x"}, {**good, "docs": [{"id": ""}]},
                    {**good, "docs": [{"id": "a"}, {"id": "a"}]}, {**good, "docs": [{"id": "../x y"}]}):
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(RecordStoreError) as caught:
                validate_records(bad)
            self.assertEqual(caught.exception.status, 400)

    def test_every_frontend_field_round_trips_through_the_prisma_columns(self) -> None:
        data = sample()
        for kind, items in data.items():
            names = [column for _, column, _ in COLUMNS[kind][1]]
            for item in items:
                params = object_to_params(kind, item)
                row = {column: (getattr(value, "obj", value)) for column, value in zip(names, params)}  # Jsonb -> python
                self.assertEqual(row_to_object(kind, row), item, f"{kind} {item['id']}")

    def test_prisma_only_url_parameters_are_removed_for_psycopg(self) -> None:
        url, schema = connection_settings("postgresql://u:p@host:6543/postgres?pgbouncer=true&schema=tutupbuku&sslmode=require")
        self.assertEqual(schema, "tutupbuku")
        self.assertNotIn("pgbouncer", url)
        self.assertNotIn("schema=", url)
        self.assertIn("sslmode=require", url)
        with self.assertRaises(RecordStoreError):
            connection_settings('postgresql://u:p@host/db?schema=bad"name')

    def test_store_choice_follows_the_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.assertIsInstance(build_record_store({}, Path(temp)), LocalRecords)
            self.assertIsInstance(build_record_store({"DATABASE_URL": "postgresql://u:p@h:6543/postgres?schema=tutupbuku"}, Path(temp)), PostgresRecords)


class LocalStoreAndApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "fixtures").mkdir()
        import shutil
        shutil.copytree(FIXTURE, self.root / "fixtures" / "Sept2026")
        self.store = LocalRecords(self.root / "records.json")
        self.server = create_server(TutupBukuService(self.root), "127.0.0.1", 0, records=self.store)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def call(self, method: str, path: str, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        self.connection.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
        response = self.connection.getresponse()
        return response.status, json.loads(response.read())

    def test_load_save_reload_and_conflict(self) -> None:
        status, body = self.call("GET", "/api/records")
        self.assertEqual(status, 200)
        self.assertEqual((body["version"], body["storage"]["mode"]), (0, "local"))
        self.assertEqual(body["records"]["docs"], [])

        status, saved = self.call("POST", "/api/records", {"records": sample(), "expected_version": 0})
        self.assertEqual((status, saved["version"]), (200, 1))
        status, body = self.call("GET", "/api/records")
        self.assertEqual(body["records"], sample())

        status, conflict = self.call("POST", "/api/records", {"records": sample(), "expected_version": 0})
        self.assertEqual(status, 409)
        self.assertIn("changed since", conflict["error"])

        status, bad = self.call("POST", "/api/records", {"records": {"docs": []}, "expected_version": 1})
        self.assertEqual(status, 400)
        status, bad = self.call("POST", "/api/records", {"records": sample(), "expected_version": 1, "drop": True})
        self.assertEqual(status, 400)


def _env_database_url() -> str:
    for name in ("TUTUPBUKU_TEST_DATABASE_URL", "DATABASE_URL"):
        if os.environ.get(name):
            return os.environ[name]
    env_file = PROJECT_ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip()
    return ""


DATABASE_URL = _env_database_url()


def _database_reachable() -> bool:
    if not DATABASE_URL.startswith(("postgres://", "postgresql://")):
        return False
    try:
        PostgresRecords(DATABASE_URL).load()
        return True
    except Exception:  # noqa: BLE001 - unreachable, tables missing or driver missing: skip
        return False


@unittest.skipUnless(_database_reachable(), "Supabase Postgres not reachable from here (or tables not created); real round trip skipped")
class SupabaseRoundTripTests(unittest.TestCase):
    """Runs against the real database. It saves the current records back unchanged at the end."""

    def test_real_round_trip_preserves_everything_and_restores_the_original(self) -> None:
        store = PostgresRecords(DATABASE_URL)
        original = store.load()
        marker = f"TEST{uuid.uuid4().hex[:8]}"
        test_records = sample(marker)
        combined = {kind: original["records"][kind] + test_records[kind] for kind in test_records}
        version = store.save(combined, original["version"])
        self.assertEqual(version, original["version"] + 1)
        loaded = store.load()
        for kind, items in test_records.items():
            got = {item["id"]: item for item in loaded["records"][kind]}
            for item in items:
                self.assertEqual(got[item["id"]], item, f"{kind} {item['id']}")
        with self.assertRaises(RecordStoreError) as stale:
            store.save(combined, original["version"])
        self.assertEqual(stale.exception.status, 409)
        restored = store.save(original["records"], loaded["version"])
        after = store.load()
        self.assertEqual(after["version"], restored)
        self.assertFalse(any(item["id"].startswith(marker) for items in after["records"].values() for item in items))


if __name__ == "__main__":
    unittest.main()
