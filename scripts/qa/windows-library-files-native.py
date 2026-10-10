"""Installed Kiri file actions on an isolated GitHub-hosted Windows desktop.

Real UIA actions, Explorer COM observations and Ctrl+V are the acceptance
boundary. All inputs, profile directories, clipboard files and Explorer folders
belong to this run; no synthetic capture mode or private library is used.
"""

import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.parse import urlsplit
from urllib.request import url2pathname
import uuid

if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
    raise SystemExit("Use a disposable GitHub-hosted Windows desktop")

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
user32.GetForegroundWindow.restype = wintypes.HWND
user32.IsWindow.argtypes = [wintypes.HWND]

from PIL import Image, ImageChops, ImageGrab, ImageStat
from pywinauto import Desktop, keyboard, mouse
import pythoncom
import win32clipboard
import win32com.client
from win32con import CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT
import win32gui
from windows_qa_profile import isolated_windows_profile

output = Path("windows-library-files-review")
output.mkdir(exist_ok=True)
report = {"success": False, "native": True, "checks": [], "phase": "initialize"}
desktop = Desktop(backend="uia")
process = fixture = None
library_window = root = workspace = shell = None
clipboard_owner = None
app_environment = None
# Leave room within the ten-minute gate for process/profile/Explorer cleanup.
deadline = time.monotonic() + 480
preferred_drop_effect = win32clipboard.RegisterClipboardFormat("Preferred DropEffect")


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def normalized(path):
    value = str(path)
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return os.path.normcase(os.path.abspath(os.path.normpath(value)))


def wait_for(description, predicate, timeout=25):
    end = min(deadline, time.monotonic() + timeout)
    last_error = None
    while time.monotonic() < end:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"Kiri exited while waiting for {description}: {process.returncode}")
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:
            last_error = str(error)
        time.sleep(0.15)
    raise RuntimeError(f"Timed out waiting for {description}; last error: {last_error}")


def controls(scope=None):
    windows = [scope] if scope is not None else desktop.windows(process=process.pid, visible_only=True)
    for window in windows:
        for control in window.descendants():
            yield control


def find(name=None, kinds=None, scope=None, predicate=lambda _: True, scroll=False, timeout=25):
    previous = None
    stable = 0

    def locate():
        nonlocal previous, stable
        needs_scroll = scroll
        for control in controls(scope):
            try:
                if ((name is not None and control.window_text() != name and control.element_info.name != name)
                        or (kinds is not None and control.element_info.control_type not in kinds)
                        or not control.is_enabled() or not predicate(control)):
                    continue
                if scroll and not control.is_visible():
                    try:
                        control.iface_scroll_item.ScrollIntoView()
                    except Exception:
                        control.set_focus()
                bounds = control.rectangle()
                if control.is_visible() and bounds.width() > 0 and bounds.height() > 0:
                    needs_scroll = False
                    position = (control.element_info.control_type, control.element_info.name,
                                bounds.left, bounds.top, bounds.right, bounds.bottom)
                    stable = stable + 1 if previous == position else 1
                    previous = position
                    if stable >= 3:
                        return control
                    break
            except Exception:
                pass
        if needs_scroll:
            window = scope or desktop.windows(process=process.pid, visible_only=True)[0]
            window.set_focus()
            bounds = window.rectangle()
            mouse.scroll(coords=(bounds.left + int(bounds.width() * 0.75),
                                 bounds.top + int(bounds.height() * 0.5)), wheel_dist=-4)
        return None
    return wait_for(f"visible {name or kinds} control", locate, timeout)


def phase(name):
    report["phase"] = name
    print(name, flush=True)


def snapshot(label):
    try:
        ImageGrab.grab().save(output / f"{label}.png")
        windows = desktop.windows(process=process.pid, visible_only=True) if process else []
        details = []
        for window in windows:
            entries = []
            for control in window.descendants():
                try:
                    bounds = control.rectangle()
                    entries.append({"name": control.window_text(), "accessible_name": control.element_info.name,
                                    "type": control.element_info.control_type, "visible": control.is_visible(),
                                    "enabled": control.is_enabled(),
                                    "bounds": [bounds.left, bounds.top, bounds.right, bounds.bottom]})
                except Exception:
                    pass
            details.append({"handle": window.handle, "controls": entries})
        (output / f"{label}-uia.json").write_text(json.dumps(details, indent=2, ensure_ascii=False), encoding="utf-8")
        report.setdefault("screenshots", []).append(f"{label}.png")
    except Exception as error:
        report.setdefault("diagnostic_errors", []).append(str(error))


