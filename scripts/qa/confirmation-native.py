"""Exercise destructive confirmation WebViews on a disposable Windows CI desktop.

Only generated assets in a temporary managed library can be deleted. The CI
profile's location/language settings are restored after the process exits.
"""

import ctypes
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

from PIL import Image
from pywinauto import Desktop, keyboard, mouse


if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")

output = Path("confirmation-native-review")
output.mkdir(exist_ok=True)
report = {"success": False, "checks": []}
desktop = Desktop(backend="uia")
process = None
temporary = None
ctypes.windll.user32.IsHungAppWindow.argtypes = [ctypes.c_void_p]
config = Path(os.environ["APPDATA"]) / "io.yuxino.kiri"
config.mkdir(parents=True, exist_ok=True)
settings = [config / name for name in ("library-location.json", "language.json")]
original = {path: path.read_bytes() if path.exists() else None for path in settings}


def find(name, owner=None, timeout=20, predicate=lambda control: True):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Kiri exited: {process.returncode}")
        windows = [owner] if owner else desktop.windows(process=process.pid, visible_only=True)
        for window in windows:
            for control in window.descendants():
                try:
                    if re.fullmatch(name, control.window_text()) and control.is_visible() and control.is_enabled() and predicate(control):
                        return control
                except Exception:
                    pass
        time.sleep(0.1)
    raise RuntimeError(f"Visible control not found: {name}")


def wait_for(predicate, description):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Kiri exited while waiting for " + description)
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError("Timed out waiting for " + description)


def cancel_dialog(mode, label, window):
    # The library batch bar also has Cancel; target the confirmed dialog.
    cancel = find("Cancel", owner=window)
    handle = window.handle
    window.capture_as_image().save(output / f"{label}.png")
    if ctypes.windll.user32.IsHungAppWindow(handle):
        raise RuntimeError("Confirmation window is unresponsive")
    if mode == "Escape":
        window.set_focus()
        keyboard.send_keys("{ESC}")
    else:
        cancel.click_input()
    wait_for(lambda: not any(w.handle == handle for w in desktop.windows(
        process=process.pid, visible_only=True)), "confirmation close")


try:
    temporary = tempfile.TemporaryDirectory(prefix="kiri-confirmation-", dir=os.environ["RUNNER_TEMP"])
    root = Path(temporary.name)
    for folder in ("Assets", "Thumbnails", "Annotations", "VideoProjects"):
        (root / folder).mkdir()
    assets = []
    for index in range(4):
        asset_id = str(uuid.uuid4()).upper()
        filename = f"{asset_id}.png"
        Image.new("RGB", (160, 100), (240 - index * 20,) * 3).save(root / "Assets" / filename)
        assets.append({"id": asset_id, "filename": filename, "title": "Keep this image" if index == 0 else f"Discard {index}",
            "kind": "image", "createdAt": time.time() * 1000 + index, "isFavorite": False,
            "pixelWidth": 160, "pixelHeight": 100, "trashedAt": None if index == 0 else time.time() * 1000})
    (root / "library.json").write_text(json.dumps(assets), encoding="utf-8")
    identity = {"schemaVersion": 2, "libraryId": str(uuid.uuid4()), "generation": str(uuid.uuid4())}
    (root / ".kiri-library.json").write_text(json.dumps(identity), encoding="utf-8")
    settings[0].write_text(json.dumps({**identity, "root": str(root)}), encoding="utf-8")
    settings[1].write_text(json.dumps("en"), encoding="utf-8")
    process = subprocess.Popen([str(Path("src-tauri/target/release/kiri.exe").resolve())])
    library = find("Trash", timeout=35).top_level_parent()
    library.set_focus()
    find("Trash").click_input()
    index_bytes = (root / "library.json").read_bytes()
    for index, mode in enumerate(["Escape", "Cancel"] * 3):
        find("Empty Trash").click_input()
        dialog = find("Empty Trash\\?").top_level_parent()
        cancel_dialog(mode, f"empty-trash-{index}", dialog)
        if (root / "library.json").read_bytes() != index_bytes:
            raise RuntimeError("Cancellation changed the library index")
        if any(not (root / "Assets" / asset["filename"]).is_file() for asset in assets):
            raise RuntimeError("Cancellation deleted a fixture")
    report["checks"].append("six repeated empty-trash confirmations render and close; Escape/Cancel preserve all assets")

    find("Discard 1", predicate=lambda c: c.rectangle().height() > 150).click_input(button="right")
    find("Delete Permanently").click_input()
    dialog = find("Delete this capture permanently\\?").top_level_parent()
    cancel_dialog("Cancel", "single-delete", dialog)
    report["checks"].append("single permanent-delete confirmation opens and cancels")

    cards = [find(f"Discard {index}", predicate=lambda c: c.rectangle().height() > 150).rectangle() for index in range(1, 4)]
    end = (max(c.right for c in cards) + 8, max(c.bottom for c in cards) + 8)
    mouse.press(coords=(min(c.left for c in cards) - 8, min(c.top for c in cards) - 8))
    mouse.move(coords=end)
    # pywinauto otherwise moves to (0, 0) before releasing, undoing the band.
    mouse.release(coords=end)
    find(r"Delete Permanently \(3\)").click_input()
    dialog = find("Delete these captures permanently\\?").top_level_parent()
    cancel_dialog("Escape", "batch-delete", dialog)
    report["checks"].append("batch permanent-delete confirmation opens and cancels")

    find("Empty Trash").click_input()
    dialog = find("Empty Trash\\?").top_level_parent()
    find("Empty Trash", owner=dialog).click_input()
    wait_for(lambda: len(json.loads((root / "library.json").read_text())) == 1, "durable deletion")
    wait_for(lambda: all(not (root / "Assets" / asset["filename"]).exists() for asset in assets[1:]), "trash file cleanup")
    if not (root / "Assets" / assets[0]["filename"]).is_file():
        raise RuntimeError("Empty Trash deleted the active fixture")
    # The navigation group also exposes the name Library; click its button.
    find("Library", predicate=lambda c: c.element_info.control_type == "Button").click_input()
    find("Keep this image")
    library.capture_as_image().save(output / "active-asset-preserved.png")
    report["checks"].append("confirmed empty-trash deletes only trashed fixtures and the library remains interactive")
    report["success"] = True
except Exception as error:
    report["error"] = str(error)[:1500]
    if process and process.poll() is None:
        for index, window in enumerate(desktop.windows(process=process.pid, visible_only=True)):
            try:
                window.capture_as_image().save(output / f"failure-{index}.png")
                controls = [{"name": c.window_text(), "type": c.element_info.control_type,
                             "bounds": str(c.rectangle())} for c in window.descendants()]
                (output / f"failure-{index}.json").write_text(json.dumps(controls, indent=2), encoding="utf-8")
            except Exception:
                pass
finally:
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
        process.wait(timeout=15)
    for path, data in original.items():
        if data is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(data)
    if temporary:
        temporary.cleanup()
    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

if not report["success"]:
    raise SystemExit(report["error"])
