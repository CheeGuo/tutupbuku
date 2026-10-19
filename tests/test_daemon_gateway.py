import importlib
import io
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError

from tutupbuku.workbuddy import WorkBuddyClient, WorkBuddyError


class HealthResponse:
    def __init__(self, body=b'{"data":{"status":"ok","uptime":1,"platforms":["generic"]}}'):
        self.body = body

    def read(self, limit=-1):
        return self.body if limit < 0 else self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class GatewayProcessTests(unittest.TestCase):
    def setUp(self):
        try:
            self.module = importlib.import_module("tutupbuku.daemon_gateway")
        except ModuleNotFoundError:
            self.fail("The gateway process lifecycle is not implemented yet.")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            "PATH": "test-path",
            "CODEBUDDY_AUTH_TOKEN": "existing-account-secret",
            "CODEBUDDY_GATEWAY_PASSWORD": "private-gateway-secret",
            "TUTUPBUKU_CUSTOM_SETTING": "retained",
        }
        self.process = Mock()
        self.process.poll.return_value = None
        self.process.wait.return_value = 0
        self.which = self._patch("shutil.which", return_value="/usr/local/bin/codebuddy")
        self.version = self._patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "2.164.0\n"))
        self.spawn = self._patch("subprocess.Popen", return_value=self.process)
        self.health = self._patch("urlopen", return_value=HealthResponse())
        self._patch("time.sleep")

    def _patch(self, target, **kwargs):
        patcher = patch("tutupbuku.daemon_gateway." + target, **kwargs)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def test_requires_existing_account_token_without_provider_key_fallback(self):
        for value in (None, "", "  ", "token\nwith-newline"):
            with self.subTest(token=value):
                env = {"CODEBUDDY_API_KEY": "a-provider-key"}
                if value is not None:
                    env["CODEBUDDY_AUTH_TOKEN"] = value
                gateway = self.module.GatewayProcess(self.root, env=env)
                self.assertIs(gateway.configured, False)
                with self.assertRaises(WorkBuddyError) as caught:
                    gateway.start()
                self.assertEqual(caught.exception.code, "GATEWAY_NOT_CONFIGURED")
        self.spawn.assert_not_called()
        self.version.assert_not_called()

    def test_starts_local_authenticated_gateway_and_preserves_environment(self):
        self.env.update({"CODEBUDDY_GATEWAY_AUTH": "none", "CODEBUDDY_FORCE_HEADLESS_BUNDLE": "0"})
        original = self.env.copy()
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        self.addCleanup(gateway.stop)
        client = gateway.start()
        self.assertIs(gateway.configured, True)
        self.assertIsInstance(client, WorkBuddyClient)
        self.assertEqual(client.base_url, "http://127.0.0.1:8081")
        self.assertEqual(client.password, "private-gateway-secret")
        command = self.spawn.call_args.args[0]
        for flag, value in (("--host", "127.0.0.1"), ("--port", "8081"), ("--auth", "password")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--serve", command)
        self.assertNotIn("existing-account-secret", command)
        self.assertNotIn("private-gateway-secret", command)
        options = self.spawn.call_args.kwargs
        self.assertEqual(options["cwd"], self.root)
        self.assertEqual(options["env"]["CODEBUDDY_AUTH_TOKEN"], "existing-account-secret")
        self.assertEqual(options["env"]["TUTUPBUKU_CUSTOM_SETTING"], "retained")
        self.assertEqual(options["env"]["CODEBUDDY_GATEWAY_AUTH"], "password")
        self.assertEqual(options["env"]["CODEBUDDY_FORCE_HEADLESS_BUNDLE"], "1")
        self.assertEqual(self.env, original)
        self.assertIs(options["stdout"], subprocess.DEVNULL)
        self.assertIs(options["stderr"], subprocess.DEVNULL)
        self.assertIs(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(self.health.call_args.args[0].full_url, "http://127.0.0.1:8081/api/v1/health")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_generates_private_gateway_password_without_printing_credentials(self):
        self.env.pop("CODEBUDDY_GATEWAY_PASSWORD")
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        self.addCleanup(gateway.stop)
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            client = gateway.start()
        self.assertGreaterEqual(len(client.password), 32)
        self.assertNotEqual(client.password, "existing-account-secret")
        self.assertEqual(self.spawn.call_args.kwargs["env"]["CODEBUDDY_GATEWAY_PASSWORD"], client.password)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("CODEBUDDY_GATEWAY_PASSWORD", self.env)

    def test_account_token_worker_disables_provider_overrides_and_auto_updates(self):
        self.env.update({
            "CODEBUDDY_API_KEY": "unrelated-provider-key",
            "CODEBUDDY_BASE_URL": "https://unrelated-provider.invalid",
            "DISABLE_AUTOUPDATER": "0",
        })
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        self.addCleanup(gateway.stop)
        gateway.start()
        child_env = self.spawn.call_args.kwargs["env"]
        self.assertNotIn("CODEBUDDY_API_KEY", child_env)
        self.assertNotIn("CODEBUDDY_BASE_URL", child_env)
        self.assertEqual(child_env["DISABLE_AUTOUPDATER"], "1")
        self.assertEqual(self.env["DISABLE_AUTOUPDATER"], "0")

    def test_rejects_wrong_cli_version_without_launching_gateway(self):
        self.version.return_value = subprocess.CompletedProcess([], 0, "2.160.0\nexisting-account-secret")
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        with self.assertRaises(WorkBuddyError) as caught:
            gateway.start()
        self.assertEqual(caught.exception.code, "GATEWAY_VERSION")
        self.assertNotIn("existing-account-secret", str(caught.exception))
        self.spawn.assert_not_called()

    def test_missing_binary_is_sanitized(self):
        self.which.return_value = None
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        with self.assertRaises(WorkBuddyError) as caught:
            gateway.start()
        self.assertEqual(caught.exception.code, "GATEWAY_EXECUTABLE")
        self.spawn.assert_not_called()

    def test_early_child_exit_is_reported_without_probing_or_leaking_output(self):
        self.process.poll.return_value = 17
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        with self.assertRaises(WorkBuddyError) as caught:
            gateway.start()
        self.assertEqual(caught.exception.code, "GATEWAY_START_FAILED")
        self.assertNotIn("secret", str(caught.exception))
        self.health.assert_not_called()
        self.process.wait.assert_called()

    def test_health_timeout_stops_child_and_keeps_failure_sanitized(self):
        self.health.side_effect = URLError("existing-account-secret private-gateway-secret")
        with patch("tutupbuku.daemon_gateway.time.monotonic", side_effect=[0, 0, 1000]):
            gateway = self.module.GatewayProcess(self.root, env=self.env)
            with self.assertRaises(WorkBuddyError) as caught:
                gateway.start()
        self.assertEqual(caught.exception.code, "GATEWAY_START_TIMEOUT")
        self.assertNotIn("secret", str(caught.exception))
        self.process.terminate.assert_called_once()
        self.process.wait.assert_called()

    def test_health_must_have_documented_ok_status(self):
        for body in (b"not json", b'{"status":"ok"}', b'{"data":{"status":"starting"}}'):
            with self.subTest(body=body):
                self.health.return_value = HealthResponse(body)
                self.process.poll.side_effect = [None, 1, 1]
                gateway = self.module.GatewayProcess(self.root, env=self.env)
                with self.assertRaises(WorkBuddyError):
                    gateway.start()

    def test_spawn_error_does_not_expose_environment_or_original_exception(self):
        self.spawn.side_effect = OSError("existing-account-secret private-gateway-secret")
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        with self.assertRaises(WorkBuddyError) as caught:
            gateway.start()
        self.assertEqual(caught.exception.code, "GATEWAY_START_FAILED")
        self.assertNotIn("secret", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)

    def test_stop_escalates_to_kill_and_is_idempotent(self):
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        gateway.start()
        self.process.wait.side_effect = [subprocess.TimeoutExpired("codebuddy", 5), 0]
        gateway.stop()
        gateway.stop()
        self.process.terminate.assert_called_once()
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_count, 2)

    def test_repeated_start_reuses_the_running_child_and_client(self):
        gateway = self.module.GatewayProcess(self.root, env=self.env)
        self.addCleanup(gateway.stop)
        client = gateway.start()
        self.assertIs(gateway.start(), client)
        self.spawn.assert_called_once()


if __name__ == "__main__":
    unittest.main()