def stop():
    global process
    if process is not None:
        if process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=20)
            process.wait(timeout=15)
        process = None


def launch(executable):
    global process, library_window
    process = subprocess.Popen([str(executable)], env=app_environment)
    library_window = find("Settings", kinds=("Button",), timeout=40).top_level_parent()
    focus_library()


def focus_library():
    library_window.set_focus()
    wait_for("library window in the foreground", lambda: user32.GetForegroundWindow() == library_window.handle)


def index():
    return json.loads((root / "library.json").read_text(encoding="utf-8"))


def current(asset_id):
    return next(asset for asset in index() if asset["id"].lower() == asset_id.lower())


def replace_text(control, text):
    # WebView2's UIA SetValue can lose React's focused inline editor. Use the
    # same native SendInput path as the accepted capture-color text check.
    # VK_PACKET preserves Unicode and never touches the file clipboard offer.
    if any(character in text for character in "{}+^%~()"):
        raise RuntimeError("Native text fixture contains SendKeys control syntax")
    control.click_input()
    keyboard.send_keys("^a")
    keyboard.send_keys(text, with_spaces=True, vk_packet=True)
    wait_for("native text input value", lambda: control.get_value() == text)


def card(title):
    focus_library()
    search = find("Search captures", kinds=("Edit",), scope=library_window)
    replace_text(search, title)
    return find(title, scope=library_window, predicate=lambda control: control.rectangle().height() > 150)


def action(title, label):
    card(title).click_input(button="right")
    # A card's Copy button remains visible to UIA underneath the popup. Click
    # the actual menu item, rather than its occluded same-name card action.
    item = find(label, kinds=("MenuItem",), scope=library_window)
    bounds = item.rectangle()
    targets = report.setdefault("action_targets", [])
    targets.append({"title": title, "label": label, "type": item.element_info.control_type,
                    "bounds": [bounds.left, bounds.top, bounds.right, bounds.bottom]})
    if label in ("Copy", "Copy File"):
        snapshot(f"copy-menu-{len(targets)}")
    item.click_input()


def explorer_windows():
    found = []
    windows = shell.Windows()
    for position in range(windows.Count):
        try:
            window = windows.Item(position)
            parsed = urlsplit(str(window.LocationURL))
            if parsed.scheme.lower() == "file" and not parsed.netloc:
                found.append((window, Path(url2pathname(parsed.path))))
        except Exception:
            pass
    return found


def explorer_for(folder, selected=None):
    def locate():
        for window, location in explorer_windows():
            if normalized(location) != normalized(folder):
                continue
            if selected is not None:
                items = window.Document.SelectedItems()
                paths = [str(items.Item(i).Path) for i in range(items.Count)]
                if len(paths) != 1 or normalized(paths[0]) != normalized(selected):
                    continue
            return window
        return None
    return wait_for(f"Explorer location {folder} and selection {selected}", locate, timeout=35)


def explorer_evidence(window):
    items = window.Document.SelectedItems()
    return {"location_url": str(window.LocationURL), "folder": str(window.Document.Folder.Self.Path),
            "selected_items": [str(items.Item(i).Path) for i in range(items.Count)]}


def close_own_explorers():
    if shell is None or workspace is None:
        return
    prefix = normalized(workspace) + os.sep
    for window, location in explorer_windows():
        if normalized(location).startswith(prefix):
            window.Quit()
    wait_for("own Explorer folders closed", lambda: not any(
        normalized(location).startswith(prefix) for _, location in explorer_windows()), timeout=10)


