"""Bind a complete native retry to an official, unchanged Windows candidate."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

REPOSITORY = "yuxino/Kiri"
WORKFLOW = ".github/workflows/build.yml"
JOB = "Build and test Windows app (Server 2025)"
BUILD_STEPS = (
    "Run Windows regression and native video export tests",
    "Build Windows acceptance installer",
    "Package and verify portable Windows build",
    "Upload Windows bundle",
)
NATIVE_STEPS = {
    "Verify countdown and recording controls on the actual desktop": "countdown-native.py",
    "Verify configurable shortcuts on the actual desktop": "shortcut-native.py",
    "Verify destructive confirmation windows on the actual desktop": "confirmation-native.py",
    "Install and smoke-test both Windows packages": "windows-release-native.py",
    "Verify hover colors and native clipboard on the installed Windows app": "windows-capture-color-native.py",
}
REQUIRED_NATIVE = ("countdown-native.py", "shortcut-native.py", "windows-release-native.py")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args):
    return subprocess.check_output(args, text=True, encoding="utf-8").strip()


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def validate(run, jobs, run_id, changed_paths):
    require(run.get("id") == run_id and all(run.get(key, {}).get("full_name", "").lower()
            == REPOSITORY.lower() for key in ("repository", "head_repository")),
            "Candidate must belong to the official repository")
    require(run.get("path") == WORKFLOW and run.get("event") == "workflow_dispatch"
            and run.get("status") == "completed" and run.get("run_attempt") == 1
            and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")),
            "Candidate must be a completed, unambiguous first build dispatch")
    windows = [job for job in jobs if job.get("name") == JOB]
    require(len(windows) == 1 and windows[0].get("status") == "completed"
            and windows[0].get("conclusion") in {"success", "failure"},
            "Exactly one completed Windows build job is required")
    steps = {step["name"]: step.get("conclusion") for step in windows[0].get("steps", [])}
    require(all(steps.get(name) == "success" for name in BUILD_STEPS),
            "Candidate Rust tests, installer, portable packaging and bundle upload must pass")
    failed = {name for name, result in steps.items() if result == "failure"}
    require(failed <= NATIVE_STEPS.keys(), "Only known native acceptance steps may have failed")
    unknown_native = {name for name in steps if name.startswith("Verify ")
                      and ("desktop" in name or "Windows app" in name) and name not in NATIVE_STEPS}
    require(not unknown_native, "Unknown original native gates need an explicit replay driver")
    gates = [script for name, script in NATIVE_STEPS.items() if name in steps]
    require(set(REQUIRED_NATIVE) <= set(gates), "Candidate is missing existing native gates")
    require(all(steps[name] in {"success", "failure", "skipped"} for name in NATIVE_STEPS if name in steps),
            "Original native gates must have finished")
    require(all(path.startswith(("scripts/qa/", ".github/workflows/", "docs/qa/")) for path in changed_paths),
            "Candidate application and packaging sources differ from the harness")
    return windows[0], gates


def checkout_sha(log):
    matches = []
    lines = log.splitlines()
    for index, line in enumerate(lines[:-1]):
        if re.fullmatch(r'\S+ \[command\]"[^"\n]+[\\/]git\.exe" log -1 --format=%H', line):
            value = re.fullmatch(r"\S+ ([0-9a-f]{40})", lines[index + 1])
            require(value, "Checkout log must immediately contain a full commit SHA")
            matches.append(value.group(1))
    require(len(matches) == 1, "Expected one actual Windows checkout commit")
    return matches[0]


def artifact_for(run, artifacts, name):
    values = [item for item in artifacts if item.get("name") == name and not item.get("expired")]
    require(len(values) == 1, "Expected one unexpired artifact: " + name)
    artifact = values[0]
    origin = artifact.get("workflow_run", {})
    require(origin.get("id") == run["id"] and origin.get("repository_id") == run["repository"]["id"]
            and origin.get("head_sha") == run["head_sha"]
            and isinstance(artifact.get("digest"), str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]),
            "Artifact origin or archive digest does not match the official candidate")
    return artifact


def extract_verified(archive, directory, expected_digest):
    require("sha256:" + digest(archive) == expected_digest, "Downloaded artifact archive digest mismatch")
    directory.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            parts = Path(member.filename.replace("\\", "/")).parts
            require(parts and not member.filename.startswith(("/", "\\"))
                    and all(part not in {"..", "."} and ":" not in part for part in parts)
                    and (member.external_attr >> 16) & 0o170000 != 0o120000,
                    "Artifact contains an unsafe path or symbolic link")
        bundle.extractall(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=int, required=True)
    args = parser.parse_args()
    require(os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted" and args.run > 0,
            "Use a disposable GitHub-hosted Windows runner and positive run ID")
    api_root = f"repos/{REPOSITORY}/actions/runs/{args.run}"
    run = json.loads(command("gh", "api", api_root))
    jobs = json.loads(command("gh", "api", api_root + "/attempts/1/jobs?per_page=100"))["jobs"]
    # Authenticate metadata before using the API's source SHA in git.
    job, gates = validate(run, jobs, args.run, [])
    source_sha = run["head_sha"]
    subprocess.run(["git", "fetch", "--no-tags", "origin", source_sha], check=True)
    harness_sha = command("git", "rev-parse", "HEAD")
    changes = command("git", "diff", "--name-only", "--no-renames", source_sha, harness_sha).splitlines()
    validate(run, jobs, args.run, changes)
    require(not command("git", "diff", "--name-only", "HEAD"), "Recheck checkout must be clean")
    for gate in gates:
        require(Path("scripts/qa", gate).is_file(), "Missing original native driver: " + gate)
    evidence = Path("windows-native-review")
    evidence.mkdir(exist_ok=True)
    flags = ["--allow-escape-sequences"] if "--allow-escape-sequences" in command("gh", "api", "--help") else []
    log = command("gh", "api", *flags, f"repos/{REPOSITORY}/actions/jobs/{job['id']}/logs")
    require(checkout_sha(log) == source_sha, "Build checkout differs from the dispatch head")
    artifacts = json.loads(command("gh", "api", api_root + "/artifacts?per_page=100"))["artifacts"]
    candidate = Path(os.environ["RUNNER_TEMP"]) / "kiri-native-candidate"
    candidate.mkdir()
    records = {}
    # Legacy failed builds retained the compiled executable here. Future
    # candidates retain the same file together with their installed checksum.
    binary_name = "windows-native-candidate" if any(item["name"] == "windows-native-candidate" for item in artifacts) else "countdown-debug-build"
    for name, folder in (("kiri-windows", "installer"), (binary_name, "compiled")):
        artifact = artifact_for(run, artifacts, name)
        archive = candidate / (folder + ".zip")
        with archive.open("wb") as stream:
            subprocess.run(["gh", "api", *flags, f"repos/{REPOSITORY}/actions/artifacts/{artifact['id']}/zip"],
                           stdout=stream, check=True)
        extract_verified(archive, candidate / folder, artifact["digest"])
        records[folder] = {"id": artifact["id"], "name": name, "archive_digest": artifact["digest"]}
        archive.unlink()
    installers = list((candidate / "installer").rglob("*-setup.exe"))
    binaries = list((candidate / "compiled").rglob("kiri.exe"))
    require(len(installers) == 1 and len(binaries) == 1, "Expected one original installer and compiled executable")
    install = Path(os.environ["RUNNER_TEMP"]) / "kiri-installed-review"
    require(not install.exists(), "Candidate install destination must be fresh")
    subprocess.run([str(installers[0]), "/S", f"/D={install}"], check=True, timeout=120)
    installed = install / "kiri.exe"
    checksum = digest(binaries[0])
    require(installed.is_file() and digest(installed) == checksum,
            "Installed executable differs from the original compiled candidate")
    app = Path("src-tauri/target/release/kiri.exe")
    app.parent.mkdir(parents=True, exist_ok=True)
    require(not app.exists(), "Recheck must not overwrite a local build")
    shutil.copy2(installed, app)
    portable = Path(os.environ["RUNNER_TEMP"]) / "kiri-portable-verify/kiri.exe"
    archives = list((candidate / "installer").rglob("Kiri-*-Windows-x64-Portable.zip"))
    require(len(archives) <= 1, "Candidate contains multiple portable packages")
    if archives:
        extract_verified(archives[0], portable.parent, "sha256:" + digest(archives[0]))
        portable_provenance = "Reused the original portable ZIP from the verified bundle artifact"
    else:
        subprocess.run(["pwsh", "-NoProfile", "-File", "scripts/package-windows-portable.ps1"], check=True)
        portable_provenance = "Repacked from the exact original executable; original ZIP not retained"
    require(digest(portable) == checksum, "Repacked portable executable differs from the candidate")
    manifest = {
        "run_id": args.run, "run_attempt": 1, "source_sha": source_sha, "harness_sha": harness_sha,
        "harness_changes": changes, "executable_sha256": checksum,
        "installer_sha256": digest(installers[0]), "artifacts": records,
        "source_evidence": {"job_id": job["id"], "checkout_sha": source_sha,
                            "job_log_sha256": hashlib.sha256(log.encode()).hexdigest()},
        "native_gates": gates,
        "original_native_results": {name: step["conclusion"] for step in job["steps"]
                                    if (name := step["name"]) in NATIVE_STEPS},
        "portable_provenance": portable_provenance,
    }
    (evidence / "candidate-provenance.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
        env.write(f"KIRI_QA_PORTABLE_EXE={portable}\nKIRI_QA_INSTALLED_EXE={installed}\n"
                  f"KIRI_COLOR_QA_EXE={installed}\nKIRI_COLOR_CANDIDATE_SHA={source_sha}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            output = Path("windows-native-review")
            output.mkdir(exist_ok=True)
            (output / "candidate-error.json").write_text(json.dumps({"success": False, "error": str(error)}, indent=2), encoding="utf-8")
        raise
