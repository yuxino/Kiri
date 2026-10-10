"""Check scheduling boundaries without native builds or GitHub mutations."""
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ci_plan", Path(__file__).with_name("ci-plan.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PlanTests(unittest.TestCase):
    def auto(self, *paths):
        return policy.plan("pull_request", "refs/pull/71/merge", {}, list(paths))

    def test_docs_and_evidence_do_not_build_or_render(self):
        result = self.auto("README_ZH.md", "docs/qa/report.md", "docs/qa/after.png")
        self.assertEqual(set(result.values()), {"quick", "false"})

    def test_frontend_runs_renderer_without_native_packages(self):
        result = self.auto("src/windows/EditorWindow.tsx")
        self.assertEqual(result["renderer"], "true")
        self.assertFalse(any(value == "true" for key, value in result.items() if key.startswith(("package_", "native_"))))

    def test_renderer_workflow_and_harness_changes_run_renderer(self):
        for path in (".github/workflows/build.yml", "scripts/qa/countdown-ui.py"):
            with self.subTest(path=path):
                self.assertEqual(self.auto(path)["renderer"], "true")

    def test_shared_backend_and_capability_check_every_target_without_packages(self):
        for path in ("src-tauri/src/core/geometry.rs", "src-tauri/capabilities/image-close.json", "src-tauri/Cargo.lock"):
            with self.subTest(path=path):
                result = self.auto(path)
                for target in policy.TARGET_PREFIXES:
                    self.assertEqual(result[f"native_{target}"], "true")
                    self.assertEqual(result[f"package_{target}"], "false")

    def test_each_platform_only_checks_affected_backend(self):
        for target, prefixes in policy.TARGET_PREFIXES.items():
            with self.subTest(target=target):
                result = self.auto(prefixes[0] + ".rs")
                for other in policy.TARGET_PREFIXES:
                    self.assertEqual(result[f"native_{other}"], str(other == target).lower())

    def test_ipc_lifetime_harness_runs_linux_without_packages(self):
        for path in ("scripts/qa/ipc-lifetime/src/lib.rs", "scripts/qa/ipc-lifetime/check-source.py",
                     "scripts/qa/ipc-lifetime/Cargo.lock"):
            with self.subTest(path=path):
                result = self.auto(path)
                self.assertEqual(result["native_linux"], "true")
                self.assertTrue(all(value == "false" for key, value in result.items()
                                    if key not in {"profile", "native_linux"}))

    def test_manual_package_profiles_and_full(self):
        for profile in ("linux", "windows", "macos", "full"):
            result = policy.plan("workflow_dispatch", "refs/heads/qa", {"profile": profile}, [])
            self.assertEqual(result["renderer"], "true")
            for target in policy.TARGET_PREFIXES:
                self.assertEqual(result[f"package_{target}"], str(profile in {target, "full"}).lower())
            self.assertEqual(result["wayland"], str(profile in {"linux", "full"}).lower())
            self.assertEqual(result["linux_x11"], result["wayland"])

    def test_package_only_profile_never_starts_a_desktop(self):
        result = policy.plan("workflow_dispatch", "refs/heads/qa", {"profile": "linux-package"}, [])
        self.assertEqual(result["renderer"], "true")
        self.assertEqual(result["native_linux"], "true")
        self.assertEqual(result["package_linux"], "true")
        for key in ("native_windows", "native_macos", "package_windows", "package_macos",
                    "linux_x11", "wayland", "x11_recheck"):
            self.assertEqual(result[key], "false")
        with self.assertRaises(ValueError):
            policy.plan("workflow_dispatch", "refs/heads/qa",
                        {"profile": "linux-package", "linux_candidate_run_id": "1"}, [])

    def test_pr_package_label_adds_build_without_losing_required_checks(self):
        for paths in ([], ["README.md"], ["src/windows/EditorWindow.tsx"],
                      ["src-tauri/src/core/geometry.rs"], None):
            ordinary = policy.plan("pull_request", "refs/pull/85/merge", {}, paths)
            result = policy.plan("pull_request", "refs/pull/85/merge", {}, paths,
                                 ["bug", "ci:linux-package"])
            self.assertEqual(result, {**ordinary, "native_linux": "true", "package_linux": "true"})
            self.assertEqual(result["linux_x11"], "false")
            self.assertEqual(result["wayland"], "false")
        for event in ("push", "workflow_dispatch"):
            result = policy.plan(event, "refs/heads/main", {}, [], ["ci:linux-package"])
            self.assertEqual(result["package_linux"], "false")
        self.assertEqual(self.auto("README.md"), policy.plan("pull_request", "refs/pull/85/merge", {},
                                                          ["README.md"], ["ci:linux-package-extra"]))

    def test_workflow_exposes_label_and_keeps_x11_separate_from_packaging(self):
        workflow = Path(__file__).parents[2].joinpath(".github/workflows/build.yml").read_text()
        self.assertIn("types: [opened, synchronize, reopened, labeled, unlabeled]", workflow)
        self.assertIn("options: [quick, linux, linux-package,", workflow)
        self.assertIn("linux_x11: ${{ steps.plan.outputs.linux_x11 }}", workflow)
        self.assertIn("needs.plan.outputs.wayland == 'true'", workflow)
        self.assertIn("- name: Exercise the installed app on an isolated X11 desktop\n"
                      "        if: needs.plan.outputs.linux_x11 == 'true'", workflow)

    def test_release_tags_package_every_platform_without_linux_desktop_settings(self):
        for event, ref in (("push", "refs/heads/main"), ("pull_request", "refs/pull/1/merge")):
            result = policy.plan(event, ref, {}, ["src-tauri/Cargo.toml"])
            self.assertFalse(any(result[f"package_{target}"] == "true" for target in policy.TARGET_PREFIXES))
        result = policy.plan("push", "refs/tags/v1.6.7", {}, [])
        self.assertEqual(result["profile"], "release")
        for key in ("renderer", "native_linux", "native_windows", "native_macos",
                    "package_linux", "package_windows", "package_macos"):
            self.assertEqual(result[key], "true")
        for key in ("linux_x11", "wayland", "x11_recheck"):
            self.assertEqual(result[key], "false")

    def test_manual_release_matches_tag_and_full_retains_desktop_acceptance(self):
        manual = policy.plan("workflow_dispatch", "refs/heads/qa", {"profile": "release"}, [])
        tagged = policy.plan("push", "refs/tags/v1.6.9", {}, [])
        self.assertEqual(manual, tagged)
        full = policy.plan("workflow_dispatch", "refs/heads/qa", {"profile": "full"}, [])
        self.assertEqual(full, {**tagged, "profile": "full", "linux_x11": "true", "wayland": "true"})
        with self.assertRaises(ValueError):
            policy.plan("workflow_dispatch", "refs/heads/qa",
                        {"profile": "release", "linux_candidate_run_id": "1"}, [])

    def test_release_quality_gate_keeps_all_selected_checks_required(self):
        flags = policy.plan("push", "refs/tags/v1.6.9", {}, [])
        required = ("fast-checks", "countdown-ui", "test-rust", "build-linux", "build-windows", "build-macos")
        needs = {"plan": {"result": "success", "outputs": flags},
                 **{key: {"result": "success"} for key in required},
                 **{key: {"result": "skipped"} for key in ("test-linux-wayland", "recheck-linux-x11")}}
        self.assertEqual(policy.check_results(needs), [])
        for key in required:
            for result in ("failure", "cancelled", "skipped"):
                with self.subTest(job=key, result=result):
                    self.assertIn(key, policy.check_results({**needs, key: {"result": result}}))
        self.assertIn("test-linux-wayland", policy.check_results(
            {**needs, "test-linux-wayland": {"result": "success"}}))

    def test_unknown_diff_and_quick_do_not_disable_native_checks(self):
        for event, paths in (("pull_request", None), ("workflow_dispatch", [])):
            result = policy.plan(event, "refs/heads/qa", {}, paths)
            self.assertEqual(result["renderer"], "true")
            self.assertTrue(all(result[f"native_{target}"] == "true" for target in policy.TARGET_PREFIXES))
            self.assertTrue(all(result[f"package_{target}"] == "false" for target in policy.TARGET_PREFIXES))

    def test_old_dispatch_reuses_one_package_and_invalid_inputs_fail(self):
        result = policy.plan("workflow_dispatch", "refs/heads/qa", {"linux_candidate_run_id": "36815503794"}, [])
        self.assertEqual(result["profile"], "recheck-linux")
        self.assertEqual(result["wayland"], "true")
        self.assertFalse(any(value == "true" for key, value in result.items() if key.startswith(("native_", "package_"))))
        for inputs in ({"profile": "wrong"}, {"profile": "recheck-linux"}, {"linux_candidate_run_id": "1;bad"},
                       {"profile": "linux", "linux_candidate_run_id": "1"}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                policy.plan("workflow_dispatch", "refs/heads/qa", inputs, [])

    def test_failed_x11_recheck_does_not_rebuild_or_repeat_other_platforms(self):
        result = policy.plan("workflow_dispatch", "refs/heads/qa", {
            "profile": "recheck-linux-x11", "linux_candidate_run_id": "36853144607"}, [])
        self.assertEqual(result["x11_recheck"], "true")
        self.assertTrue(all(value == "false" for key, value in result.items()
                            if key not in {"profile", "x11_recheck"}))
        with self.assertRaises(ValueError):
            policy.plan("workflow_dispatch", "refs/heads/qa", {"profile": "recheck-linux-x11"}, [])

    def test_windows_recheck_never_builds_and_requires_one_explicit_candidate(self):
        result = policy.plan("workflow_dispatch", "refs/heads/qa", {
            "profile": "recheck-windows", "windows_native_candidate_run_id": "38026417382"}, [])
        self.assertEqual(result["profile"], "recheck-windows")
        self.assertTrue(all(value == "false" for key, value in result.items() if key != "profile"))
        for inputs in ({"profile": "recheck-windows"},
                       {"windows_native_candidate_run_id": "12"},
                       {"profile": "recheck-windows", "windows_native_candidate_run_id": "12;bad"},
                       {"profile": "windows", "windows_native_candidate_run_id": "12"},
                       {"profile": "recheck-windows", "windows_native_candidate_run_id": "12", "linux_candidate_run_id": "13"}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                policy.plan("workflow_dispatch", "refs/heads/qa", inputs, [])

    def test_quality_gate_rejects_failure_cancellation_and_unexpected_skips(self):
        flags = self.auto("src/windows/EditorWindow.tsx")
        needs = {"plan": {"result": "success", "outputs": flags}, "fast-checks": {"result": "success"},
                 "countdown-ui": {"result": "success"}, **{name: {"result": "skipped"} for name in
                 ("test-rust", "build-linux", "build-windows", "build-macos", "test-linux-wayland", "recheck-linux-x11")}}
        self.assertEqual(policy.check_results(needs), [])
        for result in ("failure", "cancelled", "skipped"):
            altered = {**needs, "countdown-ui": {"result": result}}
            self.assertEqual(policy.check_results(altered), ["countdown-ui"])
        self.assertIn("plan", policy.check_results({**needs, "plan": {"result": "failure"}}))
        self.assertIn("plan outputs", policy.check_results({**needs, "plan": {"result": "success", "outputs": {}}}))
        for value in (None, "", "TRUE"):
            invalid = {**flags, "linux_x11": value}
            self.assertIn("plan outputs", policy.check_results(
                {**needs, "plan": {"result": "success", "outputs": invalid}}))


class ChangedPathsTests(unittest.TestCase):
    base = "a" * 40

    def payload(self, event):
        return {"pull_request": {"base": {"sha": self.base}}} if event == "pull_request" else {"before": self.base}

    def result(self, code=0, stdout=b""):
        return SimpleNamespace(returncode=code, stdout=stdout)

    def test_existing_base_diffs_without_network(self):
        for event in ("pull_request", "push"):
            with self.subTest(event=event), patch.object(policy.subprocess, "run", side_effect=[
                    self.result(), self.result(stdout=b"src/windows/EditorWindow.tsx\0")]) as run:
                self.assertEqual(policy.changed_paths(event, self.payload(event)), ["src/windows/EditorWindow.tsx"])
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args_list[0].args[0], ["git", "cat-file", "-e", self.base + "^{commit}"])
                self.assertFalse(any("fetch" in call.args[0] for call in run.call_args_list))

    def test_missing_base_fetches_only_exact_event_commit(self):
        for event in ("pull_request", "push"):
            with self.subTest(event=event), patch.object(policy.subprocess, "run", side_effect=[
                    self.result(1), self.result(), self.result(stdout=b"README with spaces.md\0")]) as run:
                self.assertEqual(policy.changed_paths(event, self.payload(event)), ["README with spaces.md"])
                fetch = run.call_args_list[1]
                self.assertEqual(fetch.args[0], ["git", "fetch", "--no-tags", "--depth=1", "origin", self.base])
                self.assertEqual(fetch.kwargs["timeout"], 30)

    def test_fetch_failure_or_timeout_keeps_all_native_checks(self):
        for failed in (self.result(1), subprocess.TimeoutExpired("git", 30), OSError("network unavailable")):
            with self.subTest(failure=failed), patch.object(policy.subprocess, "run", side_effect=[
                    self.result(1), failed]) as run:
                paths = policy.changed_paths("pull_request", self.payload("pull_request"))
                self.assertIsNone(paths)
                self.assertEqual(run.call_count, 2)
                selected = policy.plan("pull_request", "refs/pull/108/merge", {}, paths)
                self.assertTrue(all(selected[f"native_{target}"] == "true" for target in policy.TARGET_PREFIXES))

    def test_diff_failure_still_keeps_unknown_diff(self):
        with patch.object(policy.subprocess, "run", side_effect=[self.result(), self.result(1)]):
            self.assertIsNone(policy.changed_paths("push", self.payload("push")))

    def test_invalid_event_bases_never_run_git(self):
        for base in (None, "", "main", "--upload-pack=bad", "0" * 40, "a" * 39, "a" * 40 + ";bad"):
            with self.subTest(base=base), patch.object(policy.subprocess, "run") as run:
                self.assertIsNone(policy.changed_paths("push", {"before": base}))
                run.assert_not_called()


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("provenance", Path(__file__).with_name("linux-package-provenance.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        (self.folder / "kiri.deb").write_bytes(b"public isolated package fixture")
        self.manifest = {"schema_version": 1, "repository": "yuxino/kiri", "workflow_path": self.module.WORKFLOW,
                         "run_id": 101, "run_attempt": 1, "source_sha": "a" * 40,
                         "package": self.module.package_details(self.folder)}
        self.write_manifest()
        self.run = {"id": 101, "run_attempt": 1, "repository": {"full_name": "yuxino/kiri", "id": 1},
                    "head_repository": {"full_name": "yuxino/kiri"}, "head_sha": "a" * 40,
                    "path": self.module.WORKFLOW, "status": "completed", "event": "workflow_dispatch", "html_url": "fixture"}
        self.job = {"name": self.module.BUILD_JOB, "id": 202, "html_url": "fixture", "status": "completed",
                    "conclusion": "success", "steps": [{"name": "Build Debian package without updater signing", "conclusion": "success"}]}
        self.artifact = {"id": 303, "name": self.module.ARTIFACT, "expired": False,
                         "workflow_run": {"id": 101, "repository_id": 1, "head_sha": "a" * 40}}

    def write_manifest(self):
        (self.folder / "provenance.json").write_text(json.dumps(self.manifest))

    def verify(self, event="workflow_dispatch", own_run="101", recheck_failed_x11=False):
        def command(*args):
            if args[:3] == ("git", "rev-parse", "HEAD"):
                return "a" * 40 if own_run == "101" else "b" * 40
            if args[:3] == ("git", "cat-file", "-p"):
                return "tree " + "c" * 40 + "\n\nfixture\n"
            if args[:2] == ("git", "diff"):
                return ""
            raise AssertionError(args)
        def api(url, raw=False):
            if raw:
                return "2026-10-01T00:00:00Z [command]/usr/bin/git log -1 --format=%H\n2026-10-01T00:00:00Z " + "a" * 40 + "\n"
            if "/attempts/" in url:
                return {**self.run, "run_attempt": 1}
            return self.run
        def items(url, key):
            if key == "jobs":
                self.queried_jobs_url = url
            return [self.job] if key == "jobs" else [self.artifact]
        evidence = {}
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "yuxino/kiri", "GITHUB_RUN_ID": own_run,
                                     "GITHUB_EVENT_NAME": event}, clear=True), \
                patch.object(self.module, "api", side_effect=api), \
                patch.object(self.module, "api_items", side_effect=items), \
                patch.object(self.module, "command", side_effect=command), \
                patch.object(self.module, "check_sources", return_value={"allowed_changes": []}):
            self.module.verify(SimpleNamespace(run_id="101", package_dir=self.folder,
                               output=self.folder / "evidence.json", recheck_failed_x11=recheck_failed_x11), evidence)
        return evidence

    def test_new_manual_and_automatic_builds_use_their_own_manifest(self):
        for event in ("workflow_dispatch", "pull_request", "push"):
            with self.subTest(event=event):
                evidence = self.verify(event=event)
                self.assertFalse(evidence["reused_package"])
                self.assertTrue(evidence["verified"])

    def test_manual_recheck_reuses_original_package(self):
        self.assertTrue(self.verify(own_run="102")["reused_package"])

    def test_recheck_after_rerun_verifies_the_original_build_attempt_and_digest(self):
        self.run["run_attempt"] = 2
        evidence = self.verify(own_run="102")
        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["latest_run_attempt"], 2)
        self.assertEqual(evidence["candidate"]["run_attempt"], 1)
        self.assertIn("/attempts/1/jobs", self.queried_jobs_url)
        (self.folder / "kiri.deb").write_bytes(b"changed original package")
        with self.assertRaisesRegex(RuntimeError, "recorded filename/checksum"):
            self.verify(own_run="102")

    def failed_x11_job(self):
        self.job["conclusion"] = "failure"
        self.job["steps"] = [{"name": name, "conclusion": "success"} for name in (
            "Run cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets",
            "Run cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets",
            "Build Debian package without updater signing", "Install and inspect the Debian package")]
        self.job["steps"].append({"name": "Exercise the installed app on an isolated X11 desktop", "conclusion": "failure"})

    def test_explicit_failed_x11_replay_retains_original_failure(self):
        self.failed_x11_job()
        evidence = self.verify(own_run="102", recheck_failed_x11=True)
        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["original_x11_conclusion"], "failure")

    def test_failed_x11_mode_rejects_build_failure_cancellation_or_missing_manifest(self):
        self.failed_x11_job()
        for index, status in ((0, "failure"), (3, "skipped"), (4, "cancelled")):
            with self.subTest(index=index, status=status):
                original = self.job["steps"][index]["conclusion"]
                self.job["steps"][index]["conclusion"] = status
                with self.assertRaises(RuntimeError):
                    self.verify(own_run="102", recheck_failed_x11=True)
                self.job["steps"][index]["conclusion"] = original
        (self.folder / "provenance.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "requires package provenance"):
            self.verify(own_run="102", recheck_failed_x11=True)

    def test_failed_x11_mode_cannot_label_own_or_successful_run_as_reused(self):
        with self.assertRaisesRegex(RuntimeError, "explicitly reuse"):
            self.verify(recheck_failed_x11=True)
        with self.assertRaisesRegex(RuntimeError, "original failed job"):
            self.verify(own_run="102", recheck_failed_x11=True)

    def test_automatic_run_cannot_use_another_run(self):
        with self.assertRaisesRegex(RuntimeError, "own package"):
            self.verify(event="pull_request", own_run="102")

    def test_new_manual_build_cannot_use_legacy_manifest_fallback(self):
        (self.folder / "provenance.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "must contain provenance"):
            self.verify()
        # The existing explicit legacy-reuse contract is preserved.
        self.assertTrue(self.verify(own_run="102")["verified"])

    def test_wrong_attempt_or_package_digest_is_rejected(self):
        self.manifest["run_attempt"] = 2
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "identity"):
            self.verify()
        self.manifest["run_attempt"] = 1
        self.write_manifest()
        (self.folder / "kiri.deb").write_bytes(b"changed bytes")
        with self.assertRaisesRegex(RuntimeError, "recorded filename/checksum"):
            self.verify()

    def test_reuse_rejects_failed_build_fork_or_unfinished_run(self):
        self.job["conclusion"] = "failure"
        with self.assertRaisesRegex(RuntimeError, "must have succeeded"):
            self.verify(own_run="102")
        self.job["conclusion"] = "success"
        self.run["head_repository"]["full_name"] = "another/fork"
        with self.assertRaisesRegex(RuntimeError, "fork"):
            self.verify(own_run="102")
        self.run["head_repository"]["full_name"] = "yuxino/kiri"
        self.run["status"] = "in_progress"
        with self.assertRaisesRegex(RuntimeError, "has not completed"):
            self.verify(own_run="102")

    def test_expired_or_wrong_origin_artifact_is_rejected(self):
        self.artifact["expired"] = True
        with self.assertRaisesRegex(RuntimeError, "unexpired"):
            self.verify()
        self.artifact["expired"] = False
        self.artifact["workflow_run"]["head_sha"] = "d" * 40
        with self.assertRaisesRegex(RuntimeError, "Artifact source"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