def clipboard_read():
    try:
        win32clipboard.OpenClipboard(clipboard_owner)
    except Exception:
        return None
    try:
        files = list(win32clipboard.GetClipboardData(CF_HDROP)) if win32clipboard.IsClipboardFormatAvailable(CF_HDROP) else []
        effect = None
        if win32clipboard.IsClipboardFormatAvailable(preferred_drop_effect):
            data = win32clipboard.GetClipboardData(preferred_drop_effect)
            effect = struct.unpack_from("<I", bytes(data))[0]
        formats = []
        number = 0
        while True:
            number = win32clipboard.EnumClipboardFormats(number)
            if not number:
                break
            formats.append(number)
        return {"files": files, "preferred_drop_effect": effect,
                "unicode_text_available": bool(win32clipboard.IsClipboardFormatAvailable(CF_UNICODETEXT)),
                "pixel_format_available": any(win32clipboard.IsClipboardFormatAvailable(value)
                    for value in (CF_DIB, CF_DIBV5, win32clipboard.RegisterClipboardFormat("PNG"))),
                "formats": formats}
    finally:
        win32clipboard.CloseClipboard()


def seed_clipboard(seed_file):
    def write():
        try:
            win32clipboard.OpenClipboard(clipboard_owner)
        except Exception:
            return False
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText("KIRI OLD CLIPBOARD TEXT", CF_UNICODETEXT)
            drop = struct.pack("<IiiII", 20, 0, 0, 0, 1) + (str(seed_file) + "\0\0").encode("utf-16le")
            win32clipboard.SetClipboardData(CF_HDROP, drop)
            win32clipboard.SetClipboardData(preferred_drop_effect, struct.pack("<I", 2))
            return True
        finally:
            win32clipboard.CloseClipboard()
    wait_for("old text and MOVE clipboard seed", write)
    seeded = clipboard_read()
    if not seeded or seeded["preferred_drop_effect"] != 2 or not seeded["unicode_text_available"]:
        raise RuntimeError("Native clipboard sentinel was not seeded")
    report["clipboard_seed"] = seeded


def verify_folder_and_rename(assets):
    phase("Open Folder on extended-length custom library root")
    focus_library()
    find("Settings", kinds=("Button",), scope=library_window).click_input()
    find("Open Folder", kinds=("Button",), scope=library_window, scroll=True).click_input()
    window = explorer_for(root)
    report["open_folder"] = explorer_evidence(window)
    if normalized(window.Document.Folder.Self.Path) != normalized(root):
        raise RuntimeError("Open Folder opened a parent rather than the current library")
    snapshot("current-library-folder")
    report["checks"].append("Open Folder opens the current canonicalized custom library root")
    focus_library()
    find("Library", kinds=("Button",), scope=library_window).click_input()
    find("Search captures", kinds=("Edit",), scope=library_window)
    for asset in assets:
        phase(f"Rename and Show in Folder: {asset['kind']}")
        before = current(asset["id"])
        old_path = root / "Assets" / before["filename"]
        original_hash = digest(old_path)
        extension = old_path.suffix
        title = f"改名 {asset['kind']}, 130{extension}"
        action(before["title"], "Rename")
        field = find(kinds=("Edit",), scope=library_window,
                     predicate=lambda control: control.element_info.name != "Search captures"
                     and control.window_text() != "Search captures")
        snapshot(f"rename-{asset['kind']}-before-input")
        replace_text(field, title)
        snapshot(f"rename-{asset['kind']}-entered")
        keyboard.send_keys("{ENTER}")
        renamed = wait_for("actual file name and persisted title", lambda: (
            item if (item := current(asset["id"]))["title"] == title and item["filename"] == title else None))
        path = root / "Assets" / renamed["filename"]
        if (old_path.exists() or not path.is_file() or digest(path) != original_hash
                or path.suffix != extension or renamed["id"] != before["id"]):
            raise RuntimeError("Rename changed bytes/ID/extension or retained only a display title")
        evidence = {"kind": asset["kind"], "asset_id": renamed["id"],
            "old_filename": before["filename"], "new_filename": renamed["filename"],
            "sha256": original_hash}
        report.setdefault("renames", []).append(evidence)
        asset.update(renamed)
        try:
            action(title, "Show in Folder")
            window = explorer_for(root / "Assets", path)
            evidence["explorer"] = explorer_evidence(window)
        except Exception as error:
            report.setdefault("reveal_errors", []).append({"kind": asset["kind"], "error": str(error)})
            snapshot(f"reveal-{asset['kind']}-failure")
    snapshot("renamed-files-and-selected-item")
    report["checks"].append("All three file types rename the real file while preserving bytes, ID and extension")
    if not report.get("reveal_errors"):
        report["checks"].append("Explorer selects each actual renamed file in the current Assets folder")


