"""Temporarily redirect app-data folders on a disposable GitHub-hosted desktop."""

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import shutil
import tempfile
import uuid


@contextmanager
def isolated_windows_profile():
    # Rust's dirs crate calls SHGetKnownFolderPath rather than reading APPDATA.
    # Redirect the current CI user's per-user folders through the matching API,
    # restore them before deleting the fixture, and refuse personal/self-hosted PCs.
    # https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shsetknownfolderpath
    if (os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("Profile redirection requires a disposable GitHub-hosted Windows runner")

    class GUID(ctypes.Structure):
        _fields_ = [("data1", wintypes.DWORD), ("data2", wintypes.WORD),
                    ("data3", wintypes.WORD), ("data4", ctypes.c_ubyte * 8)]

    shell, ole = ctypes.windll.shell32, ctypes.windll.ole32
    shell.SHGetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), wintypes.DWORD,
                                          wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p)]
    shell.SHGetKnownFolderPath.restype = ctypes.c_long
    shell.SHSetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), wintypes.DWORD,
                                          wintypes.HANDLE, wintypes.LPCWSTR]
    shell.SHSetKnownFolderPath.restype = ctypes.c_long
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

    def set_path(folder, path):
        result = shell.SHSetKnownFolderPath(ctypes.byref(folder), 0, None, str(path))
        if result != 0:
            raise RuntimeError(f"SHSetKnownFolderPath failed: 0x{result & 0xffffffff:08x}")
        if os.path.normcase(get(folder)) != os.path.normcase(str(path)):
            raise RuntimeError("Known-folder redirection did not take effect")

    root = Path(tempfile.mkdtemp(prefix="kiri-package-native-", dir=os.environ["RUNNER_TEMP"]))
    redirected = []
    try:
        environment = dict(os.environ)
        for name, child, identifier in (
                ("APPDATA", "roaming", "3eb685db-65f9-4cf6-a03a-e3ef65729f3d"),
                ("LOCALAPPDATA", "local", "f1b32785-6fba-4fcf-9d55-7b8e7f157091")):
            folder = GUID.from_buffer_copy(uuid.UUID(identifier).bytes_le)
            path = root / child
            path.mkdir()
            redirected.append((folder, get(folder)))
            set_path(folder, path)
            environment[name] = str(path)
        environment["RUST_LOG"] = "info"
        yield environment
    finally:
        errors = []
        for folder, original in reversed(redirected):
            try:
                set_path(folder, original)
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("Could not restore CI app-data folders: " + "; ".join(errors))
        shutil.rmtree(root)
