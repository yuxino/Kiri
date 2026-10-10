"""Replay every original native gate on the exact installed Windows candidate."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from windows_qa_profile import isolated_windows_profile

output = Path("windows-native-review")
manifest = json.loads((output / "candidate-provenance.json").read_text(encoding="utf-8"))
report = {"success": False, "source_sha": manifest["source_sha"],
          "executable_sha256": manifest["executable_sha256"],
          "compiled_executable_sha256": manifest["compiled_executable_sha256"],
          "compiled_matches_installed": manifest["compiled_matches_installed"], "gates": []}
timeouts = {"countdown-native.py": 240, "shortcut-native.py": 180,
            "confirmation-native.py": 180, "windows-release-native.py": 480,
            "windows-capture-color-native.py": 240, "windows-library-files-native.py": 600}


def replay(gate):
    process = subprocess.Popen([sys.executable, str(Path("scripts/qa") / gate)])
    try:
        code = process.wait(timeout=timeouts[gate])
    except subprocess.TimeoutExpired:
        # Kill only this driver's process tree; never other CI apps/WebViews.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
        process.wait(timeout=20)
        raise
    if code:
        raise RuntimeError(f"{gate} exited with {code}")

try:
    for gate in manifest["native_gates"]:
        result = {"script": gate, "success": False}
        report["gates"].append(result)
        try:
            if gate not in timeouts:
                raise RuntimeError("Unknown original native gate: " + gate)
            for app, expected in ((Path("src-tauri/target/release/kiri.exe"), manifest["compiled_executable_sha256"]),
                                  (Path(os.environ["KIRI_QA_INSTALLED_EXE"]), manifest["executable_sha256"]),
                                  (Path(os.environ["KIRI_QA_PORTABLE_EXE"]), manifest["compiled_executable_sha256"])):
                if hashlib.sha256(app.read_bytes()).hexdigest() != expected:
                    raise RuntimeError("Candidate executable changed before native QA")
            # Each gate gets fresh app-only directories and restores prior
            # CI data afterward. A failed gate does not suppress later gates.
            with isolated_windows_profile():
                replay(gate)
            result["success"] = True
        except Exception as error:
            result["error"] = str(error)
    report["success"] = bool(report["gates"]) and all(gate["success"] for gate in report["gates"])
finally:
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
if not report["success"]:
    raise SystemExit("Original native gates failed: " + ", ".join(
        gate["script"] for gate in report["gates"] if not gate["success"]))
