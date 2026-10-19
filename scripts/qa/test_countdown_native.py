"""Portable regression for the actual Windows recording acceptance guards."""
import ast
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).with_name("countdown-native.py")


def functions(*names, **namespace):
    tree = ast.parse(SOURCE.read_text(), filename=str(SOURCE))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(selected) != len(names):
        raise AssertionError("Native acceptance function is missing")
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class ActiveShortcutTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = "recording"
        self.foreground = 42
        self.keys = []
        self.buttons = []
        self.drop_shortcut = False
        self.steal_focus = False
        self.report = {}
        source = Mock(handle=42)
        source.set_focus.side_effect = lambda: setattr(self, "foreground", 42)
        clock = Mock(monotonic=lambda: self.now)
        clock.sleep.side_effect = lambda seconds: setattr(self, "now", self.now + seconds)
        native = Mock(GetForegroundWindow=lambda: self.foreground, GetAncestor=lambda handle, _: handle)
        keyboard = Mock()
        keyboard.send_keys.side_effect = self.send
        self.namespace = functions("assert_source_foreground", "recording_shortcut", "exercise_recording_controls",
                                   source_window=source, user32=native, time=clock, keyboard=keyboard,
                                   report=self.report, find=self.find, assert_closed=self.closed)

    def find(self, name):
        expected = "recording" if name == "Pause Recording" else "paused"
        if self.state != expected:
            raise RuntimeError(f"Expected {name}, actual state {self.state}")
        control = Mock()
        def click():
            self.buttons.append(name)
            self.state = "paused" if name == "Pause Recording" else "recording"
        control.click_input.side_effect = click
        return control

    def send(self, keys):
        self.keys.append(keys)
        if not self.drop_shortcut:
            if keys == "^%+p":
                self.state = "paused" if self.state == "recording" else "recording"
            elif keys == "^%+s":
                self.state = "stopped"
            else:
                self.fail(f"Unexpected shortcut {keys}")
        if self.steal_focus:
            self.foreground = 99

    def closed(self, handles):
        self.assertEqual(handles, [101, 102])
        if self.state != "stopped":
            raise RuntimeError("Recording windows survived stopping")

    def test_real_driver_keeps_buttons_then_checks_active_pause_resume_and_stop(self):
        pauses, stopped = self.namespace["exercise_recording_controls"]([101, 102])
        self.assertEqual(self.buttons, ["Pause Recording", "Resume Recording"])
        self.assertEqual(self.keys, ["^%+p", "^%+p", "^%+s"])
        self.assertEqual([pause["source"] for pause in pauses], ["buttons", "global shortcut"])
        self.assertEqual(stopped, 117)
        self.assertEqual([item["state"] for item in self.report["active_recording_shortcuts"]],
                         ["paused", "recording", "stopped"])
        self.assertTrue(all(item["foreground_before"] == item["foreground_after"] == 42
                            for item in self.report["active_recording_shortcuts"]))

    def test_missing_native_dispatch_cannot_pass_by_sending_keys_alone(self):
        self.drop_shortcut = True
        with self.assertRaisesRegex(RuntimeError, "Expected Resume Recording"):
            self.namespace["exercise_recording_controls"]([101, 102])
        self.assertNotIn("active_recording_shortcuts", self.report)

    def test_shortcut_must_start_in_the_source_application(self):
        self.foreground = 99
        with self.assertRaisesRegex(RuntimeError, "Before paused.*foreground"):
            self.namespace["recording_shortcut"]("^%+p", "paused", lambda: self.find("Resume Recording"))
        self.assertEqual(self.keys, [])

    def test_successful_state_transition_does_not_hide_focus_theft(self):
        self.steal_focus = True
        with self.assertRaisesRegex(RuntimeError, "After paused.*foreground"):
            self.namespace["exercise_recording_controls"]([101, 102])
        self.assertEqual(self.state, "paused")
        self.assertNotIn("active_recording_shortcuts", self.report)

    def test_stop_requires_both_recording_windows_to_close(self):
        self.drop_shortcut = True
        with self.assertRaisesRegex(RuntimeError, "windows survived"):
            self.namespace["recording_shortcut"]("^%+s", "stopped", lambda: self.closed([101, 102]))


