"""Native retry cannot waive failed gates, change app bytes or accept another origin."""

import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("candidate", Path(__file__).with_name("windows-native-candidate.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "repository": {"full_name": "yuxino/kiri", "id": 1},
                    "head_repository": {"full_name": "yuxino/Kiri"}, "head_sha": "a" * 40,
                    "path": candidate.WORKFLOW, "event": "workflow_dispatch", "status": "completed", "run_attempt": 1}
        self.job = {"id": 456, "name": candidate.JOB, "status": "completed", "conclusion": "failure", "steps": [
            *({"name": name, "conclusion": "success"} for name in candidate.BUILD_STEPS),
            *({"name": name, "conclusion": "skipped"} for name in candidate.NATIVE_STEPS),
        ]}
        self.step("Verify configurable shortcuts on the actual desktop")["conclusion"] = "failure"

    def step(self, name):
        return next(step for step in self.job["steps"] if step["name"] == name)

    def validate(self, paths=()):
        return candidate.validate(self.run, [self.job], 123, paths)

    def test_failed_shortcut_and_every_skipped_gate_must_be_replayed(self):
        job, gates = self.validate(["scripts/qa/shortcut-native.py", ".github/workflows/build.yml"])
        self.assertEqual(job, self.job)
        self.assertEqual(gates, list(candidate.NATIVE_STEPS.values()))
        self.assertIn("confirmation-native.py", gates)
        self.assertIn("windows-capture-color-native.py", gates)
        self.assertIn("windows-library-files-native.py", gates)

    def test_older_candidate_without_new_features_keeps_existing_gates(self):
        self.job["steps"] = [step for step in self.job["steps"] if step["name"] not in {
            "Verify destructive confirmation windows on the actual desktop",
            "Verify hover colors and native clipboard on the installed Windows app",
            "Verify library file actions on the installed Windows app"}]
        self.assertEqual(self.validate()[1], list(candidate.REQUIRED_NATIVE))

    def test_rejects_unfinished_other_or_ambiguous_builds(self):
        original = copy.deepcopy(self.run)
        for key, value in (("id", 124), ("repository", {"full_name": "other/kiri"}),
                           ("head_repository", {"full_name": "other/kiri"}), ("path", "release.yml"),
                           ("event", "pull_request"), ("status", "in_progress"),
                           ("head_sha", "--bad"), ("run_attempt", 2)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.run = {**original, key: value}
                self.validate()
        self.run = original

    def test_rejects_missing_duplicate_cancelled_windows_job(self):
        for jobs in ([], [self.job, self.job], [{**self.job, "conclusion": "cancelled"}]):
            with self.subTest(jobs=jobs), self.assertRaises(RuntimeError):
                candidate.validate(self.run, jobs, 123, [])

    def test_never_waives_build_packaging_or_unknown_failures(self):
        original = copy.deepcopy(self.job)
        for name in candidate.BUILD_STEPS:
            self.step(name)["conclusion"] = "failure"
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                self.validate()
            self.job = copy.deepcopy(original)
        self.job["steps"].append({"name": "Other unrecognized verification", "conclusion": "failure"})
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_rejects_removed_existing_native_gate(self):
        self.job["steps"] = [step for step in self.job["steps"] if step["name"] != "Install and smoke-test both Windows packages"]
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_unknown_skipped_native_gate_cannot_be_silently_waived(self):
        self.job["steps"].append({"name": "Verify another feature on the actual desktop", "conclusion": "skipped"})
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_rejects_application_lockfile_and_packaging_source_changes(self):
        for path in ("src/windows/PinWindow.tsx", "src-tauri/src/commands.rs", "pnpm-lock.yaml",
                     "scripts/package-windows-portable.ps1", "src-tauri/tauri.conf.json"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                self.validate([path])

    def test_markdown_translation_changes_do_not_require_rebuilding(self):
        self.validate(["README.md", "README_ZH.md", "README_JA.md", "docs/architecture.md"])
        for path in ("docs/demos/flow.js", "public/icon.png", "README_ZH.md/escape", "vite.config.ts"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                self.validate([path])

    def test_actual_checkout_is_anchored_to_immediate_sha(self):
        log = '2026-10-10T00:00:00Z [command]"C:\\Program Files\\Git\\bin\\git.exe" log -1 --format=%H\n2026-10-10T00:00:00Z ' + "a" * 40 + "\n"
        self.assertEqual(candidate.checkout_sha(log), "a" * 40)
        for wrong in (log + log, log.replace("a" * 40, "short"), log.replace("[command]", "reported ")):
            with self.subTest(log=wrong), self.assertRaises(RuntimeError):
                candidate.checkout_sha(wrong)

    def test_artifact_requires_official_run_head_and_archive_digest(self):
        artifact = {"name": "kiri-windows", "expired": False, "digest": "sha256:" + "b" * 64,
                    "workflow_run": {"id": 123, "repository_id": 1, "head_sha": "a" * 40}}
        self.assertEqual(candidate.artifact_for(self.run, [artifact], "kiri-windows"), artifact)
        for values in ([artifact, artifact], [{**artifact, "expired": True}], [{**artifact, "digest": None}],
                       [{**artifact, "workflow_run": {**artifact["workflow_run"], "head_sha": "c" * 40}}]):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                candidate.artifact_for(self.run, values, "kiri-windows")


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "candidate.zip"

    def make(self, filename):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr(filename, b"public immutable executable fixture")

    def test_verified_archive_preserves_exact_executable_bytes(self):
        self.make("kiri.exe")
        candidate.extract_verified(self.archive, self.root / "verified", "sha256:" + candidate.digest(self.archive))
        self.assertEqual((self.root / "verified/kiri.exe").read_bytes(), b"public immutable executable fixture")

    def test_archive_checksum_mismatch_is_rejected_before_extraction(self):
        self.make("kiri.exe")
        with self.assertRaises(RuntimeError):
            candidate.extract_verified(self.archive, self.root / "verified", "sha256:" + "0" * 64)
        self.assertFalse((self.root / "verified").exists())

    def test_archive_cannot_escape_its_candidate_directory(self):
        for index, filename in enumerate(("../kiri.exe", "/kiri.exe", "C:/kiri.exe", "folder/../../kiri.exe")):
            with self.subTest(filename=filename):
                self.make(filename)
                with self.assertRaises(RuntimeError):
                    candidate.extract_verified(self.archive, self.root / str(index), "sha256:" + candidate.digest(self.archive))

    def test_different_original_compiled_bytes_are_recorded_and_payload_install_must_match(self):
        compiled, payload, installed = (self.root / name for name in ("compiled.exe", "payload.exe", "installed.exe"))
        compiled.write_bytes(b"original compiled __TAURI_BUNDLE_TYPE_VAR_UNK portable executable")
        payload.write_bytes(compiled.read_bytes().replace(b"_VAR_UNK", b"_VAR_NSS"))
        installed.write_bytes(payload.read_bytes())
        identities = candidate.executable_identities(compiled, payload, installed)
        self.assertFalse(identities["compiled_matches_installed"])
        self.assertEqual(identities["installer_payload_sha256"], identities["executable_sha256"])
        self.assertNotEqual(identities["compiled_executable_sha256"], identities["executable_sha256"])
        self.assertEqual(identities["bundle_marker_proof"]["cli_version"], "2.11.4")
        installed.write_bytes(b"a different installed executable")
        with self.assertRaisesRegex(RuntimeError, "installer payload"):
            candidate.executable_identities(compiled, payload, installed)

    def test_no_extra_payload_change_or_duplicate_marker_can_pass(self):
        compiled, payload, installed = (self.root / name for name in ("compiled.exe", "payload.exe", "installed.exe"))
        compiled.write_bytes(b"__TAURI_BUNDLE_TYPE_VAR_UNK")
        payload.write_bytes(b"__TAURI_BUNDLE_TYPE_VAR_NSS" + b"another change")
        installed.write_bytes(payload.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "beyond"):
            candidate.executable_identities(compiled, payload, installed)
        compiled.write_bytes(compiled.read_bytes() * 2)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            candidate.executable_identities(compiled, payload, installed)


if __name__ == "__main__":
    unittest.main()
