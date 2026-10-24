"""Portable checks that the native scroll gate cannot accept false success."""
import ast
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

try:
    from PIL import Image, ImageChops, ImageDraw, ImageStat
except ImportError:
    Image = None

SOURCE = Path(__file__).with_name("windows-scroll-capture-native.py")


def functions(*names, source_file=SOURCE, **namespace):
    tree = ast.parse(source_file.read_text(), filename=str(source_file))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(selected) != len(names):
        raise AssertionError("Native acceptance function is missing")
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source_file), "exec"), namespace)
    return namespace


class NativeScrollGuards(unittest.TestCase):
    def setUp(self):
        self.check = functions("require_geometry")["require_geometry"]
        self.screen = [0, 0, 1280, 720]
        self.region = {"hwnd": 12, "rect": self.screen, "extended_style": 0x80020, "visible": True}
        self.panel = {"hwnd": 13, "rect": [500, 200, 720, 480], "extended_style": 0, "visible": True}
        self.windows = [self.region, self.panel]
        self.affinities = {12: 0x11, 13: 0x11}

    def validate(self, fallback=False):
        return self.check(self.windows, 13, self.screen, self.affinities, fallback)

    def test_visible_guide_requires_both_affinities_and_passthrough_styles(self):
        self.assertEqual(self.validate(), self.region)
        for hwnd in self.affinities:
            for value in (None, 0, 1):
                with self.subTest(hwnd=hwnd, affinity=value):
                    self.affinities[hwnd] = value
                    with self.assertRaisesRegex(RuntimeError, "capture exclusion"):
                        self.validate(True)
            self.affinities[hwnd] = 0x11
        for style in (0, 0x20, 0x80000):
            self.region["extended_style"] = style
            with self.assertRaisesRegex(RuntimeError, "pointer passthrough"):
                self.validate()

    def test_hidden_region_is_allowed_only_with_explicit_current_session_fallback(self):
        self.region.update(visible=False, extended_style=0)
        self.affinities.pop(12)
        with self.assertRaisesRegex(RuntimeError, "explicit safe fallback log"):
            self.validate()
        self.assertEqual(self.validate(True), self.region)
        self.affinities[13] = 0
        with self.assertRaisesRegex(RuntimeError, "controls lost capture exclusion"):
            self.validate(True)

    def test_missing_or_duplicate_region_is_never_a_hidden_fallback(self):
        self.windows = [self.panel]
        with self.assertRaisesRegex(RuntimeError, "uniquely cover"):
            self.validate(True)
        self.windows.extend([self.region, {**self.region, "hwnd": 14}])
        with self.assertRaisesRegex(RuntimeError, "uniquely cover"):
            self.validate(True)

    def test_input_must_hit_the_expected_root_and_separate_source_pid(self):
        hit = functions("require_hit")["require_hit"]
        hit(42, 100, 42, 100)
        for root, pid in ((42, 101), (43, 100), (13, 200)):
            with self.assertRaisesRegex(RuntimeError, "intercepted input"):
                hit(root, pid, 42, 100)

    def test_cleanup_waits_for_both_hwnds_and_source_focus(self):
        predicates = []
        native = Mock(IsWindow=lambda hwnd: hwnd == 12, GetForegroundWindow=lambda: 42)
        functions("assert_closed", wait_for=lambda _name, test: predicates.append(test),
                  user32=native, source=Mock(handle=42), report={},
                  foreground_evidence=lambda: {})["assert_closed"]([12, 13])
        self.assertFalse(predicates[0]())
        native.IsWindow = lambda _: False
        self.assertTrue(predicates[0]())
        self.assertTrue(predicates[1]())
        native.GetForegroundWindow = lambda: 99
        self.assertFalse(predicates[1]())

    def test_focus_diagnostic_identifies_source_and_actual_foreground_without_content(self):
        native = Mock(GetForegroundWindow=lambda: 99, GetAncestor=lambda _hwnd, _kind: 98)
        proof = functions("foreground_evidence", user32=native, source=Mock(handle=42),
            fixture=Mock(pid=100), owner=lambda hwnd: {99: 200, 98: 201}[hwnd])["foreground_evidence"]()
        self.assertEqual(proof, {"expected": {"hwnd": 42, "pid": 100},
            "actual": {"hwnd": 99, "pid": 200, "root_hwnd": 98, "root_pid": 201}})

    def test_focus_timeout_remains_a_failure_and_retains_diagnostic(self):
        report = {}
        def wait_for(description, predicate):
            if not predicate():
                raise RuntimeError("Timed out waiting for " + description)
        check = functions("assert_closed", wait_for=wait_for, report=report,
            user32=Mock(IsWindow=lambda _hwnd: False, GetForegroundWindow=lambda: 99),
            source=Mock(handle=42), foreground_evidence=lambda: {"actual": {"hwnd": 99}})["assert_closed"]
        with self.assertRaisesRegex(RuntimeError, "source foreground"):
            check([12, 13])
        self.assertEqual(report["focus_after_scrolling"], [{"actual": {"hwnd": 99}}])

    def test_fallback_log_requires_current_session_and_exact_region_stage(self):
        evidence = functions("fallback_evidence")["fallback_evidence"]
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "kiri.log"
            self.assertIsNone(evidence(log, 0))
            marker = "[scroll] region guide hidden fallback: failed [stage=exclude-region-window]: native error 8\n"
            log.write_text(marker)
            boundary = log.stat().st_size
            self.assertEqual(evidence(log, 0), marker.strip())
            self.assertIsNone(evidence(log, boundary))
            log.write_text(marker + marker.replace("exclude-region-window", "exclude-control-window"))
            self.assertIsNone(evidence(log, boundary))
            log.write_text(marker + marker)
            self.assertEqual(evidence(log, boundary), marker.strip())

    @unittest.skipIf(os.name == "nt", "This refusal test intentionally uses a non-Windows host")
    def test_desktop_entrypoints_refuse_before_imports_or_side_effects(self):
        for name in (SOURCE.name, "windows-scroll-capture-fixture.py"):
            with self.subTest(script=name), tempfile.TemporaryDirectory() as temporary:
                result = subprocess.run([sys.executable, str(SOURCE.with_name(name))], cwd=temporary,
                    env={**os.environ, "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted"},
                    capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Use a disposable GitHub-hosted Windows desktop", result.stderr)
                self.assertEqual(list(Path(temporary).iterdir()), [])


class DirectPinGuards(unittest.TestCase):
    def setUp(self):
        self.closed = [{"hwnd": 12, "exists": False}, {"hwnd": 13, "exists": False}]
        self.pin = {"hwnd": 21, "visible": True, "pid": 200, "extended_style": 0x8}
        self.check = functions("require_pin_cleanup")["require_pin_cleanup"]

    def test_only_this_source_or_the_single_topmost_reference_may_keep_focus(self):
        for foreground in (42, 21):
            proof = self.check(self.closed, [self.pin], foreground, 42, 200)
            self.assertTrue(proof["only_source_or_reference_foreground"])
            self.assertEqual(proof["foreground_hwnd"], foreground)
        with self.assertRaisesRegex(RuntimeError, "unrelated window"):
            self.check(self.closed, [self.pin], 99, 42, 200)

    def test_live_or_missing_scroll_windows_and_wrong_reference_identity_fail(self):
        for windows in ([], self.closed[:1], [self.closed[0], self.closed[0]],
                        [{"hwnd": 12, "exists": True}, self.closed[1]]):
            with self.subTest(windows=windows), self.assertRaisesRegex(RuntimeError, "scrolling|scrolling HWND"):
                self.check(windows, [self.pin], 21, 42, 200)
        for pins in ([], [self.pin, {**self.pin, "hwnd": 22}], [{**self.pin, "visible": False}],
                     [{**self.pin, "pid": 201}], [{**self.pin, "extended_style": 0}]):
            with self.subTest(pins=pins), self.assertRaisesRegex(RuntimeError, "reference"):
                self.check(self.closed, pins, 21, 42, 200)

    def test_direct_pin_needs_one_new_image_without_mutating_existing_assets(self):
        check = functions("require_one_pinned_asset", Path=Path)["require_one_pinned_asset"]
        old = {"id": "old", "kind": "image", "filename": "old.png"}
        image = {"id": "new", "kind": "image", "filename": "new.png"}
        self.assertEqual(check([old, image], {"old"}), image)
        for items in ([old], [old, image, {**image, "id": "another"}],
                      [old, {**image, "kind": "video"}], [old, {**image, "filename": "../escape.png"}], [image]):
            with self.subTest(items=items), self.assertRaisesRegex(RuntimeError, "screenshot|isolated library"):
                check(items, {"old"})

    def test_pin_evidence_requires_both_native_destructions_before_the_matching_open(self):
        check = functions("require_pin_lifecycle", re=re)["require_pin_lifecycle"]
        region = "[window] destroyed label=scroll-capture-region\n"
        panel = "[window] destroyed label=scroll-capture\n"
        opened = "[pin] screenshot opened asset_id=744c9acd-645c-4211-8901-093193625282\n"
        asset = "744C9ACD-645C-4211-8901-093193625282"
        self.assertEqual(check(region + panel + opened, asset), {
            "opened_once": True, "pin_after_scroll_windows_destroyed": True})
        for log in (panel + opened, region + region + opened, region + panel + opened + opened,
                    region + opened + panel, opened + region + panel, region + panel):
            with self.subTest(log=log), self.assertRaisesRegex(RuntimeError, "Direct scrolling pin"):
                check(log, asset)


class FixturePublication(unittest.TestCase):
    def test_sharing_violation_retries_then_atomically_publishes(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            error = OSError("state is being read")
            error.winerror = 32
            replace = Mock(side_effect=[error, error, None])
            clock = Mock()
            publish = functions("publish", source_file=SOURCE.with_name("windows-scroll-capture-fixture.py"),
                workspace=workspace, state={"offset": 96}, json=json, os=Mock(replace=replace), time=clock)["publish"]
            publish()
            self.assertEqual(replace.call_count, 3)
            self.assertEqual(clock.sleep.call_count, 2)
            self.assertEqual(json.loads((workspace / "state.next").read_text()), {"offset": 96})

    def test_retry_is_bounded_and_other_io_failures_are_immediate(self):
        with tempfile.TemporaryDirectory() as temporary:
            for code, calls in ((32, 20), (5, 20), (33, 20), (112, 1)):
                with self.subTest(winerror=code):
                    error = OSError("failure")
                    error.winerror = code
                    replace = Mock(side_effect=error)
                    publish = functions("publish", source_file=SOURCE.with_name("windows-scroll-capture-fixture.py"),
                        workspace=Path(temporary), state={}, json=json, os=Mock(replace=replace), time=Mock())["publish"]
                    with self.assertRaises(OSError) as raised:
                        publish()
                    self.assertIs(raised.exception, error)
                    self.assertEqual(replace.call_count, calls)


@unittest.skipIf(Image is None, "Pixel checks require Pillow, as installed in native QA")
class PixelGuards(unittest.TestCase):
    def setUp(self):
        self.check = functions("require_pixels", ImageChops=ImageChops, ImageStat=ImageStat)["require_pixels"]
        self.reference = Image.new("RGB", (300, 500), "#b7c9d8")
        draw = ImageDraw.Draw(self.reference)
        for row in range(0, 500, 16):
            draw.line((0, row, 299, row), fill=(row % 255, 40, 180), width=3)

    def test_exact_saved_pixels_pass(self):
        self.assertEqual(self.check(self.reference.copy(), self.reference)["max_channel_mean_error"], 0)

    def test_black_panel_dimming_and_wrong_dimensions_fail(self):
        for kind in ("panel", "dim", "duplicate row", "short"):
            with self.subTest(kind=kind):
                actual = self.reference.copy()
                if kind == "panel":
                    ImageDraw.Draw(actual).rectangle((30, 40, 220, 260), fill="black")
                elif kind == "dim":
                    actual = actual.point(lambda value: round(value * 0.8))
                elif kind == "duplicate row":
                    actual.paste(actual.crop((0, 0, 300, 250)), (0, 250))
                else:
                    actual = actual.crop((0, 0, 300, 450))
                with self.assertRaisesRegex(RuntimeError, "Saved scrolling"):
                    self.check(actual, self.reference)

    def test_direct_pin_clipboard_keeps_the_exact_full_resolution_saved_image(self):
        check = functions("require_clipboard_image", Image=Image, ImageChops=ImageChops,
                          hashlib=hashlib)["require_clipboard_image"]
        proof = check(self.reference, self.reference.copy())
        self.assertEqual(proof["dimensions"], [300, 500])
        self.assertTrue(proof["saved_clipboard_pixels_identical"])
        self.assertEqual(proof["rgb_sha256"], hashlib.sha256(self.reference.tobytes()).hexdigest())
        changed = self.reference.copy()
        changed.putpixel((150, 250), (0, 0, 0))
        for copied in (None, ["image.png"], self.reference.resize((150, 250)), changed):
            with self.subTest(copied=type(copied)), self.assertRaisesRegex(RuntimeError, "clipboard|full-resolution"):
                check(self.reference, copied)


if __name__ == "__main__":
    unittest.main()
