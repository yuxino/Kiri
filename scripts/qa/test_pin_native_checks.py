import unittest
from unittest.mock import patch

from pin_native_checks import pin_lifecycle_evidence, pin_open_log_marker, proportional_resize_evidence
from windows_qa_profile import isolated_windows_profile


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

    def test_profile_redirection_refuses_non_ci_and_self_hosted_machines(self):
        for environment in ({}, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "self-hosted"}):
            with self.subTest(environment=environment), patch.dict("os.environ", environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "disposable GitHub-hosted"):
                    with isolated_windows_profile():
                        self.fail("Unsafe profile redirection was accepted")


if __name__ == "__main__":
    unittest.main()
