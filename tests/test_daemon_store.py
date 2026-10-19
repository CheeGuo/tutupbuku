"""Exercise the durable worker contract against a disposable PostgreSQL database.

Set TUTUPBUKU_TEST_DATABASE_URL to a dedicated local database; never production.
"""
from __future__ import annotations

import os
import unittest
import uuid

from tutupbuku.daemon_store import DaemonStoreError, PostgresDaemonStore


class StoreValidationTests(unittest.TestCase):
    def test_namespace_is_a_plain_identifier(self):
        with self.assertRaises(ValueError):
            PostgresDaemonStore("postgresql://test:test@localhost/test", workspace="../other")


@unittest.skipUnless(os.environ.get("TUTUPBUKU_TEST_DATABASE_URL"), "needs a disposable test Postgres")
class PostgresDaemonStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = PostgresDaemonStore(os.environ["TUTUPBUKU_TEST_DATABASE_URL"], workspace="test_" + uuid.uuid4().hex)
        self.store.initialize()
        self.owner = str(uuid.uuid4())
        self.assertTrue(self.store.acquire(self.owner))
        self.assertTrue(self.store.checkpoint(self.owner, {"fixtures/case/a.txt": "YQ=="}, ready=True))

    def tearDown(self):
        with self.store.connection() as conn:
            conn.execute(f"delete from {self.store.table('daemon_commands')} where workspace = %s", (self.store.workspace,))
            conn.execute(f"delete from {self.store.table('daemon_workspaces')} where workspace = %s", (self.store.workspace,))

    def test_duplicate_submission_reuses_job_and_rejects_conflicting_body(self):
        first = self.store.submit("POST", "/api/chat", {"message": "hello"}, key="same-request")
        again = self.store.submit("POST", "/api/chat", {"message": "hello"}, key="same-request")
        self.assertEqual(first["id"], again["id"])
        with self.assertRaises(DaemonStoreError) as caught:
            self.store.submit("POST", "/api/chat", {"message": "different"}, key="same-request")
        self.assertEqual(caught.exception.status, 409)

    def test_only_one_worker_can_own_workspace_and_claim_a_job(self):
        other = str(uuid.uuid4())
        self.assertFalse(self.store.acquire(other))
        self.store.submit("POST", "/api/chat", {"message": "hello"})
        with self.assertRaises(DaemonStoreError):
            self.store.claim(other)
        claimed = self.store.claim(self.owner)
        self.assertEqual(claimed["status"], "running")
        self.assertIsNone(self.store.claim(self.owner))

    def test_completion_and_checkpoint_are_durable_and_scoped(self):
        job = self.store.submit("POST", "/api/chat", {"message": "hello"})
        self.store.claim(self.owner)
        reply = {"status": 200, "headers": {"Content-Type": "application/json"}, "body": "e30="}
        self.store.complete(self.owner, job["id"], reply, {"fixtures/case/a.txt": "Yg=="})
        self.assertEqual(self.store.get(job["id"])["response"], reply)
        self.assertEqual(self.store.restore(), {"fixtures/case/a.txt": "Yg=="})
        isolated = PostgresDaemonStore(os.environ["TUTUPBUKU_TEST_DATABASE_URL"], workspace="another")
        self.assertIsNone(isolated.get(job["id"]))

    def test_replacement_does_not_replay_a_claimed_paid_command(self):
        job = self.store.submit("POST", "/api/chat", {"message": "hello"})
        self.store.claim(self.owner)
        self.store.release(self.owner)
        replacement = str(uuid.uuid4())
        self.assertTrue(self.store.acquire(replacement))
        self.assertEqual(self.store.get(job["id"])["status"], "unconfirmed")
        self.assertIsNone(self.store.claim(replacement))
        with self.assertRaises(DaemonStoreError):
            self.store.complete(self.owner, job["id"], {"status": 200, "headers": {}, "body": ""}, {})
        self.assertFalse(self.store.checkpoint(self.owner, {}, ready=True))

    def test_offline_worker_rejects_new_work_but_existing_idempotent_job_is_readable(self):
        first = self.store.submit("POST", "/api/chat", {"message": "hello"}, key="saved")
        self.store.release(self.owner)
        self.assertFalse(self.store.health()["online"])
        self.assertEqual(first["id"], self.store.submit("POST", "/api/chat", {"message": "hello"}, key="saved")["id"])
        with self.assertRaises(DaemonStoreError) as caught:
            self.store.submit("POST", "/api/chat", {"message": "new"})
        self.assertEqual(caught.exception.status, 503)

    def test_checkpoint_acceptance_requires_a_live_lease(self):
        with self.store.connection() as conn:
            conn.execute(f"update {self.store.table('daemon_workspaces')} set lease_until = now() - interval '1 second' where workspace = %s", (self.store.workspace,))
        self.assertFalse(self.store.checkpoint(self.owner, {"new": "value"}, ready=True))
        self.assertEqual(self.store.restore(), {"fixtures/case/a.txt": "YQ=="})

    def test_request_rate_limit_survives_store_recreation(self):
        first = PostgresDaemonStore(os.environ["TUTUPBUKU_TEST_DATABASE_URL"], workspace=self.store.workspace, max_posts_per_hour=1)
        first.submit("POST", "/api/chat", {"message": "one"})
        recreated = PostgresDaemonStore(os.environ["TUTUPBUKU_TEST_DATABASE_URL"], workspace=self.store.workspace, max_posts_per_hour=1)
        with self.assertRaises(DaemonStoreError) as caught:
            recreated.submit("POST", "/api/chat", {"message": "two"})
        self.assertEqual(caught.exception.status, 429)


if __name__ == "__main__":
    unittest.main()
