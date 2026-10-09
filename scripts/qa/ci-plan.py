#!/usr/bin/env python3
"""Select checks/packages without changing package provenance or release policy."""
import json
import os
from pathlib import Path
import re
import subprocess


PROFILES = {"quick", "linux", "linux-package", "windows", "macos", "release", "full", "recheck-linux", "recheck-linux-x11"}
TARGET_PREFIXES = {
    "linux": ("src-tauri/src/capture/linux", "src-tauri/src/platform/linux", "src-tauri/src/linux_media"),
    "windows": ("src-tauri/src/capture/windows", "src-tauri/src/platform/windows"),
    "macos": ("src-tauri/src/capture/macos", "src-tauri/src/platform/macos", "src-tauri/src/macos_media"),
}


def plan(event, ref, inputs, paths, labels=()):
    selected = {key: False for key in (
        "renderer", "native_linux", "native_windows", "native_macos",
        "package_linux", "package_windows", "package_macos", "linux_x11", "wayland", "x11_recheck")}
    profile = "quick"
    if event == "workflow_dispatch":
        profile = inputs.get("profile") or "quick"
        candidate = inputs.get("linux_candidate_run_id") or ""
        if profile not in PROFILES:
            raise ValueError("Unknown CI profile")
        if candidate:
            if not re.fullmatch(r"[1-9][0-9]*", candidate):
                raise ValueError("Candidate run ID must be a positive integer")
            if profile not in {"quick", "recheck-linux", "recheck-linux-x11"}:
                raise ValueError("Choose recheck-linux when reusing a candidate")
            if profile != "recheck-linux-x11":
                profile = "recheck-linux"  # Preserve the old run-ID-only dispatch.
        if profile in {"recheck-linux", "recheck-linux-x11"} and not candidate:
            raise ValueError("recheck-linux needs a completed candidate run ID")
    elif event == "push" and ref.startswith("refs/tags/v"):
        # Release packaging does not authorize configuring a Linux desktop.
        # Keep all source/package checks; desktop acceptance remains explicit.
        profile = "release"

    if profile == "recheck-linux-x11":
        selected["x11_recheck"] = True
    elif profile == "recheck-linux":
        selected["wayland"] = True
    elif profile in {"full", "release", "linux", "linux-package", "windows", "macos"}:
        selected["renderer"] = True
        for target in TARGET_PREFIXES:
            chosen = profile in {"full", "release", target} or (profile == "linux-package" and target == "linux")
            selected[f"native_{target}"] = chosen
            selected[f"package_{target}"] = chosen
        selected["linux_x11"] = selected["package_linux"] and profile not in {"linux-package", "release"}
        selected["wayland"] = selected["linux_x11"]
    elif event == "workflow_dispatch" or paths is None:
        # Unknown diff or explicit quick checks fail closed to all native tests,
        # but do not unexpectedly create release-mode packages.
        selected["renderer"] = True
        for target in TARGET_PREFIXES:
            selected[f"native_{target}"] = True
    else:
        for path in paths:
            if path.startswith("scripts/qa/ipc-lifetime/"):
                selected["native_linux"] = True
            if (path.startswith("src/") or path in {"package.json", "pnpm-lock.yaml", "index.html"}
                    or path.startswith(("vite.config.", "tsconfig"))
                    or (path.startswith("docs/demos/") and path.endswith((".py", ".js", ".html")))):
                selected["renderer"] = True
            if path.startswith("src-tauri/"):
                targets = [target for target, prefixes in TARGET_PREFIXES.items()
                           if any(path.startswith(prefix + "/") or path in
                                  {prefix + suffix for suffix in (".rs", ".m", ".h")}
                                  for prefix in prefixes)]
                for target in targets or TARGET_PREFIXES:
                    selected[f"native_{target}"] = True
    if event == "pull_request" and "ci:linux-package" in labels:
        # This opt-in adds packaging without suppressing diff-selected checks.
        # It never starts a desktop, changes GNOME settings, or grants a portal.
        selected["native_linux"] = True
        selected["package_linux"] = True
    return {"profile": profile, **{key: str(value).lower() for key, value in selected.items()}}


def changed_paths(event, payload):
    base = payload.get("pull_request", {}).get("base", {}).get("sha") if event == "pull_request" else payload.get("before")
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{40}", base) or base == "0" * 40:
        return None
    # A depth-2 merge checkout can omit the event's original base after main
    # advances. Fetch that exact commit instead of turning a known diff into
    # the fallback that schedules every native platform.
    available = subprocess.run(["git", "cat-file", "-e", base + "^{commit}"],
                               capture_output=True, check=False)
    if available.returncode:
        try:
            fetched = subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", base],
                                     capture_output=True, check=False, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if fetched.returncode:
            return None
    result = subprocess.run(["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"],
                            capture_output=True, check=False)
    if result.returncode:
        return None
    return [path for path in result.stdout.decode("utf-8").split("\0") if path]


def check_results(needs):
    planner = needs.get("plan", {})
    failures = []
    if planner.get("result") != "success":
        failures.append("plan")
    flags = planner.get("outputs", {})
    if any(flags.get(key) not in {"true", "false"} for key in (
            "renderer", "native_linux", "native_windows", "native_macos",
            "package_linux", "package_windows", "package_macos", "linux_x11", "wayland", "x11_recheck")):
        failures.append("plan outputs")
    expected = {"fast-checks": True, "countdown-ui": flags.get("renderer") == "true",
                "test-rust": flags.get("native_macos") == "true",
                "build-linux": flags.get("native_linux") == "true",
                "build-windows": flags.get("native_windows") == "true",
                "build-macos": flags.get("native_macos") == "true",
                "test-linux-wayland": flags.get("wayland") == "true",
                "recheck-linux-x11": flags.get("x11_recheck") == "true"}
    for job, enabled in expected.items():
        if needs.get(job, {}).get("result") != ("success" if enabled else "skipped"):
            failures.append(job)
    return failures


def main():
    if os.environ.get("KIRI_CI_CHECK_RESULTS"):
        failures = check_results(json.loads(os.environ["KIRI_CI_CHECK_RESULTS"]))
        if failures:
            raise SystemExit("Required CI jobs did not match the plan: " + ", ".join(failures))
        return
    event = os.environ["GITHUB_EVENT_NAME"]
    payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    labels = [label.get("name") for label in payload.get("pull_request", {}).get("labels", [])]
    result = plan(event, os.environ["GITHUB_REF"], payload.get("inputs") or {},
                  changed_paths(event, payload), labels)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in result.items()))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
        stream.write("### CI plan\n\n```json\n" + json.dumps(result, indent=2) + "\n```\n")
        if result["package_linux"] == "true" and result["linux_x11"] == "false":
            stream.write("\nLinux package build/install/inspection only. "
                         "X11 and GNOME Wayland desktop acceptance are not selected.\n")


if __name__ == "__main__":
    main()
