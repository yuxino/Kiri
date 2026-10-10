"""Exercise destructive confirmation WebViews on a disposable Windows CI desktop.

Only generated assets in a temporary managed library can be deleted. The CI
profile's location/language settings are restored after the process exits.
"""

import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import traceback
import uuid

from PIL import Image
from pywinauto import Desktop, keyboard, mouse


if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")

output = Path("confirmation-native-review")
output.mkdir(exist_ok=True)
started = time.monotonic()
report = {"success": False, "checks": [], "phases": []}
desktop = Desktop(backend="uia")
process = None
temporary = None
ctypes.windll.user32.IsHungAppWindow.argtypes = [ctypes.c_void_p]
config = Path(os.environ["APPDATA"]) / "io.yuxino.kiri"
config.mkdir(parents=True, exist_ok=True)
settings = [config / name for name in ("library-location.json", "language.json")]
original = {path: path.read_bytes() if path.exists() else None for path in settings}


def confirmation_executable():
    installed = os.environ.get("KIRI_QA_INSTALLED_EXE")
    executable = Path(installed if installed is not None else "src-tauri/target/release/kiri.exe").resolve()
    if not executable.is_file():
        raise RuntimeError(f"Confirmation QA executable is missing: {executable}")
    source_sha = (os.environ.get("KIRI_LIBRARY_FILES_CANDIDATE_SHA")
                  or os.environ.get("KIRI_COLOR_CANDIDATE_SHA") or os.environ.get("GITHUB_SHA"))
    if not source_sha or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise RuntimeError("Confirmation QA requires the source commit SHA")
    return {"executable": str(executable), "executable_kind": "installed" if installed is not None else "compiled",
            "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
            "source_sha": source_sha, "harness_sha": os.environ.get("GITHUB_SHA")}


def process_status():
    if process is None:
        return {"pid": None, "running": False, "returncode": None}
    try:
        returncode = process.poll()
        return {"pid": process.pid, "running": returncode is None, "returncode": returncode}
    except Exception as error:
        return {"pid": process.pid, "status_error": repr(error)}


def phase(name, **details):
    entry = {"phase": name, "elapsed_seconds": round(time.monotonic() - started, 3),
             "process": process_status(), **details}
    report["phase"] = name
    report["phases"].append(entry)
    # The last action remains available in CI logs if a job is interrupted
    # before the report can be written. This does not introduce UI retries.
    print("CONFIRMATION_PHASE " + json.dumps(entry), flush=True)


def error_details(error):
    return {"type": f"{type(error).__module__}.{type(error).__qualname__}",
            "repr": repr(error), "traceback": traceback.format_exc()}


def find(name, owner=None, timeout=20, predicate=lambda control: True):
    lookup = {"name": name, "dialog_owner": owner is not None, "timeout_seconds": timeout,
              "elapsed_seconds": round(time.monotonic() - started, 3), "found": False}
    report["control_lookup"] = lookup
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Kiri exited: {process.returncode}")
        windows = [owner] if owner else desktop.windows(process=process.pid, visible_only=True)
        for window in windows:
            for control in window.descendants():
                try:
                    if re.fullmatch(name, control.window_text()) and control.is_visible() and control.is_enabled() and predicate(control):
                        lookup["found"] = True
                        return control
                except Exception:
                    pass
        time.sleep(0.1)
    raise RuntimeError(f"Visible control not found: {name}")


def wait_for(predicate, description):
    report["wait"] = {"description": description, "elapsed_seconds": round(time.monotonic() - started, 3),
                      "completed": False}
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Kiri exited while waiting for " + description)
        if predicate():
            report["wait"]["completed"] = True
            return
        time.sleep(0.1)
    raise RuntimeError("Timed out waiting for " + description)


def cancel_dialog(mode, label, window):
    # The library batch bar also has Cancel; target the confirmed dialog.
    phase(f"{label}: find dialog Cancel", mode=mode)
    cancel = find("Cancel", owner=window)
    handle = window.handle
    phase(f"{label}: capture confirmation", handle=handle)
    window.capture_as_image().save(output / f"{label}.png")
    phase(f"{label}: check responsiveness", handle=handle)
    if ctypes.windll.user32.IsHungAppWindow(handle):
        raise RuntimeError("Confirmation window is unresponsive")
    if mode == "Escape":
        phase(f"{label}: focus confirmation", handle=handle)
        window.set_focus()
        phase(f"{label}: press Escape", handle=handle)
        keyboard.send_keys("{ESC}")
    else:
        phase(f"{label}: click Cancel", handle=handle)
        cancel.click_input()
    phase(f"{label}: wait for confirmation close", handle=handle)
    wait_for(lambda: not any(w.handle == handle for w in desktop.windows(
        process=process.pid, visible_only=True)), "confirmation close")
    phase(f"{label}: confirmation closed", handle=handle)


