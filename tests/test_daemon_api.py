from __future__ import annotations

import base64
import json
import unittest
import uuid

from fastapi.testclient import TestClient
from tutupbuku.api import create_app
from tutupbuku.daemon_store import DaemonStoreError


class Mailbox:
    def __init__(self):
        self.jobs = {}
        self.online = True
        self.calls = []
        self.reply = None

    def health(self):
        return {"online": self.online, "updated_at": None}

    def submit(self, method, path, payload=None, *, headers=None, key=None):
        if not self.online:
            raise DaemonStoreError("Worker offline", code="WORKER_OFFLINE")
        self.calls.append((method, path, payload, headers, key))
        job = {"id": str(uuid.uuid4()), "status": "completed" if self.reply else "queued", "response": self.reply, "error": None}
        self.jobs[job["id"]] = job
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)


class DaemonApiTests(unittest.TestCase):
    def setUp(self):
        self.store = Mailbox()
        self.app = create_app(env={"TUTUPBUKU_DAEMON_ENABLED": "1"}, daemon_store=self.store)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def test_execution_is_queued_without_running_paid_work_in_function(self):
        response = self.client.post("/api/execution", json={"case_id": "Sept2026", "goal": "review", "request_id": "same-request"})
        self.assertEqual(response.status_code, 202)
        job = response.json()["worker_job"]
        self.assertEqual(job["status"], "queued")
        self.assertEqual(self.store.calls[0][0:3], ("POST", "/api/execution", {"case_id": "Sept2026", "goal": "review", "request_id": "same-request"}))
        self.assertTrue(self.store.calls[0][4])
        self.assertEqual(self.client.get(f"/api/worker/jobs/{job['id']}").json()["worker_job"]["id"], job["id"])

    def test_completed_worker_reply_preserves_original_accepted_run_contract(self):
        self.store.reply = {"status": 202, "headers": {"Content-Type": "application/json"},
                            "body": base64.b64encode(json.dumps({"run": {"id": "run1", "status": "running"}}).encode()).decode()}
        response = self.client.post("/api/execution", json={"goal": "review"})
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["run"]["status"], "running")

    def test_offline_worker_fails_closed_and_health_is_explicit(self):
        self.store.online = False
        response = self.client.post("/api/chat", json={"message": "hello"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "WORKER_OFFLINE")
        self.assertFalse(self.client.get("/api/health").json()["capabilities"]["execution"])

    def test_authentication_also_protects_worker_job_results(self):
        app = create_app(env={"TUTUPBUKU_DAEMON_ENABLED": "1", "TUTUPBUKU_API_TOKEN": "x" * 32}, daemon_store=self.store)
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/worker/jobs/" + str(uuid.uuid4())).status_code, 401)
            self.assertEqual(client.post("/api/chat", json={"message": "hello"}).status_code, 401)
            self.assertEqual(client.post("/api/chat", json={"message": "hello"}, headers={"Authorization": "Bearer " + "x" * 32}).status_code, 202)
        self.assertNotIn("Authorization", self.store.calls[-1][3])

    def test_payload_limit_unknown_fields_and_job_ids_are_validated(self):
        self.assertEqual(self.client.post("/api/chat", json={"message": "hello", "shell": "whoami"}).status_code, 400)
        self.assertEqual(self.client.post("/api/chat", content="[]", headers={"Content-Type": "application/json"}).status_code, 400)
        self.assertEqual(self.client.get("/api/worker/jobs/not-a-uuid").status_code, 404)
        self.assertEqual(self.client.post("/api/arbitrary-command", json={}).status_code, 404)

    def test_query_does_not_allow_arbitrary_proxy_targets(self):
        self.assertEqual(self.client.get("/api/execution?url=http://example.invalid").status_code, 400)
        self.assertEqual(self.client.get("/api/source/%2e%2e%2f.env?case_id=Sept2026").status_code, 400)

    def test_file_response_is_decoded_and_only_allowed_headers_are_forwarded(self):
        self.store.reply = {"status": 200, "headers": {"Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="01_proposals.csv"', "Set-Cookie": "untrusted=1"},
                            "body": base64.b64encode(b"a,b\n1,2\n").decode()}
        response = self.client.get("/api/exports/01_proposals.csv?case_id=Sept2026")
        self.assertEqual(response.content, b"a,b\n1,2\n")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertNotIn("set-cookie", response.headers)

    def test_daemon_mode_without_database_has_a_clear_setup_error(self):
        with TestClient(create_app(env={"TUTUPBUKU_DAEMON_ENABLED": "1"})) as client:
            response = client.post("/api/chat", json={"message": "hello"})
            self.assertEqual(response.status_code, 503)
            self.assertIn("DATABASE_URL", response.json()["error"])


if __name__ == "__main__":
    unittest.main()
