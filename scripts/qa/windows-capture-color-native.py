"""Installed Windows color picker acceptance using real desktop/UIA/clipboard.

Only run on a disposable CI desktop. A separate Tk process paints public
pixels; no test image, IPC mock or synthetic capture enters the application.
"""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")
user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
user32.GetForegroundWindow.restype = wintypes.HWND
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindowVisible.argtypes = [wintypes.HWND]

from PIL import ImageGrab
from pywinauto import Desktop, keyboard, mouse
import win32clipboard
from win32con import CF_UNICODETEXT
from windows_crash_report import configure_crash_capture, collect_crash_details

output = Path("windows-capture-color-review")
output.mkdir(exist_ok=True)
configure_crash_capture(output)
executable = Path(os.environ["KIRI_COLOR_QA_EXE"]).resolve()
report = {"success": False, "native": True, "checks": [],
          "source_sha": os.environ.get("GITHUB_SHA"),
          "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest()}
app = fixture = source = None
capture_handle = None
desktop = Desktop(backend="uia")
DONE = "Done — Copy to clipboard · Return"
POINTS = {"near-black": ((110, 250), "#000302"),
          "pink": ((530, 250), "#FA80FF"),
          "single-pixel": ((200, 240), "#102030")}


def wait_for(description, predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app and app.poll() is not None:
            raise RuntimeError(f"Kiri exited while waiting for {description}: {app.returncode}")
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}")


def controls():
    found = []
    windows = [desktop.window(handle=capture_handle).wrapper_object()] if overlay_open() else \
        desktop.windows(process=app.pid, visible_only=True)
    for window in windows:
        for control in window.descendants():
            try:
                if control.is_visible():
                    found.append(control)
            except Exception:
                pass
    return found


def find(name, kind="Button", timeout=20):
    return wait_for(name, lambda: next((control for control in controls()
        if control.window_text() == name and control.element_info.control_type == kind
        and control.is_enabled()), None), timeout)


def names():
    return [control.window_text() for control in controls()]


def overlay_open():
    return bool(capture_handle and user32.IsWindow(capture_handle)
                and user32.IsWindowVisible(capture_handle))


def clipboard_text():
    try:
        win32clipboard.OpenClipboard()
    except Exception:
        return None
    try:
        if win32clipboard.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return win32clipboard.GetClipboardData(CF_UNICODETEXT)
        return None
    finally:
        win32clipboard.CloseClipboard()


def seed_clipboard(text):
    def write():
        try:
            win32clipboard.OpenClipboard()
        except Exception:
            return False
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(text, CF_UNICODETEXT)
            return True
        finally:
            win32clipboard.CloseClipboard()
    wait_for("clipboard seed", write)


def snapshot(label):
    ImageGrab.grab().save(output / f"{label}.png")
    report.setdefault("evidence", []).append({"label": label, "controls": [
        {"name": c.window_text(), "type": c.element_info.control_type,
         "bounds": [c.rectangle().left, c.rectangle().top,
                    c.rectangle().right, c.rectangle().bottom]} for c in controls()]})


def begin():
    global capture_handle
    source.set_focus()
    wait_for("public source focus", lambda: user32.GetForegroundWindow() == source.handle)
    keyboard.send_keys("^+a")
    capture_handle = find("Screenshot").top_level_parent().handle
    wait_for("native capture window", overlay_open)


def cancel():
    # An editor owns the first Escape. Cancellation is the next Escape.
    for _ in range(2):
        if not overlay_open():
            break
        keyboard.send_keys("{ESC}")
        end = time.monotonic() + 1
        while overlay_open() and time.monotonic() < end:
            time.sleep(0.1)
    wait_for("Escape closes overlay", lambda: not overlay_open())
    wait_for("Escape restores original source focus",
             lambda: user32.GetForegroundWindow() == source.handle)


def drag(region):
    x1, y1, x2, y2 = region
    mouse.press(coords=(x1, y1))
    for step in range(1, 21):
        mouse.move(coords=(round(x1 + (x2 - x1) * step / 20),
                           round(y1 + (y2 - y1) * step / 20)))
        time.sleep(0.02)
    mouse.release(coords=(x2, y2))


def assert_no_loupe():
    # Observe for a full second so a delayed frame cannot resurrect the loupe.
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if "Color value" in names():
            raise RuntimeError("Color loupe is visible in an ineligible mode/editor")
        time.sleep(0.1)


def pick(label, selected=False):
    point, expected = POINTS[label]
    seed_clipboard("KIRI COLOR SENTINEL")
    mouse.move(coords=point)
    wait_for("hover HEX " + expected, lambda: expected in names())
    wait_for("physical coordinates", lambda: f"{point[0]}, {point[1]}" in names())
    snapshot(f"{label}-{'selected' if selected else 'idle'}")
    keyboard.send_keys("^c")
    wait_for("native HEX clipboard", lambda: clipboard_text() == expected)
    if not overlay_open():
        raise RuntimeError("Color copy completed or cancelled capture")
    if selected:
        find(DONE)
        if "680 × 175" not in names():
            raise RuntimeError("Color copy changed the selection size")
    wait_for("copy success feedback", lambda: "Color copied" in names())
    report["checks"].append({"color": label, "hover_hex": expected,
        "physical_pixel": list(point), "clipboard": clipboard_text(),
        "selection_retained": selected, "overlay_open": True})


try:
    width, height = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    if width < 1024 or height < 650:
        raise RuntimeError("Color acceptance needs a 1024x650 desktop")
    report["desktop_size"] = [width, height]
    app = subprocess.Popen([str(executable)])
    find("Settings", timeout=35)
    fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name(
        "windows-capture-color-fixture.py")), str(width), str(height)])
    source = wait_for("public source window", lambda: next(iter(
        Desktop(backend="win32").windows(process=fixture.pid, visible_only=True)), None))
    source.set_focus()

    def painted():
        frame = ImageGrab.grab()
        return frame if all(frame.getpixel(point)[:3] == tuple(bytes.fromhex(color[1:]))
            for point, color in POINTS.values()) else None
    before = wait_for("known physical source pixels", painted)
    before.save(output / "source-desktop.png")
    begin()
    for label in POINTS:
        pick(label)
    cancel()
    report["checks"].append("Escape after color copying restores external source focus")

    begin()
    drag((70, 190, 750, 365))
    find(DONE)
    pick("near-black", selected=True)
    # The same shortcut must retain native copy inside selection dimensions.
    find("Resize selection").click_input()
    field = find("Width (px)", kind="Edit")
    field.click_input()
    keyboard.send_keys("^a^c")
    wait_for("native dimension text clipboard", lambda: clipboard_text() == "680")
    assert_no_loupe()
    if not overlay_open():
        raise RuntimeError("Dimension copy completed capture")
    report["checks"].append("dimension input copies 680 rather than HEX; overlay stays open")
    # Annotation text copying must not invoke the screenshot-completion shortcut.
    find("Text (T)").click_input()
    mouse.click(coords=(100, 225))
    editor = find("Text content", kind="Edit")
    editor.set_focus()
    keyboard.send_keys("COLOR TEXT QA", with_spaces=True)
    keyboard.send_keys("^a^c")
    wait_for("native annotation text clipboard", lambda: clipboard_text() == "COLOR TEXT QA")
    assert_no_loupe()
    snapshot("annotation-text-copy")
    if not overlay_open():
        raise RuntimeError("Text copy completed capture")
    cancel()
    report["checks"].append("annotation textarea copies its text and keeps capture open")

    for mode in ("Record", "OCR"):
        begin()
        # Supply a fresh eligible color before switching, catching stale samples.
        mouse.move(coords=POINTS["near-black"][0])
        wait_for("pre-switch loupe", lambda: "#000302" in names())
        find(mode).click_input()
        seed_clipboard(f"KIRI {mode.upper()} SENTINEL")
        mouse.move(coords=POINTS["pink"][0])
        assert_no_loupe()
        keyboard.send_keys("^c")
        time.sleep(0.3)
        if clipboard_text() != f"KIRI {mode.upper()} SENTINEL" or not overlay_open():
            raise RuntimeError(f"{mode} Ctrl+C was intercepted by color copying")
        if mode == "Record":
            drag((70, 190, 750, 365))
            find("Start Recording")
            mouse.move(coords=POINTS["near-black"][0])
            assert_no_loupe()
            keyboard.send_keys("^c")
            if clipboard_text() != "KIRI RECORD SENTINEL" or not overlay_open():
                raise RuntimeError("Recording options Ctrl+C was intercepted")
        snapshot(mode.lower() + "-no-color-copy")
        cancel()
        report["checks"].append(f"{mode}: no loupe or color clipboard action; Escape restores focus")
    report["success"] = True
except Exception as error:
    report["error"] = str(error)[:1500]
    if app:
        report.update(collect_crash_details(output, app))
        try:
            snapshot("failure-desktop")
        except Exception as snapshot_error:
            report["snapshot_error"] = str(snapshot_error)
finally:
    for process in (fixture, app):
        if process and process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            process.wait(timeout=15)
    log = Path(os.environ["LOCALAPPDATA"]) / "io.yuxino.kiri/logs/kiri.log"
    if log.exists():
        (output / "application.log").write_text("\n".join(log.read_text(
            encoding="utf-8", errors="replace").splitlines()[-350:]), encoding="utf-8")
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
if not report["success"]:
    raise SystemExit(report["error"])