def verify_copy(assets, seed_file):
    phase("Image Copy remains clipboard pixels")
    close_own_explorers()
    image = next(asset for asset in assets if asset["kind"] == "image")
    seed_clipboard(seed_file)
    action(image["title"], "Copy")
    wait_for("native image formats without file/text leftovers", lambda: (
        value if (value := clipboard_read()) and value["pixel_format_available"]
        and not value["files"] and not value["unicode_text_available"] else None))
    copied = wait_for("clipboard image", lambda: (
        value if isinstance(value := ImageGrab.grabclipboard(), Image.Image) else None))
    with Image.open(root / "Assets" / image["filename"]) as expected:
        if copied.size != expected.size or ImageChops.difference(copied.convert("RGB"), expected.convert("RGB")).getbbox():
            raise RuntimeError("Image Copy did not preserve the fixture pixels")
    copied.save(output / "image-copy-pixels.png")
    report["image_copy"] = clipboard_read()
    report["checks"].append("Image Copy retains PNG/DIB pixels and clears old file/text formats")
    for asset, label in [(asset, "Copy") for asset in assets if asset["kind"] in ("gif", "video")] + [
            (asset, "Copy File") for asset in assets]:
        phase(f"{asset['kind']} {label}: native file formats and Explorer Ctrl+V")
        folder = workspace / f"paste-{asset['kind']}-{label.replace(' ', '-')}"
        folder.mkdir()
        placeholder = folder / "Kiri paste target.txt"
        placeholder.write_text("Own QA folder focus target", encoding="utf-8")
        seed_clipboard(seed_file)
        action(asset["title"], label)
        source = root / "Assets" / asset["filename"]
        def file_offer():
            value = clipboard_read()
            report["last_clipboard"] = value
            return value if (value and len(value["files"]) == 1
                and normalized(value["files"][0]) == normalized(source)
                and value["preferred_drop_effect"] == 1 and not value["unicode_text_available"]
                and not value["pixel_format_available"]) else None
        offer = wait_for("CF_HDROP + explicit COPY and no old formats", file_offer)
        # Open the paste destination after Copy. An asynchronously opening
        # Explorer window can otherwise steal foreground after set_focus.
        # Shell navigation does not replace the authenticated file offer.
        shell.Explore(str(folder))
        explorer = explorer_for(folder)
        explorer_window = desktop.window(handle=int(explorer.HWND)).wrapper_object()
        explorer_window.set_focus()
        target = find(kinds=("ListItem", "DataItem"), scope=explorer_window,
                      predicate=lambda control: control.window_text().startswith("Kiri paste target"), timeout=20)
        target.click_input()
        expected_hash = digest(source)
        keyboard.send_keys("^v")
        destination = folder / asset["filename"]
        wait_for("Explorer pasted matching bytes", lambda: destination.is_file() and digest(destination) == expected_hash, timeout=40)
        if not source.is_file() or digest(source) != expected_hash:
            raise RuntimeError("Explorer paste moved or changed the source file")
        report.setdefault("file_copies", []).append({"kind": asset["kind"], "action": label,
            "clipboard": offer, "source_preserved": True, "sha256": expected_hash,
            "explorer": explorer_evidence(explorer)})
        snapshot(f"paste-{asset['kind']}-{label.replace(' ', '-')}")
        close_own_explorers()
    report["checks"].append("Image/GIF/video Copy File and existing GIF/video Copy replace text/MOVE with CF_HDROP/COPY; real Explorer paste preserves exact bytes and source files")


