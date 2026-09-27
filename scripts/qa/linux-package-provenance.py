#!/usr/bin/env python3
"""Bind Linux desktop QA to a built package and its actual checkout commit."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


WORKFLOW = ".github/workflows/build.yml"
BUILD_JOB = "Build, test and package Linux (Ubuntu 24.04 / X11)"
ARTIFACT = "kiri-linux-deb"
SHA = re.compile(r"[0-9a-f]{40}")
ALLOWED_FILES = {
    WORKFLOW, "AGENTS.md", "README.md", "README_ZH.md", "ROADMAP.md",
    "CONTRIBUTING.md", "PRIVACY.md", "SECURITY.md",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    require(result.returncode == 0, f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout


def api(path, raw=False):
    result = command("gh", "api", "--method", "GET", path)
    return result if raw else json.loads(result)


def api_items(path, key):
    items = []
    for page in range(1, 101):
        response = api(f"{path}?per_page=100&page={page}")
        items.extend(response[key])
        if len(response[key]) < 100:
            return items
    raise RuntimeError(f"Too many pages from {path}")


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def package_details(directory):
    packages = list(directory.glob("*.deb"))
    require(len(packages) == 1 and packages[0].is_file(), "Expected exactly one Debian package")
    return {"filename": packages[0].name, "sha256": digest(packages[0])}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def allowed_change(path):
    return (path in ALLOWED_FILES or path.startswith("scripts/qa/")
            or (path.startswith("docs/") and path.endswith(".md")))


def changed_files(*revisions):
    return [p for p in command("git", "diff", "--name-only", "--no-renames", "-z", *revisions, "--").split("\0") if p]


def check_sources(candidate_sha, harness_sha):
    require(isinstance(candidate_sha, str) and SHA.fullmatch(candidate_sha), "Invalid candidate source SHA")
    if subprocess.run(["git", "cat-file", "-e", f"{candidate_sha}^{{commit}}"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        command("git", "fetch", "--no-tags", "--depth=1", "origin", candidate_sha)
    changes = changed_files(candidate_sha, harness_sha)
    blocked = [p for p in changes if not allowed_change(p)]
    require(not blocked, "Candidate application/build sources differ: " + ", ".join(blocked))
    dirty = changed_files("HEAD")
    require(all(allowed_change(p) for p in dirty), "Application/build sources have uncommitted changes")
    return {"allowed_changes": changes, "harness_worktree_changes": dirty}


def checkout_from_log(log):
    # Only accept checkout's command followed immediately by its full SHA.
    # The API run head_sha is the PR head, not actions/checkout's merge commit.
    lines = log.splitlines()
    matches = []
    for index, line in enumerate(lines[:-1]):
        if re.fullmatch(r"\S+ \[command\]/\S*/git log -1 --format=%H", line):
            match = re.fullmatch(r"\S+ ([0-9a-f]{40})", lines[index + 1])
            require(match, "Checkout log does not contain an immediate full commit SHA")
            matches.append((match.group(1), "\n".join(lines[index:index + 2]) + "\n"))
    require(len(matches) == 1, "Expected one unambiguous checkout SHA in the official build job log")
    return matches[0]


def write_manifest(args):
    dirty = changed_files("HEAD")
    require(all(allowed_change(p) for p in dirty), "Cannot label a build with modified application sources")
    manifest = {
        "schema_version": 1,
        "repository": os.environ["GITHUB_REPOSITORY"],
        "workflow_path": WORKFLOW,
        "run_id": int(os.environ["GITHUB_RUN_ID"]),
        "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "source_sha": command("git", "rev-parse", "HEAD").strip(),
        "package": package_details(args.package_dir),
    }
    write_json(args.package_dir / "provenance.json", manifest)
    print(json.dumps(manifest, indent=2))


def verify(args, evidence):
    require(re.fullmatch(r"[1-9][0-9]*", args.run_id), "Run ID must be a positive integer")
    repository = os.environ["GITHUB_REPOSITORY"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid repository")
    reused = os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    require(reused or args.run_id == os.environ["GITHUB_RUN_ID"], "Automatic checks must use their own package")
    root = f"repos/{repository}/actions"
    run = api(f"{root}/runs/{args.run_id}")
    require(run["repository"]["full_name"] == repository and run["path"] == WORKFLOW,
            "Candidate must belong to this repository's build.yml")
    if reused:
        require(run["status"] == "completed", "Candidate build run has not completed")
        require(run["head_repository"]["full_name"] == repository, "Cannot reuse a fork's candidate")
    jobs = api_items(f"{root}/runs/{args.run_id}/attempts/{run['run_attempt']}/jobs", "jobs")
    builds = [job for job in jobs if job["name"] == BUILD_JOB]
    require(len(builds) == 1, "Expected exactly one Linux build job in the candidate run attempt")
    job = builds[0]
    require(job["status"] == "completed", "Linux build job has not completed")
    if reused:
        require(job["conclusion"] == "success", "Reused candidate's Linux build job must have succeeded")
    # Automatic runs retain their previous behavior: a built package can still
    # receive Wayland checks when the separate X11 acceptance step fails.
    require(any(step["name"] == "Build Debian package without updater signing"
                and step["conclusion"] == "success" for step in job["steps"]),
            "Candidate's Debian packaging step did not succeed")
    artifacts = api_items(f"{root}/runs/{args.run_id}/artifacts", "artifacts")
    candidates = [a for a in artifacts if a["name"] == ARTIFACT and not a["expired"]]
    require(len(candidates) == 1, "Expected one unexpired kiri-linux-deb artifact")
    artifact = candidates[0]
    origin = artifact["workflow_run"]
    require(origin["id"] == int(args.run_id)
            and origin["repository_id"] == run["repository"]["id"]
            and origin["head_sha"] == run["head_sha"], "Artifact source does not match the candidate run")
    evidence.update({
        "repository": repository,
        "reused_package": reused,
        "candidate": {
            "run_id": run["id"], "run_attempt": run["run_attempt"], "run_url": run["html_url"],
            "run_head_sha": run["head_sha"], "build_job_id": job["id"], "build_job_url": job["html_url"],
            "artifact_id": artifact["id"], "artifact_name": ARTIFACT, "artifact_digest": artifact.get("digest"),
        },
        "package": package_details(args.package_dir),
        "harness": {
            "source_sha": command("git", "rev-parse", "HEAD").strip(),
            "run_id": int(os.environ["GITHUB_RUN_ID"]),
            "ref": os.environ.get("GITHUB_REF"),
        },
    })
    manifest_path = args.package_dir / "provenance.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        require(manifest["schema_version"] == 1 and manifest["repository"] == repository
                and manifest["workflow_path"] == WORKFLOW and manifest["run_id"] == run["id"]
                and manifest["run_attempt"] == run["run_attempt"], "Package provenance identity does not match its run")
        require(manifest["package"] == evidence["package"], "Package does not match its recorded filename/checksum")
        candidate_sha = manifest["source_sha"]
        evidence["candidate"]["source_evidence"] = {"kind": "artifact-manifest", "manifest": manifest}
    else:
        require(reused, "New Linux packages must contain provenance.json")
        log = api(f"{root}/jobs/{job['id']}/logs", raw=True)
        candidate_sha, excerpt = checkout_from_log(log)
        log_path = args.output.parent / "candidate-checkout-log.txt"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(excerpt, encoding="utf-8")
        evidence["candidate"]["source_evidence"] = {
            "kind": "official-build-job-checkout-log", "job_id": job["id"],
            "api_url": f"https://api.github.com/{root}/jobs/{job['id']}/logs",
            "log_sha256": hashlib.sha256(log.encode()).hexdigest(), "excerpt_file": log_path.name,
        }
    evidence["candidate"]["source_sha"] = candidate_sha
    evidence["source_comparison"] = check_sources(candidate_sha, evidence["harness"]["source_sha"])
    workflow_diff = command("git", "diff", "--no-ext-diff", "--no-renames", candidate_sha,
                            evidence["harness"]["source_sha"], "--", WORKFLOW)
    workflow_path = args.output.parent / "candidate-workflow.diff"
    workflow_path.parent.mkdir(parents=True, exist_ok=True)
    workflow_path.write_text(workflow_diff, encoding="utf-8")
    evidence["source_comparison"]["workflow_diff_file"] = workflow_path.name
    evidence["source_comparison"]["workflow_diff_sha256"] = digest(workflow_path)
    # Read raw commit headers so this also works at a shallow checkout boundary.
    parents = re.findall(r"^parent ([0-9a-f]{40})$",
                         command("git", "cat-file", "-p", candidate_sha).split("\n\n", 1)[0], re.M)
    require(candidate_sha == run["head_sha"] or
            (run["event"] == "pull_request" and run["head_sha"] in parents),
            "Built commit is neither the run head nor its PR merge commit")
    evidence["verified"] = True
    mode = "Reused original package; no application rebuild" if reused else "Package built in this workflow run"
    message = (f"{mode}\n"
               f"Verified Linux candidate {candidate_sha} from run {run['id']} / artifact {artifact['id']}\n"
               f"Harness commit: {evidence['harness']['source_sha']}\n"
               f"Debian package SHA-256: {evidence['package']['sha256']}\n")
    print(message)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write("```text\n" + message + "```\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write")
    write.add_argument("--package-dir", type=Path, required=True)
    check = commands.add_parser("verify")
    check.add_argument("--package-dir", type=Path, required=True)
    check.add_argument("--run-id", required=True)
    check.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    evidence = {"schema_version": 1, "verified": False}
    try:
        if args.command == "write":
            write_manifest(args)
        else:
            verify(args, evidence)
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        evidence["error"] = str(error)
        print(f"Linux package provenance check failed: {error}", file=sys.stderr)
        return 1
    finally:
        if args.command == "verify":
            write_json(args.output, evidence)
    return 0


if __name__ == "__main__":
    sys.exit(main())
