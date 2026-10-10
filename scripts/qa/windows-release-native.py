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
from pin_native_checks import annotated_capture_evidence, borderless_geometry_evidence, pin_lifecycle_evidence, pin_open_log_marker, proportional_resize_evidence
from windows_qa_profile import isolated_windows_profile


if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")

output = Path("windows-release-review")
output.mkdir(exist_ok=True)
report = {"success": False, "checks": []}
desktop = Desktop(backend="uia")
process = None
app_environment = library = native_log = None


def find(name, timeout=35, scroll=False, scope=None):
    deadline = time.monotonic() + timeout
    previous = None
    stable = 0
    while time.monotonic() < deadline:
        needs_scroll = scroll
        if process.poll() is not None:
            raise RuntimeError(f"Kiri exited early: {process.returncode}")
        for window in ([scope] if scope is not None else desktop.windows(process=process.pid, visible_only=True)):
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


def pinned_window():
    pins = desktop.windows(process=process.pid, title_re="Pinned Screenshot.*", visible_only=True)
    if len(pins) > 1:
        raise RuntimeError("One capture opened duplicate reference windows")
    return pins[0] if pins else None


def client_bounds(window):
    user32 = ctypes.windll.user32
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    rect, origin = wintypes.RECT(), wintypes.POINT()
    if not user32.GetClientRect(window.handle, ctypes.byref(rect)) or not user32.ClientToScreen(window.handle, ctypes.byref(origin)):
        raise ctypes.WinError()
    return origin.x, origin.y, origin.x + rect.right, origin.y + rect.bottom


def outer_bounds(window):
    user32 = ctypes.windll.user32
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    rect = wintypes.RECT()
    if not user32.GetWindowRect(window.handle, ctypes.byref(rect)):
        raise ctypes.WinError()
    return rect.left, rect.top, rect.right, rect.bottom


def drag_mouse(start, end, native=False):
    mouse.press(coords=start)
    time.sleep(0.3 if native else 0.15)
    if native:
        for step in range(1, 9):
            mouse.move(coords=tuple(round(a + (b - a) * step / 8) for a, b in zip(start, end)))
            time.sleep(0.1)
    else:
        mouse.move(coords=end)
    time.sleep(0.15)
    mouse.release(coords=end)


