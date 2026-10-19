"""Isolate only Kiri's directories on a disposable GitHub-hosted desktop."""

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import uuid


def remove_generated_directory(path):
    deadline = time.monotonic() + 20
    while True:
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            # WebView2 can remove a transient cache file after rmtree enumerates
            # it. Finish removing the generated tree before restoring the backup.
            if not path.exists():
                return
            if time.monotonic() >= deadline:
                raise
        except PermissionError as error:
            # taskkill /T has stopped this run's app. WebView2 can still be
            # releasing its cache handles; retry only sharing/lock violations.
            if getattr(error, "winerror", None) not in (32, 33) or time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


def rename_profile_directory(source, destination):
    """Move the whole profile atomically; never fall back to copying live files."""
    deadline = time.monotonic() + 20
    while True:
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"Refusing to replace a profile directory: {destination}")
        try:
            source.rename(destination)
            return
        except OSError as error:
            # A closing WebView may briefly keep a directory handle open.
            # Access denied is also returned for such handles on Windows;
            # permanent ACL errors still fail without touching the source.
            if getattr(error, "winerror", None) not in (5, 32, 33) or time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


@contextmanager
def isolated_app_directories(paths, backup_root):
    paths = tuple(paths)
    for path in paths:
        if (path.is_symlink() or getattr(path, "is_junction", lambda: False)()
                or (path.exists() and not path.is_dir())):
            raise RuntimeError(f"Refusing an unexpected Kiri profile path: {path}")
    resolved = [path.resolve() for path in paths]
    for index, path in enumerate(resolved):
        if (backup_root.resolve().is_relative_to(path)
                or any(path.is_relative_to(other) or other.is_relative_to(path)
                       for other in resolved[index + 1:])):
            raise RuntimeError("Profile isolation paths and recovery metadata must not overlap")
    active = []
    try:
        for index, path in enumerate(paths):
            entry = {"path": path, "holder": None, "backup": None,
                     "journal": None, "saved": False, "created": False}
            active.append(entry)
            if path.exists():
                # RUNNER_TEMP can be on D: while AppData is on C:. A sibling
                # holder keeps this rename on the profile's own volume, even
                # when nested QA contexts isolate the same paths again.
                holder = Path(tempfile.mkdtemp(prefix=f".{path.name}-kiri-qa-", dir=path.parent))
                backup = holder / "original"
                journal = backup_root / f"original-{index}-{holder.name}.json"
                entry.update(holder=holder, backup=backup, journal=journal)
                journal.write_text(json.dumps({"path": str(path), "backup": str(backup)}), encoding="utf-8")
                rename_profile_directory(path, backup)
                entry["saved"] = True
            path.mkdir(parents=True)
            entry["created"] = True
        yield
    finally:
        errors = []
        for entry in reversed(active):
            path, backup = entry["path"], entry["backup"]
            try:
                # Only remove directories this context actually created. A
                # failed setup must never delete the untouched original or a
                # directory another process created before our mkdir.
                if entry["created"] and path.exists():
                    remove_generated_directory(path)
                if entry["saved"]:
                    rename_profile_directory(backup, path)
                if entry["holder"] is not None:
                    entry["holder"].rmdir()
                if entry["journal"] is not None:
                    entry["journal"].unlink(missing_ok=True)
            except Exception as error:
                errors.append(f"{path} (backup: {backup}): {error}")
        if errors:
            # Preserve remaining backups for diagnosis instead of deleting them.
            raise RuntimeError("Could not restore CI Kiri directories: " + "; ".join(errors))


@contextmanager
def isolated_windows_profile():
    # Rust's dirs crate calls SHGetKnownFolderPath rather than reading APPDATA.
    # Get the real paths, then give only Kiri empty directories for this run.
    # Preserve prior QA data and restore it afterward; never redirect OS folders.
    if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("Profile isolation requires a disposable GitHub-hosted Windows runner")

    class GUID(ctypes.Structure):
        _fields_ = [("data1", wintypes.DWORD), ("data2", wintypes.WORD),
                    ("data3", wintypes.WORD), ("data4", ctypes.c_ubyte * 8)]

    shell, ole = ctypes.windll.shell32, ctypes.windll.ole32
    shell.SHGetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), wintypes.DWORD,
                                          wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p)]
    shell.SHGetKnownFolderPath.restype = ctypes.c_long
    ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole.CoTaskMemFree.restype = None

    def get(folder):
        pointer = ctypes.c_void_p()
        result = shell.SHGetKnownFolderPath(ctypes.byref(folder), 0, None, ctypes.byref(pointer))
        try:
            if result != 0:
                raise RuntimeError(f"SHGetKnownFolderPath failed: 0x{result & 0xffffffff:08x}")
            return ctypes.wstring_at(pointer.value)
        finally:
            ole.CoTaskMemFree(pointer)

    root = Path(tempfile.mkdtemp(prefix="kiri-package-native-", dir=os.environ["RUNNER_TEMP"]))
    try:
        environment = dict(os.environ)
        paths = []
        for name, identifier in (
                ("APPDATA", "3eb685db-65f9-4cf6-a03a-e3ef65729f3d"),
                ("LOCALAPPDATA", "f1b32785-6fba-4fcf-9d55-7b8e7f157091")):
            folder = GUID.from_buffer_copy(uuid.UUID(identifier).bytes_le)
            path = Path(get(folder))
            paths.extend((path / "kiri", path / "io.yuxino.kiri"))
            environment[name] = str(path)
        environment["RUST_LOG"] = "info"
        with isolated_app_directories(paths, root):
            yield environment
    finally:
        if not any(root.iterdir()):
            root.rmdir()
