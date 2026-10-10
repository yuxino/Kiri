"""Isolate only Kiri's directories on a disposable GitHub-hosted desktop."""

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import shutil
import tempfile
import uuid


@contextmanager
def isolated_app_directories(paths, backup_root):
    for path in paths:
        if (path.is_symlink() or getattr(path, "is_junction", lambda: False)()
                or (path.exists() and not path.is_dir())):
            raise RuntimeError(f"Refusing an unexpected Kiri profile path: {path}")
    active = []
    try:
        for index, path in enumerate(paths):
            backup = backup_root / f"original-{index}" if path.exists() else None
            if backup is not None:
                shutil.move(str(path), str(backup))
            active.append((path, backup))
            path.mkdir(parents=True)
        yield
    finally:
        errors = []
        for path, backup in reversed(active):
            try:
                if path.exists():
                    shutil.rmtree(path)
                if backup is not None:
                    shutil.move(str(backup), str(path))
            except Exception as error:
                errors.append(str(error))
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
