"""Offline deployment checks reject mistakes before a production worker is started."""

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_daemon_config.py"


class DaemonConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "Dockerfile").write_text("FROM python:3.12-slim-bookworm\n", encoding="utf-8")
        self.config = {
            "services": {"backend": {"root": ".", "framework": "fastapi"}},
            "daemons": {
                "worker": {
                    "root": ".",
                    "entrypoint": "Dockerfile",
                    "command": ["python", "-m", "tutupbuku.daemon"],
                    "instances": {"sin1": 0},
                    "resources": {"requests": {"memory": "1Gi"}},
                    "terminationGracePeriodSeconds": 60,
                }
            },
        }

    def _validator(self):
        self.assertTrue(SCRIPT.is_file(), "The offline daemon configuration validator is missing.")
        spec = importlib.util.spec_from_file_location("validate_daemon_config", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module.validate_config

    def test_zero_instance_singapore_configuration_can_ship_without_starting_workers(self) -> None:
        self.assertEqual(self._validator()(self.config, self.root), [])

    def test_invalid_daemon_fields_regions_and_limits_are_rejected(self) -> None:
        invalid_values = [
            ("runtime", "python3.12"),
            ("instances", {"kul1": 1}),
            ("instances", {"sin1": True}),
            ("instances", {"sin1": -1}),
            ("instances", {"sin1": 101}),
            ("instances", []),
            ("command", []),
            ("command", ["python", ""]),
            ("resources", {"requests": {"memory": "3Gi"}}),
            ("resources", {"requests": {"memory": "1Gi", "cpu": 1}}),
            ("terminationGracePeriodSeconds", 3601),
            ("terminationGracePeriodSeconds", True),
        ]
        validate = self._validator()
        for field, value in invalid_values:
            with self.subTest(field=field, value=value):
                config = copy.deepcopy(self.config)
                config["daemons"]["worker"][field] = value
                self.assertTrue(validate(config, self.root))

    def test_missing_fields_and_invalid_names_are_rejected(self) -> None:
        validate = self._validator()
        for field in ("root", "entrypoint", "instances"):
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                del config["daemons"]["worker"][field]
                self.assertTrue(validate(config, self.root))
        config = copy.deepcopy(self.config)
        config["daemons"]["Worker1"] = config["daemons"].pop("worker")
        self.assertTrue(validate(config, self.root))

    def test_container_paths_cannot_escape_the_project_or_point_to_missing_files(self) -> None:
        validate = self._validator()
        for field, value in (("root", "../outside"), ("entrypoint", "../Dockerfile"),
                             ("root", "missing"), ("entrypoint", "missing/Dockerfile")):
            with self.subTest(field=field, value=value):
                config = copy.deepcopy(self.config)
                config["daemons"]["worker"][field] = value
                self.assertTrue(validate(config, self.root))

    def test_active_instance_counts_and_maximum_grace_period_are_valid(self) -> None:
        self.config["daemons"]["worker"]["instances"] = {"sin1": 1, "iad1": 0}
        self.config["daemons"]["worker"]["terminationGracePeriodSeconds"] = 3600
        self.assertEqual(self._validator()(self.config, self.root), [])

    def test_missing_daemons_and_nonobject_configuration_are_rejected(self) -> None:
        validate = self._validator()
        for config in (None, [], {}, {"daemons": []}, {"daemons": {}}):
            with self.subTest(config=config):
                self.assertTrue(validate(config, self.root))

    def test_command_line_returns_failure_for_bad_json_and_success_for_valid_config(self) -> None:
        self._validator()
        path = self.root / "vercel.json"
        path.write_text("{", encoding="utf-8")
        failed = subprocess.run([sys.executable, str(SCRIPT), "--config", str(path)], capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("Cannot read configuration", failed.stderr)
        path.write_text(json.dumps(self.config), encoding="utf-8")
        passed = subprocess.run([sys.executable, str(SCRIPT), "--config", str(path)], capture_output=True, text=True)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertIn("no image build or runtime check", passed.stdout)


if __name__ == "__main__":
    unittest.main()
