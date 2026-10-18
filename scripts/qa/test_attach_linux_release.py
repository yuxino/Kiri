#!/usr/bin/env python3
"""Reject wrong-source packages and release mutations outside the existing draft."""

import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("attach_linux", Path(__file__).with_name("attach-linux-release.py"))
attach = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attach)


class AttachmentGuards(unittest.TestCase):
    def setUp(self):
        self.repository = "yuxino/Kiri"
        self.tag = "v1.6.24"
        self.sha = "a" * 40
        self.run = {"id": 123, "repository": {"full_name": self.repository},
                    "head_repository": {"full_name": self.repository},
                    "path": attach.BUILD_WORKFLOW, "event": "push", "head_branch": self.tag,
                    "head_sha": self.sha, "status": "completed", "conclusion": "success"}
        self.draft = {"id": 55, "tag_name": self.tag, "draft": True, "published_at": None}
        self.tag_ref = {"ref": "refs/tags/" + self.tag, "object": {"type": "commit", "sha": self.sha}}
        self.files = {"kiri_1.6.24_amd64.deb": {"path": Path("package.deb"), "size": 20,
                                               "digest": "sha256:" + "b" * 64},
                      "provenance.json": {"path": Path("provenance.json"), "size": 10,
                                          "digest": "sha256:" + "c" * 64}}
        self.assets = [{"name": name, "state": "uploaded", "size": item["size"], "digest": item["digest"]}
                       for name, item in self.files.items()]

    def test_strict_tags_and_run_ids_reject_shell_path_and_semver_ambiguity(self):
        self.assertEqual(attach.validate_inputs(self.tag, "123"), ("1.6.24", 123))
        for tag in ("1.6.24", "v01.6.24", "v1.06.24", "v1.6.024", "v1.6.24-rc.1",
                    "v1.6.24+build", "v1.6.24\n", "v1.6.24/foo", "v1.6.24$(true)"):
            with self.subTest(tag=tag), self.assertRaises(RuntimeError):
                attach.validate_inputs(tag, "123")
        for run in ("0", "-1", "01", "1.5", "123\n", "123;true", True, 123):
            with self.subTest(run=run), self.assertRaises(RuntimeError):
                attach.validate_inputs(self.tag, run)

    def test_candidate_must_be_successful_official_tag_push(self):
        attach.validate_run(self.run, self.repository, 123, self.tag, self.sha)
        replacements = (("id", 124), ("repository", {"full_name": "other/Kiri"}),
                        ("head_repository", {"full_name": "fork/Kiri"}),
                        ("path", ".github/workflows/other.yml"), ("event", "pull_request"),
                        ("head_branch", "main"), ("head_sha", "d" * 40),
                        ("status", "in_progress"), ("conclusion", "failure"))
        for field, value in replacements:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                attach.validate_run({**self.run, field: value}, self.repository, 123, self.tag, self.sha)

    def test_only_exact_tag_refs_are_used_and_annotated_tags_are_peeled(self):
        endpoints = []

        def api(endpoint):
            endpoints.append(endpoint)
            if "/git/ref/tags/" in endpoint:
                return {"ref": "refs/tags/" + self.tag, "object": {"type": "tag", "sha": "e" * 40}}
            return {"object": {"type": "commit", "sha": self.sha}}

        self.assertEqual(attach.release_tag_sha(self.repository, self.tag, api), self.sha)
        self.assertEqual(endpoints, [f"repos/{self.repository}/git/ref/tags/{self.tag}",
                                     f"repos/{self.repository}/git/tags/" + "e" * 40])
        with self.assertRaisesRegex(RuntimeError, "exact release tag"):
            attach.release_tag_sha(self.repository, self.tag,
                                   lambda _: {**self.tag_ref, "ref": "refs/heads/" + self.tag})
        with self.assertRaisesRegex(RuntimeError, "cyclic"):
            attach.release_tag_sha(self.repository, self.tag,
                                   lambda _: {"ref": "refs/tags/" + self.tag,
                                              "object": {"type": "tag", "sha": "e" * 40}})

    def test_release_must_already_exist_as_one_unpublished_draft(self):
        for releases in ([], [self.draft, self.draft], [{**self.draft, "draft": False}],
                         [{**self.draft, "published_at": "2026-10-18T00:00:00Z"}],
                         [{**self.draft, "tag_name": "v1.6.23"}]):
            with self.subTest(releases=releases), self.assertRaises(RuntimeError):
                attach.unique_draft(self.repository, self.tag, lambda _: releases)

    def test_same_digest_skips_but_conflicting_or_unfinished_assets_refuse(self):
        self.assertEqual(attach.upload_plan(self.files, self.assets), [])
        self.assertEqual(attach.upload_plan(self.files, []), list(self.files))
        for field, value in (("digest", "sha256:" + "d" * 64), ("digest", None),
                             ("size", 21), ("state", "starter")):
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                attach.upload_plan(self.files, [{**self.assets[0], field: value}])
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            attach.upload_plan(self.files, [self.assets[0], self.assets[0]])

    def test_provenance_conflict_blocks_the_first_deb_upload(self):
        posts = []

        def api(endpoint, upload=None):
            if upload:
                posts.append(endpoint)
            if "/git/ref/tags/" in endpoint:
                return self.tag_ref
            if "/assets?" in endpoint:
                return [{**self.assets[1], "digest": "sha256:" + "d" * 64}]
            return [self.draft]

        with self.assertRaisesRegex(RuntimeError, "provenance.json"):
            attach.attach_files(self.repository, self.tag, self.sha, self.files, api)
        self.assertEqual(posts, [])

    def test_attachment_cannot_proceed_after_draft_is_published_or_tag_moves(self):
        for moved_tag in (False, True):
            calls = []

            def api(endpoint, upload=None):
                calls.append((endpoint, upload))
                if "/git/ref/tags/" in endpoint:
                    return {**self.tag_ref, "object": {"type": "commit", "sha": "d" * 40 if moved_tag else self.sha}}
                if "/assets?" in endpoint:
                    return []
                if not moved_tag and len(calls) > 1:
                    return [{**self.draft, "draft": False, "published_at": "now"}]
                return [self.draft]

            with self.subTest(moved_tag=moved_tag), self.assertRaises(RuntimeError):
                attach.attach_files(self.repository, self.tag, self.sha, self.files, api)
            self.assertFalse(any(upload for _, upload in calls))

    def test_upload_only_uses_existing_release_id_and_verifies_each_new_asset(self):
        assets = []
        posts = []

        def api(endpoint, upload=None):
            if upload:
                posts.append(endpoint)
                self.assertTrue(endpoint.startswith(
                    "https://uploads.github.com/repos/yuxino/Kiri/releases/55/assets?name="))
                name = upload.name if upload.name == "provenance.json" else "kiri_1.6.24_amd64.deb"
                asset = next(item for item in self.assets if item["name"] == name)
                assets.append(copy.deepcopy(asset))
                return asset
            if "/git/ref/tags/" in endpoint:
                return self.tag_ref
            if "/assets?" in endpoint:
                return copy.deepcopy(assets)
            return [self.draft]

        attach.attach_files(self.repository, self.tag, self.sha, self.files, api)
        self.assertEqual(len(posts), 2)
        attach.attach_files(self.repository, self.tag, self.sha, self.files, api)
        self.assertEqual(len(posts), 2, "Identical reruns must not write new assets")


class CandidateFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.deb = self.root / "kiri_1.6.24_amd64.deb"
        self.deb.write_bytes(b"original package bytes")
        self.provenance = self.root / "provenance.json"
        self.provenance.write_text('{"source_sha":"' + "a" * 40 + '"}\n', encoding="utf-8")

    def test_only_two_original_regular_files_are_allowed(self):
        files = attach.candidate_files(self.root, "1.6.24")
        self.assertEqual(files["provenance.json"]["path"].read_bytes(), self.provenance.read_bytes())
        self.provenance.unlink()
        with self.assertRaises(RuntimeError):
            attach.candidate_files(self.root, "1.6.24")
        self.provenance.symlink_to(self.deb)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            attach.candidate_files(self.root, "1.6.24")
        self.provenance.unlink()
        self.provenance.write_text("{}", encoding="utf-8")
        (self.root / "extra.deb").write_bytes(b"extra")
        with self.assertRaises(RuntimeError):
            attach.candidate_files(self.root, "1.6.24")

    @unittest.skipUnless(shutil.which("dpkg-deb"), "Debian metadata verification needs dpkg-deb")
    def test_real_debian_metadata_must_match_package_version_and_architecture(self):
        control = self.root / "control" / "DEBIAN"
        control.mkdir(parents=True)
        control.chmod(0o755)
        for package, version, architecture, accepted in (
                ("kiri", "1.6.24", "amd64", True), ("other", "1.6.24", "amd64", False),
                ("kiri", "1.6.23", "amd64", False), ("kiri", "1.6.24", "arm64", False)):
            with self.subTest(package=package, version=version, architecture=architecture):
                (control / "control").write_text(
                    f"Package: {package}\nVersion: {version}\nArchitecture: {architecture}\n"
                    "Maintainer: Kiri Test <test@example.invalid>\nDescription: isolated test fixture\n",
                    encoding="utf-8")
                subprocess.run(["dpkg-deb", "--build", str(control.parent), str(self.deb)],
                               check=True, capture_output=True)
                if accepted:
                    attach.validate_deb(self.deb, "1.6.24")
                else:
                    with self.assertRaises(RuntimeError):
                        attach.validate_deb(self.deb, "1.6.24")

    def test_existing_provenance_verifier_cannot_approve_a_different_source(self):
        from argparse import Namespace
        args = Namespace(source_dir=self.root, package_dir=self.root, tag="v1.6.24",
                         evidence=self.root / "verification.json")
        evidence = {"verified": True, "candidate": {"source_sha": "d" * 40}}

        def command(*arguments, **kwargs):
            if arguments[0] == "git":
                return "a" * 40
            if "verify" in arguments:
                args.evidence.write_text(json.dumps(evidence), encoding="utf-8")
            return ""

        run = {"id": 123, "repository": {"full_name": "yuxino/Kiri"},
               "head_repository": {"full_name": "yuxino/Kiri"}, "path": attach.BUILD_WORKFLOW,
               "event": "push", "head_branch": args.tag, "head_sha": "a" * 40,
               "status": "completed", "conclusion": "success"}
        api = lambda endpoint: {"ref": "refs/tags/" + args.tag, "object": {"type": "commit", "sha": "a" * 40}} if "/git/ref/tags/" in endpoint else run
        with patch.object(attach, "command", side_effect=command), self.assertRaisesRegex(RuntimeError, "exactly"):
            attach.verify_candidate(args, "yuxino/Kiri", "1.6.24", 123, api)


if __name__ == "__main__":
    unittest.main()