def verify_current_root_capture():
    global fixture
    phase("Native global shortcut captures the public Tk window into current root")
    width, height = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    if width < 1024 or height < 650:
        raise RuntimeError("Native capture requires a 1024x650 desktop")
    fixture = subprocess.Popen([sys.executable, str(Path(__file__).with_name(
        "windows-quick-capture-fixture.py")), str(width), str(height)])
    source = wait_for("public Tk window", lambda: next(iter(
        Desktop(backend="win32").windows(process=fixture.pid, visible_only=True)), None))
    source.set_focus()
    wait_for("public source focus", lambda: user32.GetForegroundWindow() == source.handle)
    region = (70, 190, 650, 425)
    before = wait_for("public source paint", lambda: (
        frame if (frame := ImageGrab.grab()).getpixel((80, 200))[:3] == (255, 255, 255) else None))
    expected = before.crop(region).convert("RGB")
    old_ids = {asset["id"] for asset in index()}
    mouse.move(coords=(900, 600))
    keyboard.send_keys("^+a")
    overlay = find("Screenshot", kinds=("Button",)).top_level_parent()
    mouse.press(coords=region[:2])
    mouse.move(coords=region[2:])
    mouse.release(coords=region[2:])
    find("Done — Copy to clipboard · Return", kinds=("Button",))
    keyboard.send_keys("{ENTER}")
    created = wait_for("new capture in current custom library", lambda: [
        asset for asset in index() if asset["id"] not in old_ids])
    if len(created) != 1:
        raise RuntimeError("A capture created duplicate library entries")
    asset = created[0]
    path = root / "Assets" / asset["filename"]
    with Image.open(path) as captured:
        if captured.size != expected.size:
            raise RuntimeError("Capture saved incorrect dimensions in the current root")
        error = sum(ImageStat.Stat(ImageChops.difference(captured.convert("RGB"), expected)).mean) / 3
        if error > 1.5:
            raise RuntimeError(f"Native capture differs from the public pixels: {error}")
        captured.save(output / "capture-current-root.png")
    wait_for("overlay destroyed", lambda: not user32.IsWindow(overlay.handle))
    report["capture"] = {"asset_id": asset["id"], "filename": asset["filename"],
                         "sha256": digest(path), "mean_pixel_error": error, "root": str(root)}
    report["checks"].append("A real global-shortcut capture of public Tk content saves matching pixels in the extended-path custom library")


def make_library(video_directory):
    global root
    root = workspace / "资料库 test, 130" / "Kiri Library"
    root.mkdir(parents=True)
    for name in ("Assets", "Thumbnails", "Annotations", "VideoProjects"):
        (root / name).mkdir()
    sources = sorted(video_directory.rglob("source.mp4")) or sorted(video_directory.rglob("*.mp4"))
    sources = [path for path in sources if path.is_file() and path.stat().st_size > 1024]
    if not sources:
        raise RuntimeError("No retained Rust native MP4 fixture; video clipboard acceptance cannot be claimed")
    image_path = root / "Assets" / "original-image.png"
    image = Image.new("RGB", (160, 100), "#eeeeee")
    image.paste("#111111", (10, 10, 60, 80))
    image.paste("#555555", (90, 30, 150, 70))
    image.save(image_path)
    image.save(root / "Assets" / "original-gif.gif", save_all=True,
               append_images=[Image.new("RGB", image.size, "#222222")], duration=100, loop=0)
    shutil.copyfile(sources[0], root / "Assets" / "original-video.mp4")
    report["video_fixture"] = {"path": str(sources[0]), "sha256": digest(sources[0])}
    assets = [{"id": str(uuid.uuid4()).upper(), "kind": kind,
               "filename": f"original-{kind}.{extension}", "title": f"{kind} file fixture",
               "createdAt": time.time() * 1000 + position, "isFavorite": False,
               "pixelWidth": 320 if kind == "video" else 160,
               "pixelHeight": 180 if kind == "video" else 100,
               **({"duration": 4.0} if kind == "video" else {})}
              for position, (kind, extension) in enumerate((("image", "png"), ("gif", "gif"), ("video", "mp4")))]
    (root / "library.json").write_text(json.dumps(assets), encoding="utf-8")
    identity = {"schemaVersion": 2, "libraryId": str(uuid.uuid4()), "generation": str(uuid.uuid4())}
    (root / ".kiri-library.json").write_text(json.dumps(identity), encoding="utf-8")
    config = Path(app_environment["APPDATA"]) / "io.yuxino.kiri"
    extended_root = str(root.resolve())
    if not extended_root.startswith("\\\\?\\"):
        extended_root = "\\\\?\\" + extended_root
    (config / "library-location.json").write_text(json.dumps({**identity, "root": extended_root}), encoding="utf-8")
    (config / "language.json").write_text(json.dumps("en"), encoding="utf-8")
    report["configured_root"] = extended_root
    return assets


