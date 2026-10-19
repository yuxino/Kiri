"""Portable checks for the installed X11 driver's restoration readiness."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).with_name("linux-native.py")


def functions(*names, **namespace):
    tree = ast.parse(SOURCE.read_text(), filename=str(SOURCE))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(selected) != len(names):
        raise AssertionError("Native acceptance function is missing")
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


def observation(**changes):
    sample = {
        "active_window": "6291459",
        "bounds": {"x": 161, "y": 100, "width": 960, "height": 640},
        "map_state": "IsViewable", "wm_state": "Normal",
        "wm_properties": "_NET_WM_STATE(ATOM) = ",
        "settings_bounds": [173, 678, 348, 718], "screen": [1280, 800],
    }
    sample.update(changes)
    return sample


class LibraryRestorationTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.index = 0
        self.scenes = [observation()]
        self.report = {}
        self.clock = Mock(monotonic=lambda: self.now)
        self.clock.sleep.side_effect = lambda seconds: setattr(self, "now", self.now + seconds)
        self.images = Mock(grab=self.grab)
        self.namespace = functions(
            "wait_for", "library_restore_observation", "wait_for_restored_library", "wait_for_control",
            time=self.clock, process=None, pump_events=lambda: None,
            report=self.report, command=self.command, visible_control=self.control,
            ImageGrab=self.images, re=re, json=json,
        )

    @property
    def scene(self):
        return self.scenes[min(self.index, len(self.scenes) - 1)]

    def command(self, *arguments, check=True):
        if arguments == ("xwininfo", "-id", "6291459"):
            bounds = self.scene["bounds"]
            text = "No such window" if bounds is None else (
                f"  Absolute upper-left X: {bounds['x']}\n"
                f"  Absolute upper-left Y: {bounds['y']}\n"
                f"  Width: {bounds['width']}\n  Height: {bounds['height']}\n"
                f"  Map State: {self.scene['map_state']}\n"
            )
        elif arguments == ("xprop", "-id", "6291459", "WM_STATE", "_NET_WM_STATE"):
            text = f"WM_STATE(WM_STATE):\n  window state: {self.scene['wm_state']}\n" + self.scene["wm_properties"]
        elif arguments == ("xdotool", "getactivewindow"):
            text = self.scene["active_window"]
        else:
            self.fail(f"Unexpected native operation: {arguments}")
        return SimpleNamespace(stdout=text)

    def control(self, label):
        self.assertEqual(label, "Settings")
        bounds = self.scene["settings_bounds"]
        if bounds is None:
            return None
        left, top, right, bottom = bounds
        return object(), SimpleNamespace(x=left, y=top, width=right-left, height=bottom-top)

    def grab(self):
        screen = self.scene["screen"]
        self.index += 1
        return SimpleNamespace(size=screen)

    def wait(self, timeout=1):
        return self.namespace["wait_for_restored_library"]("6291459", observation(), timeout=timeout)

    def test_openbox_animation_and_transient_atspi_overflow_settle_before_acceptance(self):
        # The real failed run reported an off-screen AT-SPI control while the
        # manager animated a title strip, then restored the original client.
        self.scenes = [
            observation(wm_state="Iconic", map_state="IsUnMapped", active_window="4194324",
                        wm_properties="_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN"),
            observation(settings_bounds=[230, 810, 405, 850]),
            observation(bounds={"x": 217, "y": 232, "width": 862, "height": 20}),
            observation(), observation(), observation(),
        ]
        final = self.wait()
        evidence = self.report["library_restore"]
        self.assertTrue(evidence["restored"])
        self.assertEqual(final["bounds"], observation()["bounds"])
        self.assertEqual(final["settings_bounds"], [173, 678, 348, 718])
        self.assertEqual([sample["stable_samples"] for sample in evidence["samples"]], [0, 0, 0, 1, 2, 3])
        self.assertEqual(evidence["samples"][1]["settings_bounds"], [230, 810, 405, 850])

    def test_permanent_control_overflow_times_out_with_last_observed_bounds_and_state(self):
        self.scenes = [observation(settings_bounds=[230, 810, 405, 850])]
        with self.assertRaisesRegex(RuntimeError, r"Timed out:.*last library restoration state:.*230, 810, 405, 850"):
            self.wait(timeout=0.45)
        evidence = self.report["library_restore"]
        self.assertNotIn("restored", evidence)
        self.assertIn("Timed out", evidence["error"])
        self.assertGreaterEqual(len(evidence["samples"]), 4)
        self.assertTrue(all(sample["stable_samples"] == 0 for sample in evidence["samples"]))
        self.assertEqual(evidence["samples"][-1]["wm_state"], "Normal")
        self.assertEqual(evidence["samples"][-1]["bounds"], observation()["bounds"])

    def test_an_arbitrary_stationary_window_position_is_not_the_original_library(self):
        self.scenes = [observation(bounds={"x": 170, "y": 110, "width": 960, "height": 640},
                                   settings_bounds=[182, 688, 357, 728])]
        with self.assertRaisesRegex(RuntimeError, "Timed out"):
            self.wait(timeout=0.4)
        self.assertNotIn("restored", self.report["library_restore"])

    def test_stability_restarts_after_focus_loss(self):
        self.scenes = [observation(), observation(), observation(active_window="4194324"),
                       observation(), observation(), observation()]
        self.wait()
        self.assertEqual([sample["stable_samples"] for sample in self.report["library_restore"]["samples"]],
                         [1, 2, 0, 1, 2, 3])

    def test_geometry_alone_cannot_pass_without_normal_visible_focused_window(self):
        for change in ({"active_window": "4194324"}, {"wm_state": "Iconic"},
                       {"map_state": "IsUnMapped"},
                       {"wm_properties": "_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN"},
                       {"settings_bounds": [50, 50, 225, 90]}, {"settings_bounds": None},
                       {"bounds": None}):
            with self.subTest(change=change):
                self.index = 0
                self.scenes = [observation(**change)]
                with self.assertRaisesRegex(RuntimeError, "Timed out"):
                    self.wait(timeout=0.3)
                self.assertNotIn("restored", self.report["library_restore"])

    def test_missing_original_geometry_is_a_hard_failure_before_polling(self):
        with self.assertRaisesRegex(RuntimeError, "Missing original library geometry"):
            self.namespace["wait_for_restored_library"]("6291459", observation(bounds=None))
        self.assertEqual(self.report["library_restore"]["samples"], [])
        self.clock.sleep.assert_not_called()

    def test_process_exit_is_not_retried_as_a_transient_restore(self):
        self.namespace["process"] = Mock(poll=lambda: 7, returncode=7)
        with self.assertRaisesRegex(RuntimeError, "Kiri exited during.*7"):
            self.wait()
        self.assertEqual(self.report["library_restore"]["samples"], [])

    def test_ordinary_control_visibility_still_fails_immediately_on_overflow(self):
        self.scenes = [observation(settings_bounds=[230, 810, 405, 850])]
        desktop = Mock(width=1280, height=800, size=(1280, 800))
        desktop.convert.return_value = desktop
        self.images.grab = Mock(return_value=desktop)
        with self.assertRaisesRegex(RuntimeError, "extends beyond the screen"):
            self.namespace["wait_for_control"]("Settings")
        self.clock.sleep.assert_not_called()
        desktop.crop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
