#!/usr/bin/env python3
"""The recorded build attempt must retain an official source identity on reruns."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("provenance", Path(__file__).with_name("linux-package-provenance.py"))
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)


class HarnessSourceBoundaries(unittest.TestCase):
    def test_only_the_named_kali_ocr_workflow_is_allowed_for_candidate_reuse(self):
        self.assertTrue(provenance.allowed_change(".github/workflows/linux-ocr-compat.yml"))
        for path in (".github/workflows/linux-ocr-compat.yml.backup",
                     ".github/workflows/other.yml", ".github/workflows/release.yml",
                     "src-tauri/src/ocr/linux.rs", "src-tauri/tauri.linux.conf.json"):
            with self.subTest(path=path):
                self.assertFalse(provenance.allowed_change(path))


class OriginalBuildAttempt(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "run_attempt": 2, "head_sha": "a" * 40,
                    "path": provenance.WORKFLOW, "repository": {"full_name": "yuxino/kiri"}}
        self.manifest = {"schema_version": 1, "repository": "yuxino/kiri",
                         "workflow_path": provenance.WORKFLOW, "run_id": 123, "run_attempt": 1}
        self.original = {**copy.deepcopy(self.run), "run_attempt": 1}

    def resolve(self):
        return provenance.manifest_run("repos/yuxino/kiri/actions", self.run, self.manifest, "yuxino/kiri")

    def test_old_package_uses_its_official_original_attempt_after_failed_job_rerun(self):
        with patch.object(provenance, "api", return_value=self.original) as api:
            self.assertEqual(self.resolve()["run_attempt"], 1)
            api.assert_called_once_with("repos/yuxino/kiri/actions/runs/123/attempts/1")

    def test_current_package_uses_current_run_without_historical_lookup(self):
        self.manifest["run_attempt"] = 2
        with patch.object(provenance, "api") as api:
            self.assertIs(self.resolve(), self.run)
            api.assert_not_called()

    def test_unrecorded_or_future_attempt_cannot_select_a_job(self):
        for attempt in (0, -1, 3, True, "1", 1.0):
            with self.subTest(attempt=attempt), patch.object(provenance, "api") as api:
                self.manifest["run_attempt"] = attempt
                with self.assertRaisesRegex(RuntimeError, "invalid run attempt"):
                    self.resolve()
                api.assert_not_called()

    def test_manifest_cannot_redirect_to_another_repository_workflow_or_run(self):
        for field, value in (("schema_version", 2), ("repository", "other/kiri"),
                             ("workflow_path", "other.yml"), ("run_id", 124)):
            with self.subTest(field=field), patch.object(provenance, "api") as api:
                bad = {**self.manifest, field: value}
                with self.assertRaisesRegex(RuntimeError, "identity does not match"):
                    provenance.manifest_run("repos/yuxino/kiri/actions", self.run, bad, "yuxino/kiri")
                api.assert_not_called()

    def test_historical_api_result_must_keep_the_original_run_source(self):
        for field, value in (("id", 124), ("run_attempt", 2), ("head_sha", "b" * 40),
                             ("path", "other.yml"), ("repository", {"full_name": "other/kiri"})):
            with self.subTest(field=field), patch.object(provenance, "api", return_value={**self.original, field: value}):
                with self.assertRaisesRegex(RuntimeError, "does not match the official"):
                    self.resolve()


if __name__ == "__main__":
    unittest.main()
