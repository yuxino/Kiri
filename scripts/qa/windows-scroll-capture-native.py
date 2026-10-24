"""Installed-app scroll startup, exclusion, input and saved-pixel CI regression.

This is an ordinary UI driver on a disposable desktop, not a product test mode.
Server CI does not establish Windows 10 / physical-device acceptance.
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
import tempfile
import time
import traceback

# Reject before importing desktop drivers, touching profiles or creating windows.
if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
    raise SystemExit("Use a disposable GitHub-hosted Windows desktop")

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
user32.SetThreadDpiAwarenessContext.argtypes = [wintypes.HANDLE]
user32.SetThreadDpiAwarenessContext.restype = wintypes.HANDLE
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowDisplayAffinity.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.WindowFromPoint.restype = wintypes.HWND
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
get_style = user32.GetWindowLongPtrW
get_style.argtypes = [wintypes.HWND, ctypes.c_int]
get_style.restype = ctypes.c_ssize_t
ENUM_WINDOWS = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [ENUM_WINDOWS, wintypes.LPARAM]

from PIL import Image, ImageChops, ImageGrab, ImageStat
from pywinauto import Desktop, keyboard, mouse
from windows_qa_profile import isolated_windows_profile

user32.SetThreadDpiAwarenessContext(wintypes.HANDLE(-4))
output = Path("windows-scroll-capture-review")
output.mkdir(exist_ok=True)
report = {"success": False, "native": True, "checks": [], "sessions": [],
          "harness_sha": os.environ.get("GITHUB_SHA"),
          "source_sha": os.environ.get("KIRI_SCROLL_CANDIDATE_SHA", os.environ.get("GITHUB_SHA")),
          "windows_version": list(sys.getwindowsversion()),
          "acceptance_scope": "This CI desktop only; not Windows 10 or physical-device acceptance"}
app = fixture = source = None
desktop = Desktop(backend="uia")
deadline = time.monotonic() + 240


def wait_for(description, predicate, timeout=25):
    end = min(deadline, time.monotonic() + timeout)
    while time.monotonic() < end:
        for process, name in ((app, "Kiri"), (fixture, "public scrolling source")):
            if process is not None and process.poll() is not None:
                raise RuntimeError(f"{name} exited while waiting for {description}: {process.returncode}")
        result = predicate()
        if result:
            return result
        time.sleep(0.15)
    raise RuntimeError(f"Timed out waiting for {description}")


def find(name, scope=None, timeout=25):
    def locate():
        windows = [scope] if scope is not None else desktop.windows(process=app.pid, visible_only=True)
        for window in windows:
            for control in window.descendants(control_type="Button"):
                try:
                    if (re.fullmatch(name, control.element_info.name or control.window_text())
                            and control.is_visible() and control.is_enabled()):
                        return control
                except Exception:
                    pass
        return None
    return wait_for(f"visible enabled {name}", locate, timeout)


def window_rect(hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    return [rect.left, rect.top, rect.right, rect.bottom]


def owner(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def affinity(hwnd):
    value = wintypes.DWORD()
    if not user32.GetWindowDisplayAffinity(hwnd, ctypes.byref(value)):
        raise ctypes.WinError(ctypes.get_last_error())
    return value.value


def native_windows():
    windows = []
    @ENUM_WINDOWS
    def visit(hwnd, _):
        if owner(hwnd) == app.pid:
            windows.append({"hwnd": int(hwnd), "rect": window_rect(hwnd),
                            "visible": bool(user32.IsWindowVisible(hwnd)),
                            "extended_style": int(get_style(hwnd, -20))})
        return True
    if not user32.EnumWindows(visit, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return windows


def require_geometry(windows, panel, screen, affinities, fallback_logged=False):
    candidates = [window for window in windows if window["hwnd"] != panel and
                  all(abs(a - b) <= 2 for a, b in zip(window["rect"], screen))]
    if len(candidates) != 1:
        raise RuntimeError("Scrolling region must uniquely cover its display")
    region = candidates[0]
    if affinities.get(panel) != 0x11:
        raise RuntimeError("Scrolling controls lost capture exclusion")
    if region["visible"]:
        if region["extended_style"] & 0x80020 != 0x80020:
            raise RuntimeError("Scrolling region lost layered pointer passthrough")
        if affinities.get(region["hwnd"]) != 0x11:
            raise RuntimeError("Visible scrolling region lost capture exclusion")
    elif not fallback_logged:
        raise RuntimeError("Hidden scrolling region needs this session's explicit safe fallback log")
    return region


def require_hit(hit_root, hit_pid, source_handle, source_pid):
    if hit_root != source_handle or hit_pid != source_pid:
        raise RuntimeError("Scrolling region intercepted input intended for the separate source process")


def state():
    return json.loads((workspace / "state.json").read_text(encoding="utf-8"))


def assets():
    index = library / "library.json"
    return json.loads(index.read_text(encoding="utf-8")) if index.exists() else []


def drag(start, end):
    mouse.press(coords=start)
    try:
        for step in range(1, 21):
            mouse.move(coords=tuple(round(a + (b - a) * step / 20) for a, b in zip(start, end)))
            time.sleep(0.025)
    finally:
        mouse.release(coords=end)


def fallback_evidence(log, offset):
    if not log.exists():
        return None
    fresh = log.read_bytes()[offset:].decode("utf-8", errors="replace")
    return next((line for line in fresh.splitlines()
                 if "[scroll] region guide hidden fallback:" in line
                 and "[stage=exclude-region-window]" in line), None)


def begin():
    log_start = native_log.stat().st_size if native_log.exists() else 0
    source.set_focus()
    wait_for("public source foreground", lambda: user32.GetForegroundWindow() == source.handle)
    keyboard.send_keys("^+a")
    overlay = find("Screenshot").top_level_parent()
    drag(selection[:2], selection[2:])
    find("Scrolling Screenshot", scope=overlay).click_input()
    panel = find("Cancel").top_level_parent()
    wait_for("frozen overlay closes", lambda: not user32.IsWindow(overlay.handle))
    find("Done|Done — Copy to clipboard", scope=panel)
    visible = native_windows()
    values = {window["hwnd"]: affinity(window["hwnd"]) for window in visible
              if window["hwnd"] == panel.handle or (window["visible"] and
                  all(abs(a - b) <= 2 for a, b in zip(window["rect"], [0, 0, width, height])))}
    fallback = fallback_evidence(native_log, log_start)
    if any(not window["visible"] and all(abs(a - b) <= 2 for a, b in
            zip(window["rect"], [0, 0, width, height])) for window in visible):
        fallback = wait_for("this session's explicit hidden-guide fallback log",
                            lambda: fallback_evidence(native_log, log_start), timeout=3)
    fallback_logged = bool(fallback)
    region = require_geometry(visible, panel.handle, [0, 0, width, height], values, fallback_logged)
    session = {"windows": visible, "region": region, "panel": int(panel.handle),
               "affinities": values, "guide_state": "visible-excluded" if region["visible"] else "hidden-fallback",
               "fallback_logged": fallback_logged, "fallback_diagnostic": fallback, "log_offset": log_start, "input": []}
    report["sessions"].append(session)
    wait_for("source focus restored after scroll startup", lambda: user32.GetForegroundWindow() == source.handle)
    # Include the painted dimming outside the crop, not only its transparent hole.
    for point in ((selection[0] - 12, selection[1] + 30),
                  (selection[2] - 30, (selection[1] + selection[3]) // 2)):
        hit = user32.GetAncestor(user32.WindowFromPoint(wintypes.POINT(*point)), 2)
        evidence = {"point": point, "root": int(hit or 0), "pid": owner(hit)}
        session["input"].append(evidence)
        require_hit(hit, evidence["pid"], source.handle, fixture.pid)
        before = state()["clicks"]
        mouse.click(coords=point)
        wait_for("physical click reaches separate source process", lambda: state()["clicks"] > before)
    keyboard.send_keys("^+a")
    find("Cancel", scope=panel)
    time.sleep(0.5)
    after = native_windows()
    repeated = require_geometry(after, panel.handle, [0, 0, width, height],
        {window["hwnd"]: affinity(window["hwnd"]) for window in after
         if window["hwnd"] == panel.handle or (window["hwnd"] == region["hwnd"] and window["visible"])},
        fallback_logged)
    if repeated["hwnd"] != region["hwnd"] or repeated["visible"] != region["visible"]:
        raise RuntimeError("Repeated capture shortcut changed the active scrolling guide")
    session["after_repeated_capture"] = repeated
    report["checks"].append("scroll startup/repeated shortcut: exact guide state, excluded controls and separate-process clicks")
    return panel, [region["hwnd"], panel.handle]


def foreground_evidence():
    foreground = user32.GetForegroundWindow()
    root = user32.GetAncestor(foreground, 2)
    return {"expected": {"hwnd": int(source.handle), "pid": fixture.pid},
            "actual": {"hwnd": int(foreground or 0), "pid": owner(foreground),
                       "root_hwnd": int(root or 0), "root_pid": owner(root)}}


def assert_closed(handles):
    wait_for("all scrolling windows destroyed", lambda: all(not user32.IsWindow(hwnd) for hwnd in handles))
    try:
        wait_for("source foreground after scrolling ends", lambda: user32.GetForegroundWindow() == source.handle)
    finally:
        # Keep the same strict focus assertion; record only HWND/PID metadata
        # so a failed return can be distinguished from fixture/window identity.
        report.setdefault("focus_after_scrolling", []).append(foreground_evidence())


def require_pixels(actual, expected):
    if actual.size != expected.size:
        raise RuntimeError(f"Saved scrolling dimensions differ: {actual.size} != {expected.size}")
    difference = ImageChops.difference(actual.convert("RGB"), expected.convert("RGB"))
    mean = max(ImageStat.Stat(difference).mean)
    # A small driver/color tolerance must not hide an opaque panel, dimming or
    # dropped/duplicated rows. Compare every pixel, including the moved panel area.
    histogram = difference.histogram()
    changed = sum(sum(histogram[channel * 256 + 13:(channel + 1) * 256]) for channel in range(3))
    fraction = changed / (actual.width * actual.height * 3)
    if mean > 1.5 or fraction > 0.005:
        raise RuntimeError(f"Saved scrolling pixels contain missing content or controls: mean={mean}, changed={fraction}")
    return {"size": actual.size, "max_channel_mean_error": mean, "changed_channel_fraction": fraction}


def require_one_pinned_asset(items, before_ids):
    if not before_ids.issubset({item["id"] for item in items}):
        raise RuntimeError("Direct scrolling pin changed an existing screenshot")
    created = [item for item in items if item["id"] not in before_ids]
    if len(created) != 1 or created[0]["kind"] != "image":
        raise RuntimeError("Direct scrolling pin must save exactly one screenshot")
    if Path(created[0]["filename"]).name != created[0]["filename"]:
        raise RuntimeError("Pinned screenshot must stay inside the isolated library")
    return created[0]


def require_pin_cleanup(scrolling_windows, pins, foreground, source_handle, app_pid):
    if (len(scrolling_windows) != 2 or len({window["hwnd"] for window in scrolling_windows}) != 2
            or any(window["hwnd"] <= 0 for window in scrolling_windows)):
        raise RuntimeError("Direct pin needs both captured scrolling HWND identities")
    if any(window["exists"] for window in scrolling_windows):
        raise RuntimeError("Direct pin left a scrolling window alive")
    if len(pins) != 1:
        raise RuntimeError("Direct pin must open exactly one visible reference window")
    pin = pins[0]
    if not pin["visible"] or pin["pid"] != app_pid or not pin["extended_style"] & 0x8:
        raise RuntimeError("Direct pin requires its visible native topmost reference")
    if foreground not in (source_handle, pin["hwnd"]):
        raise RuntimeError("Direct pin left an unrelated window in the foreground")
    return {"scrolling_windows": scrolling_windows, "reference": pin,
            "foreground_hwnd": int(foreground), "source_hwnd": int(source_handle),
            "only_source_or_reference_foreground": True}


def require_pin_lifecycle(log, asset_id):
    opened = list(re.finditer(re.escape(f"[pin] screenshot opened asset_id={asset_id.lower()}") + r"\b", log))
    destroyed = list(re.finditer(
        r"\[window\] destroyed label=(scroll-capture(?:-region)?)(?=\s|$)", log))
    if len(opened) != 1 or len(destroyed) != 2 or {item.group(1) for item in destroyed} != {
            "scroll-capture", "scroll-capture-region"}:
        raise RuntimeError("Direct scrolling pin needs one saved reference and both destroyed controls")
    if any(item.start() >= opened[0].start() for item in destroyed):
        raise RuntimeError("Direct scrolling pin opened before its capture windows were destroyed")
    return {"opened_once": True, "pin_after_scroll_windows_destroyed": True}


def require_clipboard_image(actual, copied):
    if not isinstance(copied, Image.Image) or copied.size != actual.size:
        raise RuntimeError("Direct scrolling pin must copy its full-resolution image")
    actual, copied = actual.convert("RGB"), copied.convert("RGB")
    if ImageChops.difference(actual, copied).getbbox() is not None:
        raise RuntimeError("Direct scrolling pin's clipboard differs from its saved image")
    return {"dimensions": list(actual.size), "saved_clipboard_pixels_identical": True,
            "rgb_sha256": hashlib.sha256(actual.tobytes()).hexdigest()}


def pinned_window():
    pins = desktop.windows(process=app.pid, title_re="Pinned Screenshot.*", visible_only=True)
    if len(pins) > 1:
        raise RuntimeError("Direct pin opened duplicate native references")
    return pins[0] if pins else None


def assert_pinned(handles):
    wait_for("all scrolling windows destroyed before pin", lambda: all(not user32.IsWindow(hwnd) for hwnd in handles))
    pin = wait_for("direct scrolling pin opens reference", pinned_window)
    wait_for("scroll reference native topmost", lambda: get_style(pin.handle, -20) & 0x8)
    wait_for("source or its reference foreground after pin", lambda:
             user32.GetForegroundWindow() in (source.handle, pin.handle))
    proof = require_pin_cleanup(
        [{"hwnd": int(hwnd), "exists": bool(user32.IsWindow(hwnd))} for hwnd in handles],
        [{"hwnd": int(window.handle), "pid": owner(window.handle),
          "visible": bool(user32.IsWindowVisible(window.handle)),
          "extended_style": int(get_style(window.handle, -20))}
         for window in desktop.windows(process=app.pid, title_re="Pinned Screenshot.*", visible_only=True)],
        int(user32.GetForegroundWindow() or 0), source.handle, app.pid,
    )
    return pin, proof


def stop(process):
    if process is not None and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15)
        process.wait(timeout=15)


try:
    executable = Path(os.environ["KIRI_QA_INSTALLED_EXE"]).resolve()
    if not executable.is_file() or (executable.parent / "kiri.portable").exists():
        raise RuntimeError("An installed non-portable Kiri executable is required")
    report["executable_sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    width, height = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    if width < 1024 or height < 650:
        raise RuntimeError("Scrolling acceptance needs at least a 1024x650 desktop")
    selection = [width // 5, height // 5, width * 4 // 5, height * 7 // 10]
    report["selection"] = selection
    with tempfile.TemporaryDirectory(prefix="kiri-scroll-fixture-", dir=os.environ["RUNNER_TEMP"]) as temporary:
        workspace = Path(temporary)
        with isolated_windows_profile() as environment:
            library = Path(environment["APPDATA"]) / "kiri"
            config = Path(environment["APPDATA"]) / "io.yuxino.kiri"
            (config / "language.json").write_text(json.dumps("en"), encoding="utf-8")
            native_log = Path(environment["LOCALAPPDATA"]) / "io.yuxino.kiri/logs/kiri.log"
            try:
                app = subprocess.Popen([str(executable)], env=environment)
                find("Settings", timeout=40)
                fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name(
                    "windows-scroll-capture-fixture.py")), str(width), str(height), str(workspace)])
                source = wait_for("public scrolling window", lambda: next(iter(
                    Desktop(backend="win32").windows(process=fixture.pid, visible_only=True)), None))
                wait_for("source painted", lambda: (workspace / "state.json").exists())
                before_ids = {asset["id"] for asset in assets()}
                panel, handles = begin()
                find("Cancel", scope=panel).click_input()
                assert_closed(handles)
                if {asset["id"] for asset in assets()} != before_ids:
                    raise RuntimeError("Cancelling scrolling capture saved an asset")
                report["checks"].append("cancel destroys both windows without saving")
                panel, handles = begin()
                # Put real controls inside the selected pixels. Affinity readback
                # alone cannot prove that WGC omits controls rather than blanks them.
                bounds = window_rect(panel.handle)
                heading = (bounds[0] + 45, bounds[1] + 20)
                target = (selection[0] + 70, selection[1] + 40)
                drag(heading, target)
                wait_for("controls move inside selection", lambda:
                    selection[0] <= window_rect(panel.handle)[0] < selection[2] - 100 and
                    selection[1] <= window_rect(panel.handle)[1] < selection[3] - 50)
                report["sessions"][-1]["moved_panel_rect"] = window_rect(panel.handle)
                source.set_focus()
                wait_for("source foreground before wheel", lambda: user32.GetForegroundWindow() == source.handle)
                point = (selection[2] - 30, (selection[1] + selection[3]) // 2)
                for _ in range(3):
                    before = state()
                    mouse.scroll(coords=point, wheel_dist=-1)
                    wait_for("real wheel scroll reaches source", lambda: state()["offset"] > before["offset"])
                    time.sleep(0.7)
                offset = state()["offset"]
                if offset < 288:
                    raise RuntimeError("Source did not receive all three native scroll steps")
                mouse.move(coords=(width - 8, height - 8))
                find("Done|Done — Copy to clipboard", scope=panel).click_input()
                assert_closed(handles)
                saved = wait_for("one scrolling screenshot saved", lambda:
                    [asset for asset in assets() if asset["id"] not in before_ids])
                if len(saved) != 1 or saved[0]["kind"] != "image":
                    raise RuntimeError("Expected exactly one saved scrolling image")
                path = library / "Assets" / saved[0]["filename"]
                with Image.open(path) as actual, Image.open(workspace / "reference.png") as reference:
                    expected = reference.crop((selection[0], selection[1], selection[2], selection[3] + offset))
                    # Preserve both public images even when pixel comparison
                    # fails; isolated profile cleanup removes the saved asset.
                    actual.save(output / "saved-scrolling.png")
                    expected.save(output / "expected-scrolling.png")
                    report["saved_pixels"] = require_pixels(actual, expected)
                report["source_events"] = state()
                report["checks"].append("restart, real wheel scrolling, moved controls excluded, exact connected saved pixels")

                # A new real capture owns its own baseline and source offset.
                # Ordinary Done above retains the strict source-focus check.
                pin_before_ids = {asset["id"] for asset in assets()}
                pin_start_offset = state()["offset"]
                panel, handles = begin()
                source.set_focus()
                wait_for("source foreground before direct-pin scroll", lambda:
                         user32.GetForegroundWindow() == source.handle)
                for _ in range(5):
                    before = state()
                    mouse.scroll(coords=point, wheel_dist=-1)
                    wait_for("new scrolling session receives real wheel", lambda:
                             state()["offset"] > before["offset"])
                    time.sleep(0.7)
                pin_end_offset = state()["offset"]
                mouse.move(coords=(width - 8, height - 8))
                find("Pin Screenshot on Top", scope=panel).click_input()
                pin, cleanup_proof = assert_pinned(handles)
                pinned_asset = require_one_pinned_asset(assets(), pin_before_ids)
                report["direct_pin"] = {"asset_id": pinned_asset["id"], "cleanup": cleanup_proof,
                    "source_offsets": [pin_start_offset, pin_end_offset]}
                with Image.open(library / "Assets" / pinned_asset["filename"]) as actual, \
                        Image.open(workspace / "reference.png") as reference:
                    expected = reference.crop((selection[0], selection[1] + pin_start_offset,
                                               selection[2], selection[3] + pin_end_offset))
                    actual.save(output / "direct-scroll-pin-saved.png")
                    expected.save(output / "direct-scroll-pin-expected.png")
                    pixel_proof = require_pixels(actual, expected)
                    report["direct_pin"]["saved_pixels"] = pixel_proof
                    copied = ImageGrab.grabclipboard()
                    clipboard_proof = require_clipboard_image(actual, copied)
                    report["direct_pin"]["clipboard"] = clipboard_proof
                    copied.save(output / "direct-scroll-pin-clipboard.png")
                log_offset = report["sessions"][-1]["log_offset"]
                trace = wait_for("direct scrolling pin lifecycle log", lambda:
                    (text := native_log.read_bytes()[log_offset:].decode("utf-8", errors="replace"))
                    and f"[pin] screenshot opened asset_id={pinned_asset['id'].lower()}" in text and text)
                (output / "direct-scroll-pin-lifecycle.log").write_text(trace, encoding="utf-8")
                lifecycle = require_pin_lifecycle(trace, pinned_asset["id"])
                report["direct_pin"]["lifecycle"] = lifecycle
                bounds = window_rect(pin.handle)
                mouse.move(coords=((bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2))
                find("Unpin", scope=pin)
                # Zoom is enabled only after this asset's real image has loaded;
                # a mounted but empty reference must not pass the native gate.
                find(r"Zoom level: [0-9.]+%", scope=pin)
                report["direct_pin"]["reference_rect"] = bounds
                report["direct_pin"]["image_ready"] = True
                ImageGrab.grab().save(output / "direct-scroll-pin-reference.png")
                find("Close", scope=pin).click_input()
                wait_for("direct scrolling reference closes", lambda: not user32.IsWindow(pin.handle))
                retained = require_one_pinned_asset(assets(), pin_before_ids)
                if retained["id"] != pinned_asset["id"]:
                    raise RuntimeError("Closing a scrolling reference changed its saved screenshot")
                report["direct_pin"].update(reference_closed=True, saved_asset_retained=True)
                report["checks"].append("direct scrolling Pin saves one full-resolution image, copies it, destroys controls before pinning and closes without deleting it")
            except Exception:
                try:
                    report["windows_at_failure"] = native_windows() if app and app.poll() is None else []
                    if source is not None and fixture is not None:
                        report["focus_at_failure"] = foreground_evidence()
                    ImageGrab.grab().save(output / "failure-desktop.png")
                except Exception as diagnostic_error:
                    report["diagnostic_error"] = str(diagnostic_error)
                raise
            finally:
                try:
                    stop(app)
                finally:
                    stop(fixture)
                    if native_log.exists():
                        (output / "kiri-native.log").write_bytes(native_log.read_bytes())
    report["success"] = True
except Exception as error:
    traceback.print_exc()
    report["error"] = f"{type(error).__name__}: {error}"
finally:
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
if not report["success"]:
    raise SystemExit(report["error"])
