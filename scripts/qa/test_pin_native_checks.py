import unittest
from unittest.mock import patch
from pathlib import Path
import tempfile

from pin_native_checks import pin_lifecycle_evidence, pin_open_log_marker, proportional_resize_evidence
from windows_qa_profile import isolated_app_directories, isolated_windows_profile


class NativePinChecks(unittest.TestCase):
    asset = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    def trace(self, events, count=2):
        return f"completion queued until overlay destruction labels={count}\n" + "\n".join(events)

    @property
    def opened(self):
        return f"[pin] screenshot opened asset_id={self.asset}"

    def test_every_monitor_overlay_must_be_destroyed_before_pin(self):
        proof = pin_lifecycle_evidence(self.trace([
            "[window] destroyed label=overlay", "[window] destroyed label=overlay-2", self.opened]), self.asset)
        self.assertEqual(proof["destroyed_overlays"], ["overlay", "overlay-2"])

    def test_creation_between_two_overlay_destructions_is_rejected(self):
        with self.assertRaises(RuntimeError):
            pin_lifecycle_evidence(self.trace([
                "[window] destroyed label=overlay", self.opened, "[window] destroyed label=overlay-2"]), self.asset)

    def test_missing_or_duplicate_destruction_cannot_satisfy_monitor_count(self):
        for events in (["[window] destroyed label=overlay", self.opened],
                       ["[window] destroyed label=overlay", "[window] destroyed label=overlay", self.opened]):
            with self.subTest(events=events), self.assertRaises(RuntimeError):
                pin_lifecycle_evidence(self.trace(events), self.asset)

    def test_old_or_repeated_capture_trace_is_rejected(self):
        valid = self.trace(["[window] destroyed label=overlay", self.opened], count=1)
        for trace in (valid + valid, valid + "\n" + self.opened, self.trace([self.opened], count=0)):
            with self.subTest(trace=trace), self.assertRaises(RuntimeError):
                pin_lifecycle_evidence(trace, self.asset)

    def test_pin_for_another_asset_is_rejected(self):
        with self.assertRaises(RuntimeError):
            pin_lifecycle_evidence(self.trace(["[window] destroyed label=overlay", self.opened], count=1), "other")

    def test_swift_compatible_uppercase_index_matches_native_uuid_log(self):
        self.assertEqual(pin_open_log_marker(self.asset.upper()), self.opened)
        proof = pin_lifecycle_evidence(self.trace([
            "[window] destroyed label=overlay", self.opened], count=1), self.asset.upper())
        self.assertTrue(proof["pin_after_all_overlay_destroyed"])

    def test_native_rounding_is_allowed_but_noop_and_stretch_are_rejected(self):
        proportional_resize_evidence((580, 235), (638, 259))
        for after in ((580, 235), (640, 235), (640, 310), (0, 0)):
            with self.subTest(after=after), self.assertRaises(RuntimeError):
                proportional_resize_evidence((580, 235), after)

    def test_profile_isolation_refuses_non_ci_and_self_hosted_machines(self):
        for environment in ({}, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted"}):
            with self.subTest(environment=environment), patch.dict("os.environ", environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "disposable GitHub-hosted"):
                    with isolated_windows_profile():
                        self.fail("Unsafe profile redirection was accepted")

    def test_prior_app_data_restored_and_generated_data_removed_even_on_failure(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                existing, new, backup = root / "existing", root / "new", root / "backup"
                existing.mkdir(); backup.mkdir()
                (existing / "prior.txt").write_text("prior QA data")
                try:
                    with isolated_app_directories((existing, new), backup):
                        self.assertEqual(list(existing.iterdir()), [])
                        (existing / "capture.txt").write_text("generated capture")
                        (new / "capture.txt").write_text("generated capture")
                        if fail:
                            raise ValueError("desktop acceptance failed")
                except ValueError:
                    self.assertTrue(fail)
                self.assertEqual((existing / "prior.txt").read_text(), "prior QA data")
                self.assertFalse((existing / "capture.txt").exists())
                self.assertFalse(new.exists())
                self.assertEqual(list(backup.iterdir()), [])

    def test_linked_profile_is_rejected_before_touching_prior_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prior, linked, backup = root / "prior", root / "linked", root / "backup"
            prior.mkdir(); backup.mkdir()
            (prior / "prior.txt").write_text("prior QA data")
            try:
                linked.symlink_to(prior, target_is_directory=True)
            except OSError:
                self.skipTest("This runner cannot create directory symlinks")
            with self.assertRaisesRegex(RuntimeError, "unexpected Kiri profile"):
                with isolated_app_directories((prior, linked), backup):
                    self.fail("Linked profile was accepted")
            self.assertEqual((prior / "prior.txt").read_text(), "prior QA data")
            self.assertEqual(list(backup.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
