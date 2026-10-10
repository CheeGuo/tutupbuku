import json
import unittest

from tutupbuku.workbuddy import WorkBuddyClient, WorkBuddyError


class FakeResponse:
    def __init__(self, body: bytes, content_type: str = "application/json") -> None:
        self.body = body
        self.headers = {"Content-Type": content_type}

    def read(self, size: int = -1) -> bytes:
        return self.body if size < 0 else self.body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class WorkBuddyClientTests(unittest.TestCase):
    def test_documented_gateway_request_and_correlated_final_sse_reply(self) -> None:
        calls = []
        accepted_id = "request-123"

        def opener(request, timeout):
            calls.append((request, timeout))
            if request.full_url.endswith("/api/v1/runs"):
                payload = json.loads(request.data)
                self.assertEqual(payload["payload"]["text"], "review this case")
                self.assertEqual(payload["id"], accepted_id)
                self.assertEqual(payload["type"], "message")
                self.assertEqual(payload["source"]["platform"], "generic")
                self.assertEqual(request.get_header("X-codebuddy-request"), "1")
                self.assertEqual(request.get_header("Authorization"), "Bearer secret")
                return FakeResponse(b'{"data":{"runId":"gateway-1","status":"accepted"}}')
            frame = {
                "replyTo": accepted_id,
                "status": "completed",
                "content": {"text": '{"summary":"Reviewed","review_status":"needs_operator"}'},
            }
            body = ("event: message\ndata: " + json.dumps(frame) + "\n\n").encode()
            return FakeResponse(body, "text/event-stream")

        accepted = []
        client = WorkBuddyClient(
            base_url="http://127.0.0.1:8081",
            password="secret",
            opener=opener,
            request_id_factory=lambda: accepted_id,
        )
        result = client.run_prompt("review this case", job_id="job-1", on_accepted=accepted.append)
        self.assertEqual(result["text"], '{"summary":"Reviewed","review_status":"needs_operator"}')
        self.assertEqual(result["run_id"], "gateway-1")
        self.assertEqual(accepted, ["gateway-1"])
        self.assertEqual(len(calls), 2)

    def test_gateway_url_must_be_private_loopback_and_password_is_required_for_runs(self) -> None:
        with self.assertRaises(WorkBuddyError):
            WorkBuddyClient(base_url="https://public.example", password="secret")
        client = WorkBuddyClient(base_url="http://127.0.0.1:8081", password="")
        self.assertFalse(client.configured)
        with self.assertRaises(WorkBuddyError):
            client.run_prompt("review", job_id="job-1")

    def test_accepted_run_without_correlated_final_reply_is_unconfirmed(self) -> None:
        def opener(request, timeout):
            if request.full_url.endswith("/api/v1/runs"):
                return FakeResponse(b'{"data":{"runId":"gateway-1","status":"accepted"}}')
            wrong = {"replyTo": "different-request", "status": "completed", "content": {"text": "ok"}}
            return FakeResponse(("event: message\ndata: " + json.dumps(wrong) + "\n\n").encode(), "text/event-stream")

        client = WorkBuddyClient("http://127.0.0.1:8081", "secret", opener=opener, request_id_factory=lambda: "request-123")
        with self.assertRaises(WorkBuddyError) as caught:
            client.run_prompt("review", job_id="job-1")
        self.assertTrue(caught.exception.outcome_uncertain)


if __name__ == "__main__":
    unittest.main()