try:
    executable = Path(os.environ["KIRI_LIBRARY_FILES_QA_EXE"]).resolve()
    expected = Path(os.environ["RUNNER_TEMP"]) / "kiri-installed-review" / "kiri.exe"
    if normalized(executable) != normalized(expected) or not executable.is_file() or (executable.parent / "kiri.portable").exists():
        raise RuntimeError("File actions must use this run's formally NSIS-installed executable")
    harness_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    report.update({"source_sha": os.environ.get("KIRI_LIBRARY_FILES_CANDIDATE_SHA") or harness_sha,
                   "harness_sha": harness_sha, "github_sha": os.environ.get("GITHUB_SHA"), "executable": str(executable),
                   "executable_sha256": digest(executable)})
    pythoncom.CoInitialize()
    shell = win32com.client.Dispatch("Shell.Application")
    clipboard_owner = win32gui.CreateWindowEx(0, "STATIC", "Kiri clipboard QA owner", 0,
                                             0, 0, 0, 0, 0, 0, 0, None)
    video_directory = Path(os.environ["KIRI_LIBRARY_FILES_QA_VIDEO_DIR"]).resolve()
    if not normalized(video_directory).startswith(normalized(os.environ["RUNNER_TEMP"]) + os.sep):
        raise RuntimeError("Only this runner's generated native video fixtures may be used")
    with isolated_windows_profile() as app_environment:
        report["isolated_profile"] = True
        with tempfile.TemporaryDirectory(prefix="kiri-library-files-", dir=os.environ["RUNNER_TEMP"]) as temporary:
            workspace = Path(temporary)
            try:
                assets = make_library(video_directory)
                seed_file = workspace / "old clipboard file.txt"
                seed_file.write_text("Old owned clipboard offer", encoding="utf-8")
                launch(executable)
                verify_folder_and_rename(assets)
                verify_copy(assets, seed_file)
                phase("Restart preserves renamed ID, file name, bytes and current root")
                before = index()
                before_hashes = {asset["id"]: digest(root / "Assets" / asset["filename"]) for asset in before}
                stop()
                launch(executable)
                for asset in assets:
                    card(asset["title"])
                if index() != before or any(digest(root / "Assets" / asset["filename"]) != before_hashes[asset["id"]] for asset in index()):
                    raise RuntimeError("Restart changed the renamed files or persisted library metadata")
                report["checks"].append("Restart preserves all renamed IDs, file names, hashes and current library root")
                verify_current_root_capture()
                if report.get("reveal_errors"):
                    raise RuntimeError("Native selected-file reveal failed: " + json.dumps(report["reveal_errors"], ensure_ascii=False))
                report["native_acceptance_success"] = True
            except Exception as error:
                report["acceptance_error"] = str(error)
                snapshot("failure")
                try:
                    report["failure_clipboard"] = clipboard_read()
                    report["failure_explorers"] = [explorer_evidence(window) for window, location in explorer_windows()
                        if normalized(location).startswith(normalized(workspace) + os.sep)]
                except Exception as diagnostic_error:
                    report.setdefault("diagnostic_errors", []).append(str(diagnostic_error))
                raise
            finally:
                cleanup_errors = []
                for cleanup in (stop, close_own_explorers):
                    try:
                        cleanup()
                    except Exception as error:
                        cleanup_errors.append(str(error))
                if fixture:
                    try:
                        fixture.terminate()
                        fixture.wait(timeout=10)
                    except Exception as error:
                        cleanup_errors.append(str(error))
                log = Path(app_environment["LOCALAPPDATA"]) / "io.yuxino.kiri" / "logs" / "kiri.log"
                if log.is_file():
                    shutil.copyfile(log, output / "kiri-native.log")
                if cleanup_errors:
                    report["cleanup_errors"] = cleanup_errors
                    raise RuntimeError("Own processes or Explorer windows did not clean up: " + "; ".join(cleanup_errors))
    report["success"] = True
except Exception as error:
    report["error"] = str(error)
    report["traceback"] = traceback.format_exc()
finally:
    if clipboard_owner:
        win32gui.DestroyWindow(clipboard_owner)
    if shell is not None:
        pythoncom.CoUninitialize()
    (output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

if not report["success"]:
    raise SystemExit(report.get("error", "Windows library file acceptance failed"))