class ActiveDurationTests(unittest.TestCase):
    def setUp(self):
        self.check = functions("active_recording_bounds")["active_recording_bounds"]
        self.pauses = [dict(pause_requested=3, pause_confirmed=3.1, resume_requested=8.1, resume_confirmed=8.2),
                       dict(pause_requested=11.2, pause_confirmed=11.3, resume_requested=16.3, resume_confirmed=16.4)]

    def test_observed_active_duration_passes_and_retains_pause_uncertainty(self):
        evidence = self.check(8.0, 0, 17.4, self.pauses)
        self.assertAlmostEqual(evidence["minimum_paused_seconds"], 10)
        self.assertAlmostEqual(evidence["maximum_paused_seconds"], 10.4)
        self.assertLess(evidence["media_duration_bounds"][1], 17.4)

    def test_export_that_includes_paused_wall_time_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "outside active elapsed bounds"):
            self.check(17.4, 0, 17.4, self.pauses)

    def test_including_either_single_pause_is_rejected(self):
        lower = self.check(8.0, 0, 17.4, self.pauses)["media_duration_bounds"][0]
        for pause in self.pauses:
            with self.subTest(pause=pause):
                shortest_pause = pause["resume_requested"] - pause["pause_confirmed"]
                with self.assertRaisesRegex(RuntimeError, "outside active elapsed bounds"):
                    self.check(lower + shortest_pause, 0, 17.4, self.pauses)

    def test_slow_state_acknowledgements_cannot_hide_one_pause(self):
        pauses = [dict(pause_requested=3, pause_confirmed=5, resume_requested=10, resume_confirmed=12),
                  dict(pause_requested=15, pause_confirmed=15, resume_requested=20, resume_confirmed=20)]
        with self.assertRaisesRegex(RuntimeError, "too short to prove each pause"):
            self.check(15, 0, 21, pauses)

    def test_dropped_active_time_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "outside active elapsed bounds"):
            self.check(5, 0, 17.4, self.pauses)

    def test_short_pause_cannot_be_absorbed_by_startup_allowance(self):
        pauses = [dict(pause_requested=3, pause_confirmed=3, resume_requested=4, resume_confirmed=4),
                  dict(pause_requested=7, pause_confirmed=7, resume_requested=8, resume_confirmed=8)]
        with self.assertRaisesRegex(RuntimeError, "too short to prove each pause"):
            self.check(7, 0, 9, pauses)

    def test_missing_or_out_of_order_transition_evidence_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "both button and global-shortcut"):
            self.check(8, 0, 17.4, self.pauses[:1])
        self.pauses[1]["resume_confirmed"] = 18
        with self.assertRaisesRegex(RuntimeError, "out of order"):
            self.check(8, 0, 17.4, self.pauses)


class SavedVideoTests(unittest.TestCase):
    def test_each_completion_requires_exactly_one_new_readable_video(self):
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory)
            (library / "Assets").mkdir()
            (library / "Assets/one.mp4").write_bytes(b"fixture media")
            item = Mock()
            item.ExtendedProperty.return_value = 80_000_000
            shell = Mock()
            shell.NameSpace.return_value.ParseName.return_value = item
            com = Mock()
            com.client.Dispatch.return_value = shell
            read = functions("saved_video", json=json, win32com=com)["saved_video"]
            existing = {"id": "old", "kind": "video", "filename": "old.mp4"}
            new = {"id": "one", "kind": "video", "filename": "one.mp4"}
            (library / "library.json").write_text(json.dumps([existing, new]))
            asset, _, duration, _ = read(library, {"old"})
            self.assertEqual((asset["id"], duration), ("one", 8))
            for items in ([existing], [existing, new, {**new, "id": "two"}]):
                (library / "library.json").write_text(json.dumps(items))
                with self.assertRaisesRegex(RuntimeError, "exactly one new video"):
                    read(library, {"old"})


if __name__ == "__main__":
    unittest.main()