def direct_pin_acceptance(source, expected, region, user32):
    source.set_focus()
    wait_for("direct capture source focus", lambda: user32.GetForegroundWindow() == source.handle)
    before_ids = {item["id"] for item in json.loads((library / "library.json").read_text())}
    log_offset = native_log.stat().st_size
    keyboard.send_keys("^+a")
    owner_handle = find("Screenshot").top_level_parent().handle
    drag_mouse(region[:2], region[2:])
    find(re.escape("Rectangle (R)")).click_input()
    drag_mouse((170, 335), (350, 395))
    find("Pin Screenshot on Top").click_input()
    pin = wait_for("direct toolbar pin opens native reference", pinned_window)
    wait_for("capture owner is destroyed", lambda: not user32.IsWindow(owner_handle))
    # Tao retains WS_CAPTION for top-level windows but removes the actual
    # nonclient frame in WM_NCCALCSIZE. Style bits alone do not prove a titlebar.
    frame = borderless_geometry_evidence(client_bounds(pin), outer_bounds(pin))
    report["pin_native_frame"] = frame
    wait_for("direct reference native topmost applied", lambda: user32.GetWindowLongW(pin.handle, -20) & 0x00000008)
    items = json.loads((library / "library.json").read_text())
    created = [item for item in items if item["id"] not in before_ids]
    if len(created) != 1 or created[0]["kind"] != "image":
        raise RuntimeError("Direct pin must save exactly one screenshot")
    copied = ImageGrab.grabclipboard()
    if not isinstance(copied, Image.Image):
        raise RuntimeError("Direct pin did not copy a PNG")
    captured, pixel_proof = annotated_capture_evidence(library, created[0], expected, copied)
    captured.save(output / "direct-pin-annotated.png")
    trace = wait_for("direct pin lifecycle log", lambda:
                    (text := native_log.read_bytes()[log_offset:].decode("utf-8", errors="replace"))
                    and pin_open_log_marker(created[0]["id"]) in text and text)
    (output / "direct-pin-lifecycle.log").write_text(trace)
    lifecycle = pin_lifecycle_evidence(trace, created[0]["id"])

    pin.set_focus()
    before = client_bounds(pin)
    mouse.move(coords=(before[0] + 30, before[1] + 30))
    find("Unpin", scope=pin)  # React must have mounted before pointer input.
    def initial_image_painted():
        actual = ImageGrab.grab(bbox=before).convert("RGB")
        expected_image = captured.resize(actual.size, Image.Resampling.LANCZOS)
        error = sum(ImageStat.Stat(ImageChops.difference(actual, expected_image)).mean) / 3
        return {"mean_pixel_error": error} if error <= 3 else None
    report["pin_ready"] = wait_for("actual annotated pin image painted before drag", initial_image_painted)
    ImageGrab.grab().save(output / "direct-pin-ready-for-drag.png")
    start = ((before[0] + before[2]) // 2, (before[1] + before[3]) // 2)
    drag_mouse(start, (start[0] + 80, start[1] + 50), native=True)
    moved = wait_for("dragging the reference image moves its native window", lambda:
                    (bounds := client_bounds(pin)) and abs(bounds[0] - before[0]) >= 30 and abs(bounds[1] - before[1]) >= 20 and bounds)
    before_size = (moved[2] - moved[0], moved[3] - moved[1])
    corner = (moved[2] - 12, moved[3] - 12)
    delta = (max(40, round(before_size[0] * 0.1)), max(25, round(before_size[1] * 0.2)))
    mouse.move(coords=corner)
    drag_mouse(corner, (corner[0] + delta[0], corner[1] + delta[1]))
    resized = wait_for("native reference grows after corner resize", lambda:
                      (bounds := client_bounds(pin)) and bounds[2] - bounds[0] >= before_size[0] + 20 and bounds)
    resize = proportional_resize_evidence(before_size, (resized[2] - resized[0], resized[3] - resized[1]))
    mouse.move(coords=(resized[0] + 30, resized[1] + 30))
    find("Unpin", scope=pin).click_input()
    wait_for("Unpin drops native topmost", lambda: not user32.GetWindowLongW(pin.handle, -20) & 0x00000008)
    find("Pin on Top", scope=pin).click_input()
    wait_for("repin restores native topmost", lambda: user32.GetWindowLongW(pin.handle, -20) & 0x00000008)
    # Clear the button's DOM focus so :focus-within does not leave controls
    # painted during the independent image-pixel comparison.
    mouse.click(coords=(resized[0] + 30, resized[3] - 30))
    source.set_focus()
    mouse.move(coords=(10, user32.GetSystemMetrics(1) - 10))
    def visible_image():
        bounds = client_bounds(pin)
        actual = ImageGrab.grab(bbox=bounds).convert("RGB")
        reference = captured.resize(actual.size, Image.Resampling.LANCZOS)
        error = sum(ImageStat.Stat(ImageChops.difference(actual, reference)).mean) / 3
        return {"mean_pixel_error": error} if error <= 3 else None
    visible = wait_for("annotated reference stays above another app", visible_image)
    ImageGrab.grab().save(output / "direct-pin-moved-resized.png")
    pin.set_focus()
    bounds = client_bounds(pin)
    mouse.move(coords=(bounds[0] + 30, bounds[1] + 30))
    find("Close", scope=pin).click_input()
    wait_for("hover Close destroys the native pin", lambda: pinned_window() is None)

    source.set_focus()
    keyboard.send_keys("^+a"); find("Screenshot")
    drag_mouse(region[:2], region[2:])
    find(re.escape("Done — Copy to clipboard · Return"))
    keyboard.send_keys("{ENTER}")
    find("Pin Screenshot on Top", timeout=7)  # Ordinary completion card.
    copied = ImageGrab.grabclipboard()
    if not isinstance(copied, Image.Image) or copied.size != expected.size or pinned_window() is not None:
        raise RuntimeError("Normal Return completion unexpectedly pinned or changed its output")
    if sum(ImageStat.Stat(ImageChops.difference(copied.convert("RGB"), expected)).mean) / 3 > 1.5:
        raise RuntimeError("Normal completion after direct pin copied different source pixels")
    if user32.GetForegroundWindow() != source.handle:
        raise RuntimeError("Normal completion after direct pin lost source focus")
    report["direct_pin"] = {**lifecycle, **pixel_proof, "native_caption": False, "native_topmost": True,
                            "image_drag_moves_window": True, "resize": resize, "visible_mean_pixel_error": visible["mean_pixel_error"],
                            "hover_close_destroys_window": True, "normal_return_still_works": True}
    report["checks"].append("real annotated toolbar pin opens once after every overlay is destroyed; borderless native drag/resize/unpin/repin/close and ordinary Return completion work")


def quick_capture_acceptance():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
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
        pin_window = wait_for("completion-card reference window", pinned_window)
        bounds = client_bounds(pin_window)
        mouse.move(coords=(bounds[0] + 30, bounds[1] + 30))
        find("Unpin", scope=pin_window)
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
        direct_pin_acceptance(source, expected, region, user32)
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
    process = subprocess.Popen([str(executable)], env=app_environment)
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
    with isolated_windows_profile() as app_environment:
        library = Path(app_environment["APPDATA"]) / "kiri"
        native_log = Path(app_environment["LOCALAPPDATA"]) / "io.yuxino.kiri/logs/kiri.log"
        report["isolated_profile"] = True
        try:
            smoke(portable, "Open Releases Page", "portable ZIP")
            if sorted(path.name for path in portable.parent.iterdir()) != ["kiri.exe", "kiri.portable"]:
                raise RuntimeError("Portable copy wrote unexpected files beside the executable")
            smoke(installed, "Check for Updates", "NSIS installation")
            report["native_acceptance_success"] = True
        except Exception as error:
            # Keep the primary failure if later WebView cleanup also fails.
            report["acceptance_error"] = str(error)
            raise
        finally:
            stop()
            if native_log.is_file():
                (output / "kiri-native.log").write_bytes(native_log.read_bytes())
    report["success"] = True
except Exception as error:
    report["error"] = str(error)[:1500]
finally:
    stop()
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

if not report["success"]:
    raise SystemExit(report["error"])
