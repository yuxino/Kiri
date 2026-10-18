#!/usr/bin/env python3
"""Attach one verified Linux candidate to an existing draft, without replacing assets."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode


OFFICIAL_REPOSITORY = "yuxino/kiri"
BUILD_WORKFLOW = ".github/workflows/build.yml"
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=False)
    require(result.returncode == 0, f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def validate_inputs(tag, run_id):
    require(isinstance(tag, str) and TAG.fullmatch(tag),
            "Release tag must be vMAJOR.MINOR.PATCH without leading zeroes")
    require(isinstance(run_id, str) and re.fullmatch(r"[1-9][0-9]*", run_id),
            "Candidate run ID must be a positive integer")
    return tag[1:], int(run_id)


def github_api(endpoint, upload=None):
    args = ["gh", "api", "--method", "POST" if upload else "GET", endpoint]
    if upload:
        content_type = "application/json" if upload.name == "provenance.json" else "application/vnd.debian.binary-package"
        args += ["--header", f"Content-Type: {content_type}", "--input", str(upload)]
    return json.loads(command(*args))


def all_pages(endpoint, api=github_api):
    items = []
    for page in range(1, 101):
        result = api(f"{endpoint}?per_page=100&page={page}")
        require(isinstance(result, list), "Expected a paginated GitHub list")
        items.extend(result)
        if len(result) < 100:
            return items
    raise RuntimeError("GitHub list exceeded the pagination limit")


def release_tag_sha(repository, tag, api=github_api):
    result = api(f"repos/{repository}/git/ref/tags/{tag}")
    require(result.get("ref") == f"refs/tags/{tag}", "Remote reference is not the exact release tag")
    seen = set()
    for _ in range(8):
        target = result.get("object", {})
        sha = target.get("sha")
        require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid tag object SHA")
        if target.get("type") == "commit":
            return sha
        require(target.get("type") == "tag" and sha not in seen, "Invalid or cyclic annotated tag")
        seen.add(sha)
        result = api(f"repos/{repository}/git/tags/{sha}")
    raise RuntimeError("Annotated release tag exceeds the nesting limit")


def validate_run(run, repository, run_id, tag, source_sha):
    require(run.get("id") == run_id
            and run.get("repository", {}).get("full_name", "").lower() == repository.lower()
            and run.get("head_repository", {}).get("full_name", "").lower() == repository.lower(),
            "Candidate must belong to the official repository")
    require(run.get("path") == BUILD_WORKFLOW and run.get("event") == "push"
            and run.get("head_branch") == tag and run.get("head_sha") == source_sha,
            "Candidate must be the exact release tag's build.yml push run")
    require(run.get("status") == "completed" and run.get("conclusion") == "success",
            "Candidate build run must be complete and successful")


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def candidate_files(directory, version):
    filename = f"kiri_{version}_amd64.deb"
    paths = sorted(directory.iterdir())
    require({path.name for path in paths} == {filename, "provenance.json"},
            "Candidate must contain only the matching Debian package and original provenance.json")
    require(all(path.is_file() and not path.is_symlink() for path in paths),
            "Candidate entries must be regular files, without symlinks")
    return {path.name: {"path": path, "size": path.stat().st_size,
                        "digest": "sha256:" + digest(path)} for path in paths}


def validate_deb(path, version):
    for field, expected in (("Package", "kiri"), ("Version", version), ("Architecture", "amd64")):
        require(command("dpkg-deb", "--field", str(path), field) == expected,
                f"Debian {field} does not match the release")


def verify_candidate(args, repository, version, run_id, api=github_api):
    source = args.source_dir.resolve()
    directory = args.package_dir.resolve()
    files = candidate_files(directory, version)
    source_sha = command("git", "rev-parse", "HEAD", cwd=source)
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha), "Invalid source commit")
    require(command("git", "rev-parse", f"refs/tags/{args.tag}^{{commit}}", cwd=source) == source_sha,
            "Source checkout is not the requested release tag")
    require(release_tag_sha(repository, args.tag, api) == source_sha,
            "Remote release tag does not match the source checkout")
    run = api(f"repos/{repository}/actions/runs/{run_id}")
    validate_run(run, repository, run_id, args.tag, source_sha)
    command("node", str(source / "scripts/release-version.mjs"), args.tag, cwd=source)
    # The tagged helper checks the original artifact, its recorded attempt's
    # successful Linux job, and the exact package bytes. Never substitute the
    # newer tooling checkout for the tagged application source.
    command(sys.executable, str(source / "scripts/qa/linux-package-provenance.py"),
            "verify", "--package-dir", str(directory), "--run-id", str(run_id),
            "--output", str(args.evidence.resolve()), cwd=source)
    evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
    require(evidence.get("verified") is True
            and evidence.get("candidate", {}).get("source_sha") == source_sha,
            "Verified candidate source must exactly equal the release tag")
    validate_deb(files[f"kiri_{version}_amd64.deb"]["path"], version)
    return source_sha, files


def unique_draft(repository, tag, api=github_api):
    releases = [release for release in all_pages(f"repos/{repository}/releases", api)
                if release.get("tag_name") == tag]
    require(len(releases) == 1, "Expected exactly one existing release for the tag")
    release = releases[0]
    require(release.get("draft") is True and release.get("published_at") is None,
            "Release must still be an unpublished draft")
    require(type(release.get("id")) is int and release["id"] > 0, "Invalid release ID")
    return release


def upload_plan(files, assets):
    pending = []
    for name, local in files.items():
        existing = [asset for asset in assets if asset.get("name") == name]
        require(len(existing) <= 1, f"Duplicate release asset: {name}")
        if not existing:
            pending.append(name)
            continue
        asset = existing[0]
        require(asset.get("state") == "uploaded" and asset.get("size") == local["size"]
                and asset.get("digest") == local["digest"],
                f"Existing asset conflicts with verified candidate: {name}")
    return pending


def attach_files(repository, tag, source_sha, files, api=github_api):
    release_id = unique_draft(repository, tag, api)["id"]
    while True:
        # Preflight both files before the first upload, and repeat before each
        # mutation. Missing assets may be added; existing bytes are never replaced.
        release = unique_draft(repository, tag, api)
        require(release["id"] == release_id, "Draft release identity changed")
        require(release_tag_sha(repository, tag, api) == source_sha,
                "Release tag changed before attachment")
        assets = all_pages(f"repos/{repository}/releases/{release_id}/assets", api)
        pending = upload_plan(files, assets)
        if not pending:
            print(f"Verified draft release {tag}: both original Linux assets are attached")
            return
        name = pending[0]
        uploaded = api(f"https://uploads.github.com/repos/{repository}/releases/{release_id}/assets?"
                       + urlencode({"name": name}), upload=files[name]["path"])
        require(uploaded.get("name") == name, "Uploaded asset name does not match")
        # The next pass independently re-reads the draft and all asset digests.
        upload_plan({name: files[name]}, [uploaded])
        print(f"Attached {name} to existing draft {tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--validate-inputs-only", action="store_true")
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--package-dir", type=Path)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    version, run_id = validate_inputs(args.tag, args.run)
    if args.validate_inputs_only:
        print(f"Validated release tag {args.tag} and candidate run {run_id}")
        return
    require(args.source_dir and args.package_dir and args.evidence, "Source, package and evidence paths are required")
    repository = os.environ["GITHUB_REPOSITORY"]
    require(repository.lower() == OFFICIAL_REPOSITORY, "Attachments are restricted to the official repository")
    source_sha, files = verify_candidate(args, repository, version, run_id)
    attach_files(repository, args.tag, source_sha, files)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        print(f"Linux release attachment refused: {error}", file=sys.stderr)
        sys.exit(1)
