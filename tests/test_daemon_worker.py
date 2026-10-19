from __future__ import annotations

import unittest

from tutupbuku.daemon import Worker
from tutupbuku.daemon_store import DaemonStoreError


class Store:
    def __init__(self):
        self.job = {"id": "job", "method": "POST", "path": "/api/chat", "payload": {"message": "hello"}, "headers": {}}
        self.completed = None
        self.uncertain = None
        self.lose_lease = False

    def claim(self, owner):
        job, self.job = self.job, None
        return job

    def complete(self, owner, job_id, response, snapshot):
        if self.lose_lease:
            raise DaemonStoreError("lost", 409, "LEASE_LOST")
        self.completed = (job_id, response, snapshot)

    def mark_unconfirmed(self, owner, job_id):
        self.uncertain = job_id


class Runtime:
    def __init__(self):
        self.calls = []
        self.failure = False

    def handle(self, method, path, payload, headers=None):
        self.calls.append((method, path, payload))
        if self.failure:
            raise TimeoutError("unconfirmed local response")
        return {"status": 200, "headers": {}, "body": "e30="}

    def snapshot(self):
        return {"fixtures/case/a.txt": "YQ=="}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.runtime = Runtime()
        self.worker = Worker(self.store, self.runtime, "owner")

    def test_command_response_and_checkpoint_are_committed_together(self):
        self.assertTrue(self.worker.step())
        self.assertEqual(self.store.completed[2], self.runtime.snapshot())
        self.assertFalse(self.worker.step())
        self.assertEqual(len(self.runtime.calls), 1)

    def test_missing_local_response_is_unconfirmed_and_never_replayed(self):
        self.runtime.failure = True
        self.worker.step()
        self.assertEqual(self.store.uncertain, "job")
        self.assertIsNone(self.store.completed)
        self.worker.step()
        self.assertEqual(len(self.runtime.calls), 1)

    def test_fencing_error_stops_worker_instead_of_overwriting_new_owner(self):
        self.store.lose_lease = True
        with self.assertRaises(DaemonStoreError):
            self.worker.step()
        self.assertIsNone(self.store.completed)

    def test_unapproved_database_command_never_reaches_local_server(self):
        self.store.job["path"] = "http://example.invalid/api/chat"
        self.worker.step()
        self.assertFalse(self.runtime.calls)
        self.assertEqual(self.store.completed[1]["status"], 400)


if __name__ == "__main__":
    unittest.main()
