"""A recheck must not replace accepted tag binaries with another candidate."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("windows_provenance", Path(__file__).with_name("windows-package-provenance.py"))
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)


class AcceptedCandidate(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "repository": {"full_name": provenance.REPOSITORY},
                    "head_repository": {"full_name": provenance.REPOSITORY},
                    "path": provenance.WORKFLOW, "event": "push", "head_branch": "v1.6.8",
                    "head_sha": "a" * 40, "status": "completed", "conclusion": "success"}
        self.jobs = [{"name": provenance.JOB, "conclusion": "success", "steps": [
            {"name": name, "conclusion": "success"} for name in (
                "Package and verify portable Windows build", "Install and smoke-test both Windows packages",
                "Upload Windows bundle")]}]

    def validate(self):
        provenance.validate(self.run, self.jobs, 123, "v1.6.8", "a" * 40)

    def test_accepts_successful_official_tag_and_desktop_checks(self):
        self.validate()

    def test_accepts_official_repository_display_casing(self):
        for name in ("yuxino/Kiri", "YUXINO/KIRI"):
            with self.subTest(name=name):
                self.run["repository"]["full_name"] = name
                self.run["head_repository"]["full_name"] = name
                self.validate()

    def test_rejects_other_run_repository_or_fork(self):
        for key, value in (("id", 124), ("repository", {"full_name": "other/kiri"}),
                           ("head_repository", {"full_name": "other/kiri"})):
            with self.subTest(key=key):
                original = copy.deepcopy(self.run)
                self.run[key] = value
                with self.assertRaises(RuntimeError):
                    self.validate()
                self.run = original

    def test_rejects_similar_or_malformed_repository_names(self):
        for key in ("repository", "head_repository"):
            for name in (None, 123, "yuxino/Kiri-other", "other/Kiri", "yuxino/Kiri"):
                with self.subTest(key=key, name=name):
                    original = copy.deepcopy(self.run)
                    self.run[key]["full_name"] = name
                    with self.assertRaises(RuntimeError):
                        self.validate()
                    self.run = original

    def test_rejects_non_tag_or_different_source(self):
        for key, value in (("path", "release.yml"), ("event", "pull_request"),
                           ("head_branch", "main"), ("head_sha", "b" * 40)):
            with self.subTest(key=key):
                original = copy.deepcopy(self.run)
                self.run[key] = value
                with self.assertRaises(RuntimeError):
                    self.validate()
                self.run = original

    def test_rejects_incomplete_or_failed_build(self):
        for key, value in (("status", "in_progress"), ("conclusion", "failure")):
            with self.subTest(key=key):
                original = copy.deepcopy(self.run)
                self.run[key] = value
                with self.assertRaises(RuntimeError):
                    self.validate()
                self.run = original

    def test_rejects_missing_duplicate_or_failed_windows_job(self):
        original = copy.deepcopy(self.jobs)
        for jobs in ([], original * 2, [{**original[0], "conclusion": "failure"}]):
            self.jobs = jobs
            with self.assertRaises(RuntimeError):
                self.validate()

    def test_rejects_missing_or_failed_package_smoke_steps(self):
        for index in range(3):
            for value in ("failure", "skipped"):
                self.jobs[0]["steps"][index]["conclusion"] = value
                with self.assertRaises(RuntimeError):
                    self.validate()
                self.jobs[0]["steps"][index]["conclusion"] = "success"
        self.jobs[0]["steps"] = []
        with self.assertRaises(RuntimeError):
            self.validate()


class CandidateArtifact(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.tag = "v1.6.15"
        self.installer = "kiri_1.6.15_x64-setup.exe"
        self.signature = self.installer + ".sig"
        self.portable = "Kiri-1.6.15-Windows-x64-Portable.zip"
        self.payloads = {self.installer: b"accepted installer bytes", self.signature: b"public signature bytes"}
        for name, payload in self.payloads.items():
            (self.directory / name).write_bytes(payload)

    def check_recorded_bytes(self):
        files = provenance.candidate_files(self.directory, self.tag)
        self.assertEqual(set(files), set(self.payloads))
        for name, payload in self.payloads.items():
            self.assertEqual(files[name], {"sha256": hashlib.sha256(payload).hexdigest(),
                                           "size_bytes": len(payload)})
        return files

    def test_legacy_installer_and_signature_keep_exact_hashes(self):
        self.check_recorded_bytes()

    def test_expected_portable_archive_is_included_in_provenance(self):
        self.payloads[self.portable] = b"accepted portable archive bytes"
        (self.directory / self.portable).write_bytes(self.payloads[self.portable])
        self.check_recorded_bytes()

    def test_portable_cannot_replace_missing_installer_or_signature(self):
        (self.directory / self.portable).write_bytes(b"portable bytes")
        for name, payload in self.payloads.items():
            with self.subTest(name=name):
                (self.directory / name).unlink()
                with self.assertRaises(RuntimeError):
                    provenance.candidate_files(self.directory, self.tag)
                (self.directory / name).write_bytes(payload)

    def test_rejects_extra_packages_and_unknown_files(self):
        for name in ("Kiri-1.6.14-Windows-x64-Portable.zip", "Kiri-1.6.15-Windows-arm64-Portable.zip",
                     "kiri_1.6.14_x64-setup.exe", "another-setup.exe", self.portable + ".sig",
                     "windows-provenance.json", "README.txt"):
            with self.subTest(name=name):
                extra = self.directory / name
                extra.write_bytes(b"unexpected bytes")
                with self.assertRaises(RuntimeError):
                    provenance.candidate_files(self.directory, self.tag)
                extra.unlink()

    def test_rejects_directories_named_as_expected_files(self):
        for name in (self.installer, self.signature, self.portable):
            with self.subTest(name=name):
                entry = self.directory / name
                if entry.exists():
                    entry.unlink()
                entry.mkdir()
                with self.assertRaises(RuntimeError):
                    provenance.candidate_files(self.directory, self.tag)
                entry.rmdir()
                if name in self.payloads:
                    entry.write_bytes(self.payloads[name])

    def test_rejects_symlinked_artifact_entries(self):
        # The fixture stays within its own temporary directory and never
        # follows an artifact link into another file or credential store.
        entry = self.directory / self.portable
        try:
            entry.symlink_to(self.directory / self.installer)
        except (OSError, NotImplementedError):
            self.skipTest("This platform cannot create symlinks")
        with self.assertRaises(RuntimeError):
            provenance.candidate_files(self.directory, self.tag)


class ScreenshotDependency(unittest.TestCase):
    def test_every_native_package_workflow_installs_the_image_dependency(self):
        root = Path(__file__).resolve().parents[2]
        consumers = []
        for workflow in (root / ".github/workflows").glob("*.yml"):
            text = workflow.read_text()
            if "scripts/qa/windows-release-native.py" in text:
                consumers.append(workflow.name)
                with self.subTest(workflow=workflow.name):
                    self.assertTrue(any("pip install" in line and "pywinauto==" in line
                                        and "Pillow==11.3.0" in line for line in text.splitlines()))
        self.assertGreaterEqual(len(consumers), 4)


if __name__ == "__main__":
    unittest.main()
