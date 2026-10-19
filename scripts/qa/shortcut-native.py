"""Exercise native shortcut settings and idle recording scope on isolated Windows CI."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from pywinauto import Desktop, keyboard
from PIL import ImageGrab
from windows_qa_profile import isolated_windows_profile

if os.environ.get("GITHUB_ACTIONS") != "true" or os.name != "nt":
    raise SystemExit("Use an isolated Windows CI desktop")

output = Path("shortcut-native-review")
output.mkdir(exist_ok=True)
report = {"success": False, "native": True, "checks": []}
desktop = Desktop(backend="uia")
installed_exe = os.environ.get("KIRI_QA_INSTALLED_EXE")
executable = Path(installed_exe or "src-tauri/target/release/kiri.exe").resolve()
report["candidate"] = {"path": str(executable), "source": "installed" if installed_exe else "compiled fallback"}
process = None
hotkey_id, probe_id = 2122, 2123
held = False
deadline = time.monotonic() + 150  # Leave cleanup time within the three-minute CI gate.
recording_hint = "Press a key or combination. Esc cancels."
capture_default, capture_custom = "Shift+Ctrl+A", "Ctrl+Alt+K"
defaults = {"Record": "Shift+Ctrl+Alt+R", "Recognize Text": "Shift+Ctrl+Alt+O",
            "Show main window": "Shift+Ctrl+Alt+L"}
recording_defaults = {"Pause/Resume Recording": "Shift+Ctrl+Alt+P",
                      "Stop and Save Recording": "Shift+Ctrl+Alt+S"}
mode_hints = {
    "Screenshot": "Drag to choose a capture area   ·   Click a window   ·   Esc to cancel",
    "Record": "Drag to choose a recording area   ·   Click a window   ·   Esc to cancel",
    "OCR": "Drag to choose text to recognize   ·   Esc to cancel",
}


def visible_controls():
    if process is None or process.poll() is not None:
        raise RuntimeError("Kiri exited: " + str(process.returncode if process else "not started"))
    for window in desktop.windows(process=process.pid, visible_only=True):
        for control in window.descendants():
            try:
                if control.is_visible():
                    yield control
            except Exception:
                pass


def find(name, timeout=12, control_type=None):
    end = min(time.monotonic() + timeout, deadline)
    while time.monotonic() < end:
        for control in visible_controls():
            try:
                if ((control_type is None or control.element_info.control_type == control_type)
                        and re.fullmatch(name, control.window_text()) and control.is_enabled()):
                    return control
            except Exception:
                pass
        time.sleep(.1)
    raise RuntimeError("Visible enabled control not found: " + name)


def wait_absent(name, timeout=5):
    end = min(time.monotonic() + timeout, deadline)
    while time.monotonic() < end:
        if not any(re.fullmatch(name, control.window_text()) for control in visible_controls()):
            return
        time.sleep(.1)
    raise RuntimeError("Control did not disappear: " + name)


def recorder(action, label):
    # Keycaps are aria-hidden; the accessible name identifies action AND binding.
    return find(re.escape(f"Edit shortcut for {action}: {label}"))


def begin_recording(action, label):
    recorder(action, label).click_input()
    find(re.escape(recording_hint))


def idle(action, label):
    wait_absent(re.escape(recording_hint))
    return recorder(action, label)


def shortcut_action(action, command):
    # Clear and Restore sit beside the key field. Their accessible names remain
    # action-specific even though the visible controls are compact icons.
    find(re.escape(f"{command} shortcut for {action}"), control_type="Button").click_input()


def reset(action):
    shortcut_action(action, "Restore default")


def assert_recording_keys_released_while_idle():
    for action, label in recording_defaults.items():
        recorder(action, label)
        key = label[-1]
        if not ctypes.windll.user32.RegisterHotKey(None, probe_id, 0x0002 | 0x0004 | 0x0001, ord(key)):
            raise RuntimeError(f"Idle recording shortcut {key} is still registered")
        try:
            report["checks"].append(f"idle {action} default is configurable and its native key remains available to other apps")
        finally:
            ctypes.windll.user32.UnregisterHotKey(None, probe_id)


def assert_no_capture():
    names = {" ".join(control.window_text().split()) for control in visible_controls()}
    if any(" ".join(hint.split()) in names for hint in mode_hints.values()):
        raise RuntimeError("Shortcut recording unexpectedly opened capture")


def mode_pattern(mode):
    # WebView2 may collapse the display copy's alignment whitespace in UIA.
    return r"\s+".join(re.escape(word) for word in mode_hints[mode].split())


def open_mode(keys, mode, expected_capture=capture_custom):
    keyboard.send_keys(keys)
    # Every overlay has all three buttons. The selected mode's hint proves which
    # mode opened without creating a capture, starting recording, or running OCR.
    find(mode_pattern(mode))
    for button in mode_hints:
        find(re.escape(button), control_type="Button")
    ImageGrab.grab().save(output / f"entry-{mode.lower()}.png")
    keyboard.send_keys("{ESC}")
    wait_absent(mode_pattern(mode))
    recorder("Screenshot", expected_capture)


def start(environment, expected_capture):
    global process
    process = subprocess.Popen([str(executable)], env=environment)
    settings = find("Settings", timeout=30, control_type="Button")
    settings.top_level_parent().set_focus()
    settings.click_input()
    find("Shortcuts", control_type="TabItem").click_input()
    recorder("Screenshot", expected_capture)


def stop():
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=15)
        process.wait(timeout=10)


def failure_evidence():
    if process and process.poll() is None:
        ImageGrab.grab().save(output / "failure-desktop.png")
        report["windows"] = [[
            {"text": control.window_text(), "name": control.element_info.name,
             "type": control.element_info.control_type}
            for control in window.descendants()
        ] for window in desktop.windows(process=process.pid, visible_only=True)]


try:
    report["candidate"]["sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    # This helper also requires a GitHub-hosted runner. It backs up only Kiri's
    # directories and restores prior QA data after this run's processes stop.
    with isolated_windows_profile() as environment:
        report["isolated_profile"] = True
        config = Path(environment["APPDATA"]) / "io.yuxino.kiri"
        (config / "language.json").write_text(json.dumps("en"), encoding="utf-8")
        try:
            held = bool(ctypes.windll.user32.RegisterHotKey(None, hotkey_id, 0x0002 | 0x0004, ord("A")))
            if not held:
                raise RuntimeError("Could not reserve the test hotkey")
            start(environment, capture_default)
            find(re.escape("This shortcut is in use by another app."))
            for action, label in defaults.items():
                recorder(action, label)
            assert_recording_keys_released_while_idle()
            ImageGrab.grab().save(output / "six-action-settings.png")
            open_mode("^%+r", "Record", capture_default)
            report["checks"].append("an occupied Capture default does not prevent other actions registering at startup")

            begin_recording("Screenshot", capture_default)
            keyboard.send_keys("^%k")
            idle("Screenshot", capture_custom)
            report["checks"].append("occupied startup capture can change while all six action rows remain available")

            reset("Screenshot")
            find(re.escape("This shortcut is unavailable. Choose another combination."))
            recorder("Screenshot", capture_custom)
            report["checks"].append("failed native replacement preserves the working combination")

            # Registered keys may bypass the WebView. Another action's native
            # callback must reach the recorder as a rejected candidate.
            begin_recording("Screenshot", capture_custom)
            keyboard.send_keys("^%+r")
            find(re.escape("This shortcut is already assigned to another action."))
            idle("Screenshot", capture_custom)
            recorder("Record", defaults["Record"])
            assert_no_capture()
            report["checks"].append("recording another action's key reports a duplicate without dispatching or changing either binding")

            shortcut_action("Recognize Text", "Clear")
            recorder("Recognize Text", "Not set")
            # Verify actual native ownership independently of the status text.
            if not ctypes.windll.user32.RegisterHotKey(None, probe_id, 0x0002 | 0x0004 | 0x0001, ord("O")):
                raise RuntimeError("Disabled OCR key is still registered")
            ctypes.windll.user32.UnregisterHotKey(None, probe_id)
            keyboard.send_keys("^%+o")
            time.sleep(.25)
            assert_no_capture()
            report["checks"].append("disabling OCR releases its native key and prevents dispatch")

            stop()
            start(environment, capture_custom)
            recorder("Recognize Text", "Not set")
            recorder("Record", defaults["Record"])
            recorder("Show main window", defaults["Show main window"])
            report["checks"].append("custom and disabled bindings survive process restart independently")

            begin_recording("Screenshot", capture_custom)
            keyboard.send_keys("^%k")
            idle("Screenshot", capture_custom)
            assert_no_capture()
            report["checks"].append("recording the existing key confirms it without capture")

            begin_recording("Screenshot", capture_custom)
            keyboard.send_keys("{TAB}")
            idle("Screenshot", capture_custom)
            open_mode("^%k", "Screenshot")
            report["checks"].append("Tab cancels shortcut recording and the custom key opens Screenshot mode")

            # Virtual-key names avoid VK_PACKET text injection: these must reach
            # the WebView/native hotkey layer as actual F8 and Space keys.
            begin_recording("Screenshot", capture_custom)
            keyboard.send_keys("{F8}")
            idle("Screenshot", "F8")
            wait_absent(re.escape("Use this key"))
            open_mode("{F8}", "Screenshot", "F8")
            report["checks"].append("bare F8 saves without confirmation and dispatches through the native hotkey")

            saved_before_candidate = (config / "shortcuts.json").read_bytes()
            begin_recording("Screenshot", "F8")
            keyboard.send_keys("{SPACE}")
            recorder("Screenshot", "Space")
            find("Use this key", control_type="Button")
            find(re.escape("This key will also trigger while typing or navigating in other apps."))
            assert_no_capture()
            if (config / "shortcuts.json").read_bytes() != saved_before_candidate:
                raise RuntimeError("Unconfirmed Space candidate changed persisted shortcuts")
            if not ctypes.windll.user32.RegisterHotKey(None, probe_id, 0, 0x20):
                raise RuntimeError("Unconfirmed Space candidate already owns the native key")
            try:
                ImageGrab.grab().save(output / "single-key-confirmation.png")
            finally:
                ctypes.windll.user32.UnregisterHotKey(None, probe_id)
            keyboard.send_keys("{ESC}")
            idle("Screenshot", "F8")
            if (config / "shortcuts.json").read_bytes() != saved_before_candidate:
                raise RuntimeError("Cancelling Space candidate changed persisted shortcuts")
            report["checks"].append("bare Space waits for confirmation; Escape preserves the old binding and leaves Space unregistered")

            begin_recording("Screenshot", "F8")
            keyboard.send_keys("{SPACE}")
            find("Use this key", control_type="Button").click_input()
            idle("Screenshot", "Space")
            if json.loads((config / "shortcuts.json").read_text(encoding="utf-8"))["bindings"]["capture"] != "Space":
                raise RuntimeError("Confirmed Space binding was not persisted")
            open_mode("{SPACE}", "Screenshot", "Space")
            report["checks"].append("explicitly confirmed Space persists and dispatches through the native hotkey")
            begin_recording("Screenshot", "Space")
            keyboard.send_keys("^%k")
            idle("Screenshot", capture_custom)

            open_mode("^%+r", "Record")
            report["checks"].append("Record default selects Record without starting a recording")
            reset("Recognize Text")
            recorder("Recognize Text", defaults["Recognize Text"])
            open_mode("^%+o", "OCR")
            report["checks"].append("reset re-enables OCR and its default selects OCR")

            # Changing tabs unmounts the recorder. Native dispatch must resume.
            begin_recording("Screenshot", capture_custom)
            find("General", control_type="TabItem").click_input()
            keyboard.send_keys("^%+r")
            find(mode_pattern("Record"))
            keyboard.send_keys("{ESC}")
            find("Shortcuts", control_type="TabItem").click_input()
            recorder("Screenshot", capture_custom)
            report["checks"].append("leaving the Shortcuts tab ends native recorder interception")

            library = recorder("Show main window", defaults["Show main window"]).top_level_parent()
            library.set_focus()
            keyboard.send_keys("%{F4}")
            wait_absent(re.escape(f"Edit shortcut for Show main window: {defaults['Show main window']}"))
            keyboard.send_keys("^%+l")
            find("Settings", control_type="Button")
            recorder("Show main window", defaults["Show main window"])
            report["checks"].append("Show main window default reveals the hidden resident window")

            ctypes.windll.user32.UnregisterHotKey(None, hotkey_id)
            held = False
            reset("Screenshot")
            recorder("Screenshot", capture_default)
            keyboard.send_keys("^+a")
            find(mode_pattern("Screenshot"))
            keyboard.send_keys("{ESC}")
            recorder("Screenshot", capture_default)
            report["checks"].append("restored Capture default triggers after the external conflict is released")
        except Exception:
            failure_evidence()
            raise
        finally:
            if held:
                ctypes.windll.user32.UnregisterHotKey(None, hotkey_id)
                held = False
            ctypes.windll.user32.UnregisterHotKey(None, probe_id)
            stop()
    report["success"] = True
except Exception as error:
    report["error"] = str(error)
finally:
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
if not report["success"]:
    raise SystemExit(report.get("error", "Native shortcut acceptance failed"))
