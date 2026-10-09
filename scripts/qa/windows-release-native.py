"""Smoke-test the extracted ZIP and installed NSIS app on disposable Windows CI."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from pywinauto import Desktop, keyboard, mouse
from PIL import Image, ImageChops, ImageGrab, ImageStat


if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")

output = Path("windows-release-review")
output.mkdir(exist_ok=True)
report = {"success": False, "checks": []}
desktop = Desktop(backend="uia")
process = None


def find(name, timeout=35, scroll=False):
    deadline = time.monotonic() + timeout
    previous = None
    stable = 0
    while time.monotonic() < deadline:
        needs_scroll = scroll
        if process.poll() is not None:
            raise RuntimeError(f"Kiri exited early: {process.returncode}")
        for window in desktop.windows(process=process.pid, visible_only=True):
            for control in window.descendants():
                try:
                    if (control.element_info.control_type != "Button" or
                            not re.fullmatch(name, control.window_text()) or not control.is_enabled()):
                        continue
                    if not control.is_visible() and scroll:
                        # WebView2 exposes the off-screen button in UIA. Asking
                        # that element to focus or scroll into view targets the
                        # settings pane; wheel events at the window gutter can
                        # miss its CSS scroll container.
                        try:
                            control.iface_scroll_item.ScrollIntoView()
                        except Exception:
                            control.set_focus()
                    if control.is_visible():
                        bounds = control.rectangle()
                        needs_scroll = False
                        current = (control.window_text(),
                                   (bounds.left, bounds.top, bounds.right, bounds.bottom))
                        if bounds.width() > 0 and bounds.height() > 0:
                            stable = stable + 1 if previous == current else 1
                            previous = current
                            if stable >= 3:
                                return control
                except Exception:
                    pass
        if needs_scroll:
            # Keep a physical-scroll fallback for WebView2 versions without
            # UIA ScrollItem support. Aim inside the page, not at its gutter.
            window = desktop.windows(process=process.pid, visible_only=True)[0]
            window.set_focus()
            bounds = window.rectangle()
            mouse.scroll(coords=(bounds.left + int(bounds.width() * 0.75),
                                 bounds.top + int(bounds.height() * 0.5)), wheel_dist=-4)
        time.sleep(0.2)
    raise RuntimeError(f"Visible control not found: {name}")


def snapshot(label):
    windows = desktop.windows(process=process.pid, visible_only=True)
    evidence = {"label": label, "windows": []}
    for index, window in enumerate(windows):
        filename = f"{label}-{index}.png"
        window.capture_as_image().save(output / filename)
        evidence["windows"].append({"screenshot": filename, "controls": [
            {"text": control.window_text(), "type": control.element_info.control_type,
             "bounds": [control.rectangle().left, control.rectangle().top,
                        control.rectangle().right, control.rectangle().bottom],
             "visible": control.is_visible(),
             "enabled": control.is_enabled()}
            for control in window.descendants()
        ]})
    report.setdefault("evidence", []).append(evidence)


def stop():
    global process
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
        process.wait(timeout=15)
    process = None


def wait_for(description, predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Kiri exited while waiting for {description}")
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}")


def quick_capture_acceptance():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = wintypes.LONG
    width, height = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    if width < 1024 or height < 650:
        raise RuntimeError("Native capture acceptance needs a 1024x650 desktop")
    fixture = subprocess.Popen([sys.executable,
        str(Path(__file__).with_name("windows-quick-capture-fixture.py")), str(width), str(height)])
    try:
        source = wait_for("public source window", lambda: next(iter(
            Desktop(backend="win32").windows(process=fixture.pid, visible_only=True)), None))
        source.set_focus()
        wait_for("public source focus", lambda: user32.GetForegroundWindow() == source.handle)
        # Wait for the real desktop source to paint; pixels come from the OS,
        # never from an injected capture mode or a renderer fixture.
        def source_painted():
            frame = ImageGrab.grab()
            return frame if frame.getpixel((80, 200))[:3] == (255, 255, 255) else None
        before = wait_for("public source paint", source_painted)
        region = (70, 190, 650, 425)
        expected = before.crop(region).convert("RGB")
        expected.save(output / "quick-capture-source.png")
        if not user32.OpenClipboard(None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not user32.EmptyClipboard():
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            user32.CloseClipboard()
        keyboard.send_keys("^+a")
        find("Screenshot")
        mouse.press(coords=region[:2])
        mouse.move(coords=region[2:])
        mouse.release(coords=region[2:])
        find(re.escape("Done — Copy to clipboard · Return"))
        mouse.double_click(coords=(400, 380))
        pin_button = find("Pin Screenshot on Top", timeout=7)
        copied = ImageGrab.grabclipboard()
        if not isinstance(copied, Image.Image) or copied.size != expected.size:
            raise RuntimeError("Double-click did not copy the selected region")
        difference = ImageChops.difference(copied.convert("RGB"), expected)
        error = sum(ImageStat.Stat(difference).mean) / 3
        if error > 1.5:
            raise RuntimeError(f"Double-click capture pixels differ from the source: {error}")
        copied.save(output / "quick-capture-clipboard.png")
        if user32.GetForegroundWindow() != source.handle:
            raise RuntimeError("Screenshot completion did not restore source focus")
        ImageGrab.grab().save(output / "quick-capture-completed.png")
        pin_button.click_input()
        unpin = find("Unpin")
        pin_window = unpin.top_level_parent()
        if "Pinned Screenshot" not in pin_window.window_text():
            raise RuntimeError("Completion card did not open the reference window")
        if not user32.GetWindowLongW(pin_window.handle, -20) & 0x00000008:
            raise RuntimeError("Reference window lacks the native topmost style")
        Desktop(backend="win32").window(handle=pin_window.handle).move_window(max(300, width - 730), 180)
        source.set_focus()
        wait_for("another app owns keyboard focus", lambda: user32.GetForegroundWindow() == source.handle)
        def visible_pinned_image():
            for control in pin_window.descendants(control_type="Image"):
                if control.window_text() != "Pinned screenshot" or not control.is_visible():
                    continue
                bounds = control.rectangle()
                if bounds.width() < 200 or bounds.height() < 100:
                    continue
                actual = ImageGrab.grab(bbox=(bounds.left, bounds.top, bounds.right, bounds.bottom)).convert("RGB")
                reference = copied.convert("RGB").resize(actual.size, Image.Resampling.LANCZOS)
                diff = ImageChops.difference(actual, reference)
                mean = sum(ImageStat.Stat(diff).mean) / 3
                if mean <= 3:
                    return {"bounds": [bounds.left, bounds.top, bounds.right, bounds.bottom], "mean_pixel_error": mean}
            return None
        visible = wait_for("pinned image above another foreground app", visible_pinned_image)
        ImageGrab.grab().save(output / "quick-capture-pinned.png")
        pin_window.set_focus()
        keyboard.send_keys("{ESC}")
        wait_for("Escape closes reference", lambda: not desktop.windows(
            process=process.pid, title_re="Pinned Screenshot.*", visible_only=True))
        report["quick_capture"] = {"capture_mean_pixel_error": error, "source_focus_restored": True,
            "native_topmost": True, "visible_above_foreground_app": visible, "escape_closes_reference": True}
        report["checks"].extend([
            "stationary region double-click completes native capture, copies exact pixels and restores source focus",
            "completion-card Pin opens a native topmost reference visible above another foreground app",
            "Escape closes the pinned reference without quitting Kiri",
        ])
    except Exception:
        ImageGrab.grab().save(output / "quick-capture-failure.png")
        copied = ImageGrab.grabclipboard()
        if isinstance(copied, Image.Image):
            report["failure_clipboard_size"] = list(copied.size)
            copied.save(output / "quick-capture-failure-clipboard.png")
        raise
    finally:
        fixture.terminate()
        fixture.wait(timeout=10)


def smoke(executable, update_button, label):
    global process
    if not executable.is_file():
        raise RuntimeError(f"Missing {label} executable")
    process = subprocess.Popen([str(executable)])
    try:
        settings = find("Settings")
        # UIA can expose WebView controls before startup activation completes.
        # Bring the native window forward before the one physical click, and
        # retain both frames instead of silently retrying a missed click.
        settings.top_level_parent().set_focus()
        settings = find("Settings")
        snapshot(f"{label.split()[0]}-before-settings")
        settings.click_input()
        find(update_button, scroll=True)
        snapshot(f"{label.split()[0]}-settings")
        report["checks"].append(f"{label} launches and shows the correct update route")
        keyboard.send_keys("^+a")
        find("Screenshot")
        keyboard.send_keys("{ESC}")
        report["checks"].append(f"{label} opens and cancels native capture")
        if label == "NSIS installation":
            quick_capture_acceptance()
    except Exception:
        try:
            snapshot(f"{label.split()[0]}-failure")
        except Exception as error:
            report["screenshot_error"] = str(error)
        report["windows"] = []
        for window in desktop.windows(process=process.pid, visible_only=True):
            try:
                report["windows"].append([
                    {"text": control.window_text(), "visible": control.is_visible(),
                     "enabled": control.is_enabled()}
                    for control in window.descendants()
                ])
            except Exception:
                pass
        raise
    finally:
        stop()


try:
    portable = Path(os.environ["KIRI_QA_PORTABLE_EXE"])
    installed = Path(os.environ["KIRI_QA_INSTALLED_EXE"])
    if not (portable.parent / "kiri.portable").is_file():
        raise RuntimeError("Extracted portable marker is missing")
    if (installed.parent / "kiri.portable").exists():
        raise RuntimeError("Installed copy contains a portable marker")
    smoke(portable, "Open Releases Page", "portable ZIP")
    if sorted(path.name for path in portable.parent.iterdir()) != ["kiri.exe", "kiri.portable"]:
        raise RuntimeError("Portable copy wrote unexpected files beside the executable")
    smoke(installed, "Check for Updates", "NSIS installation")
    report["success"] = True
except Exception as error:
    report["error"] = str(error)[:1500]
finally:
    stop()
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

if not report["success"]:
    raise SystemExit(report["error"])
