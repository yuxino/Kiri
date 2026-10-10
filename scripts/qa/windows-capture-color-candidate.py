"""Bind color QA retries to the exact previously installed CI executable."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

REPOSITORY = "yuxino/Kiri"
WINDOWS_JOB = "Build and test Windows app (Server 2025)"
COLOR_STEP = "Verify hover colors and native clipboard on the installed Windows app"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate(run, jobs, run_id, changed_paths):
    require(run.get("id") == run_id and run.get("repository", {}).get("full_name", "").lower()
            == REPOSITORY.lower() and run.get("head_repository", {}).get("full_name", "").lower()
            == REPOSITORY.lower(), "Candidate must belong to the official repository")
    require(run.get("path") == ".github/workflows/build.yml" and run.get("event") == "workflow_dispatch"
            and run.get("status") == "completed" and re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")),
            "Candidate must be a completed official build dispatch")
    windows = [job for job in jobs if job.get("name") == WINDOWS_JOB]
    require(len(windows) == 1, "Exactly one candidate Windows job is required")
    require(windows[0].get("status") == "completed" and windows[0].get("conclusion") in {"success", "failure"},
            "Candidate Windows job must have finished")
    steps = {step["name"]: step.get("conclusion") for step in windows[0].get("steps", [])}
    require(all(steps.get(name) == "success" for name in (
        "Run Windows regression and native video export tests", "Build Windows acceptance installer",
        "Package and verify portable Windows build", "Verify countdown and recording controls on the actual desktop",
        "Verify configurable shortcuts on the actual desktop", "Install and smoke-test both Windows packages")),
        "Candidate compilation, packages, installation and existing native checks must pass")
    failed = {name for name, conclusion in steps.items() if conclusion == "failure"}
    require(not failed or failed == {COLOR_STEP}, "Only the color QA step may have failed")
    require(steps.get(COLOR_STEP) in {"success", "failure"}, "Candidate must have attempted color QA")
    require(all(path.startswith(("scripts/qa/", ".github/workflows/", "docs/qa/")) for path in changed_paths),
            "Candidate application and packaging sources differ from the harness")


def command(*args):
    return subprocess.check_output(args, text=True, encoding="utf-8").strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=int)
    args = parser.parse_args()
    require(os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true" and args.run > 0,
            "Use an isolated Windows CI runner and a positive candidate run ID")
    root = f"repos/{REPOSITORY}/actions/runs/{args.run}"
    run = json.loads(command("gh", "api", root))
    jobs = json.loads(command("gh", "api", root + "/jobs?per_page=100"))["jobs"]
    source_sha = run.get("head_sha", "")
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha), "Invalid candidate source SHA")
    subprocess.run(["git", "fetch", "--no-tags", "origin", source_sha], check=True)
    changes = command("git", "diff", "--name-only", source_sha, "HEAD").splitlines()
    validate(run, jobs, args.run, changes)
    candidate = Path(os.environ["RUNNER_TEMP"]) / "kiri-color-candidate"
    candidate.mkdir()
    for artifact, subdir in (("countdown-debug-build", "binary"), ("windows-capture-color-review", "review")):
        subprocess.run(["gh", "run", "download", str(args.run), "--repo", REPOSITORY,
                        "--name", artifact, "--dir", str(candidate / subdir)], check=True)
    previous = json.loads((candidate / "review/report.json").read_text(encoding="utf-8-sig"))
    executables = list((candidate / "binary").rglob("kiri.exe"))
    require(len(executables) == 1 and not executables[0].is_symlink(), "Exactly one candidate executable is required")
    checksum = hashlib.sha256(executables[0].read_bytes()).hexdigest()
    require(previous.get("source_sha") == source_sha and previous.get("executable_sha256") == checksum,
            "Candidate bytes do not match the previously installed color QA executable")
    target = Path(os.environ["RUNNER_TEMP"]) / "kiri-installed-review/kiri.exe"
    target.parent.mkdir()
    shutil.copy2(executables[0], target)
    output = Path("windows-capture-color-review")
    output.mkdir(exist_ok=True)
    (output / "candidate-provenance.json").write_text(json.dumps({
        "run_id": args.run, "source_sha": source_sha, "harness_sha": command("git", "rev-parse", "HEAD"),
        "harness_changes": changes, "executable_sha256": checksum,
        "previous_color_qa_error": previous.get("error"),
        "package_install_and_existing_native_checks": "success",
    }, indent=2), encoding="utf-8")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
        env.write(f"KIRI_COLOR_QA_EXE={target}\nKIRI_COLOR_CANDIDATE_SHA={source_sha}\n")


if __name__ == "__main__":
    main()