try:
    phase("verify confirmation executable")
    report.update(confirmation_executable())
    phase("prepare disposable fixtures")
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
    phase("launch Kiri")
    process = subprocess.Popen([report["executable"]])
    phase("find library window through Trash navigation")
    library = find("Trash", timeout=35).top_level_parent()
    phase("focus library")
    library.set_focus()
    phase("open Trash")
    find("Trash").click_input()
    phase("snapshot disposable library index")
    index_bytes = (root / "library.json").read_bytes()
    for index, mode in enumerate(["Escape", "Cancel"] * 3):
        phase(f"empty-trash-{index}: click Empty Trash", mode=mode)
        find("Empty Trash").click_input()
        phase(f"empty-trash-{index}: find confirmation", mode=mode)
        dialog = find("Empty Trash\\?").top_level_parent()
        cancel_dialog(mode, f"empty-trash-{index}", dialog)
        phase(f"empty-trash-{index}: verify cancellation preserved fixtures", mode=mode)
        if (root / "library.json").read_bytes() != index_bytes:
            raise RuntimeError("Cancellation changed the library index")
        if any(not (root / "Assets" / asset["filename"]).is_file() for asset in assets):
            raise RuntimeError("Cancellation deleted a fixture")
    report["checks"].append("six repeated empty-trash confirmations render and close; Escape/Cancel preserve all assets")

    phase("single-delete: open disposable asset context menu")
    find("Discard 1", predicate=lambda c: c.rectangle().height() > 150).click_input(button="right")
    phase("single-delete: click Delete Permanently")
    find("Delete Permanently").click_input()
    phase("single-delete: find confirmation")
    dialog = find("Delete this capture permanently\\?").top_level_parent()
    cancel_dialog("Cancel", "single-delete", dialog)
    report["checks"].append("single permanent-delete confirmation opens and cancels")

    phase("batch-delete: locate three disposable trashed assets")
    cards = [find(f"Discard {index}", predicate=lambda c: c.rectangle().height() > 150).rectangle() for index in range(1, 4)]
    end = (max(c.right for c in cards) + 8, max(c.bottom for c in cards) + 8)
    phase("batch-delete: start selection band")
    mouse.press(coords=(min(c.left for c in cards) - 8, min(c.top for c in cards) - 8))
    phase("batch-delete: extend selection band")
    mouse.move(coords=end)
    # pywinauto otherwise moves to (0, 0) before releasing, undoing the band.
    phase("batch-delete: release selection band")
    mouse.release(coords=end)
    phase("batch-delete: click Delete Permanently (3)")
    find(r"Delete Permanently \(3\)").click_input()
    phase("batch-delete: find confirmation")
    dialog = find("Delete these captures permanently\\?").top_level_parent()
    cancel_dialog("Escape", "batch-delete", dialog)
    report["checks"].append("batch permanent-delete confirmation opens and cancels")

    phase("confirmed-empty-trash: open confirmation")
    find("Empty Trash").click_input()
    phase("confirmed-empty-trash: find confirmation")
    dialog = find("Empty Trash\\?").top_level_parent()
    phase("confirmed-empty-trash: click dialog Empty Trash")
    find("Empty Trash", owner=dialog).click_input()
    phase("confirmed-empty-trash: wait for durable deletion")
    wait_for(lambda: len(json.loads((root / "library.json").read_text())) == 1, "durable deletion")
    phase("confirmed-empty-trash: wait for fixture file cleanup")
    wait_for(lambda: all(not (root / "Assets" / asset["filename"]).exists() for asset in assets[1:]), "trash file cleanup")
    phase("confirmed-empty-trash: verify active fixture survived")
    if not (root / "Assets" / assets[0]["filename"]).is_file():
        raise RuntimeError("Empty Trash deleted the active fixture")
    # The navigation group also exposes the name Library; click its button.
    phase("confirmed-empty-trash: return to Library")
    find("Library", predicate=lambda c: c.element_info.control_type == "Button").click_input()
    phase("confirmed-empty-trash: find preserved active fixture")
    find("Keep this image")
    phase("confirmed-empty-trash: capture interactive library")
    library.capture_as_image().save(output / "active-asset-preserved.png")
    report["checks"].append("confirmed empty-trash deletes only trashed fixtures and the library remains interactive")
    phase("all strict confirmation checks completed")
    report["success"] = True
except Exception as error:
    report["error"] = str(error)[:1500]
    report["exception"] = error_details(error)
    report["failure_phase"] = report.get("phase")
    report["failure_elapsed_seconds"] = round(time.monotonic() - started, 3)
    report["failure_process"] = process_status()
    if process and process.poll() is None:
        for index, window in enumerate(desktop.windows(process=process.pid, visible_only=True)):
            try:
                window.capture_as_image().save(output / f"failure-{index}.png")
                controls = [{"name": c.window_text(), "type": c.element_info.control_type,
                             "bounds": str(c.rectangle())} for c in window.descendants()]
                (output / f"failure-{index}.json").write_text(json.dumps(controls, indent=2), encoding="utf-8")
            except Exception as capture_error:
                report.setdefault("diagnostic_errors", []).append({"window_index": index,
                    **error_details(capture_error)})
finally:
    try:
        phase("cleanup: stop Kiri")
        if process and process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            process.wait(timeout=15)
        phase("cleanup: restore CI profile settings")
        for path, data in original.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        phase("cleanup: remove disposable fixture library")
        if temporary:
            temporary.cleanup()
        phase("cleanup: completed")
    except Exception as cleanup_error:
        report["success"] = False
        report["cleanup_exception"] = error_details(cleanup_error)
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["process"] = process_status()
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

if not report["success"]:
    raise SystemExit(report["error"])
