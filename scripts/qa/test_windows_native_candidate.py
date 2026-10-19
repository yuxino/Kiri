"""Native retry cannot waive failed gates, change app bytes or accept another origin."""

import ast
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile
from windows_qa_profile import isolated_app_directories

spec = importlib.util.spec_from_file_location("candidate", Path(__file__).with_name("windows-native-candidate.py"))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "repository": {"full_name": "yuxino/kiri", "id": 1},
                    "head_repository": {"full_name": "yuxino/Kiri"}, "head_sha": "a" * 40,
                    "path": candidate.WORKFLOW, "event": "workflow_dispatch", "status": "completed", "run_attempt": 1}
        self.job = {"id": 456, "name": candidate.JOB, "status": "completed", "conclusion": "failure", "steps": [
            *({"name": name, "conclusion": "success"} for name in candidate.BUILD_STEPS),
            *({"name": name, "conclusion": "skipped"} for name in candidate.NATIVE_STEPS),
        ]}
        self.step("Verify configurable shortcuts on the actual desktop")["conclusion"] = "failure"

    def step(self, name):
        return next(step for step in self.job["steps"] if step["name"] == name)

    def validate(self, paths=()):
        return candidate.validate(self.run, [self.job], 123, paths)

    def test_failed_shortcut_and_every_skipped_gate_must_be_replayed(self):
        job, gates = self.validate(["scripts/qa/shortcut-native.py", ".github/workflows/build.yml"])
        self.assertEqual(job, self.job)
        self.assertEqual(gates, list(candidate.NATIVE_STEPS.values()))
        self.assertIn("confirmation-native.py", gates)
        self.assertIn("windows-capture-color-native.py", gates)
        self.assertIn("windows-library-files-native.py", gates)

    def test_older_candidate_without_new_features_keeps_existing_gates(self):
        self.job["steps"] = [step for step in self.job["steps"] if step["name"] not in {
            "Verify destructive confirmation windows on the actual desktop",
            "Verify hover colors and native clipboard on the installed Windows app",
            "Verify library file actions on the installed Windows app"}]
        self.assertEqual(self.validate()[1], list(candidate.REQUIRED_NATIVE))

    def test_rejects_unfinished_other_or_ambiguous_builds(self):
        original = copy.deepcopy(self.run)
        for key, value in (("id", 124), ("repository", {"full_name": "other/kiri"}),
                           ("head_repository", {"full_name": "other/kiri"}), ("path", "release.yml"),
                           ("event", "pull_request"), ("status", "in_progress"),
                           ("head_sha", "--bad"), ("run_attempt", 2)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.run = {**original, key: value}
                self.validate()
        self.run = original

    def release_tag_candidate(self):
        self.run.update(event="push", head_branch="v1.6.22")
        self.step("Build Windows acceptance installer")["conclusion"] = "skipped"
        self.job["steps"].append({"name": "Run tauri-apps/tauri-action@v0", "conclusion": "success"})

    def test_release_tag_replays_every_gate_with_its_original_bundle(self):
        self.release_tag_candidate()
        self.assertEqual(self.validate()[1], list(candidate.NATIVE_STEPS.values()))

    def test_regular_pushes_and_invalid_tag_names_are_rejected(self):
        self.release_tag_candidate()
        for branch in ("main", "refs/tags/v1.6.22", "v1.6.22;unsafe", "v1.6.22-beta", ""):
            self.run["head_branch"] = branch
            with self.subTest(branch=branch), self.assertRaises(RuntimeError):
                self.validate()

    def test_release_tag_requires_successful_tauri_packaging(self):
        self.release_tag_candidate()
        for result in ("failure", "skipped", None):
            self.step("Run tauri-apps/tauri-action@v0")["conclusion"] = result
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                self.validate()

    def test_release_tag_still_rejects_changed_application_sources(self):
        self.release_tag_candidate()
        with self.assertRaises(RuntimeError):
            self.validate(["src-tauri/src/core/library.rs"])

    def test_rejects_missing_duplicate_cancelled_windows_job(self):
        for jobs in ([], [self.job, self.job], [{**self.job, "conclusion": "cancelled"}]):
            with self.subTest(jobs=jobs), self.assertRaises(RuntimeError):
                candidate.validate(self.run, jobs, 123, [])

    def test_never_waives_build_packaging_or_unknown_failures(self):
        original = copy.deepcopy(self.job)
        for name in candidate.BUILD_STEPS:
            self.step(name)["conclusion"] = "failure"
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                self.validate()
            self.job = copy.deepcopy(original)
        self.job["steps"].append({"name": "Other unrecognized verification", "conclusion": "failure"})
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_rejects_removed_existing_native_gate(self):
        self.job["steps"] = [step for step in self.job["steps"] if step["name"] != "Install and smoke-test both Windows packages"]
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_unknown_skipped_native_gate_cannot_be_silently_waived(self):
        self.job["steps"].append({"name": "Verify another feature on the actual desktop", "conclusion": "skipped"})
        with self.assertRaises(RuntimeError):
            self.validate()

    def test_rejects_application_lockfile_and_packaging_source_changes(self):
        for path in ("src/windows/PinWindow.tsx", "src-tauri/src/commands.rs", "pnpm-lock.yaml",
                     "scripts/package-windows-portable.ps1", "src-tauri/tauri.conf.json"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                self.validate([path])

    def test_markdown_translation_changes_do_not_require_rebuilding(self):
        self.validate(["README.md", "docs/readme/zh-CN.md", "docs/readme/ja.md",
                       "docs/privacy/en.md", "docs/roadmap.md", "docs/architecture.md"])
        for path in ("docs/demos/flow.js", "public/icon.png", "docs/readme/zh-CN.md/escape", "vite.config.ts"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                self.validate([path])

    def test_actual_checkout_is_anchored_to_immediate_sha(self):
        log = '2026-10-10T00:00:00Z [command]"C:\\Program Files\\Git\\bin\\git.exe" log -1 --format=%H\n2026-10-10T00:00:00Z ' + "a" * 40 + "\n"
        self.assertEqual(candidate.checkout_sha(log), "a" * 40)
        for wrong in (log + log, log.replace("a" * 40, "short"), log.replace("[command]", "reported ")):
            with self.subTest(log=wrong), self.assertRaises(RuntimeError):
                candidate.checkout_sha(wrong)

    def test_artifact_requires_official_run_head_and_archive_digest(self):
        artifact = {"name": "kiri-windows", "expired": False, "digest": "sha256:" + "b" * 64,
                    "workflow_run": {"id": 123, "repository_id": 1, "head_sha": "a" * 40}}
        self.assertEqual(candidate.artifact_for(self.run, [artifact], "kiri-windows"), artifact)
        for values in ([artifact, artifact], [{**artifact, "expired": True}], [{**artifact, "digest": None}],
                       [{**artifact, "workflow_run": {**artifact["workflow_run"], "head_sha": "c" * 40}}]):
            with self.subTest(values=values), self.assertRaises(RuntimeError):
                candidate.artifact_for(self.run, values, "kiri-windows")


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "candidate.zip"

    def make(self, filename):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr(filename, b"public immutable executable fixture")

    def test_verified_archive_preserves_exact_executable_bytes(self):
        self.make("kiri.exe")
        candidate.extract_verified(self.archive, self.root / "verified", "sha256:" + candidate.digest(self.archive))
        self.assertEqual((self.root / "verified/kiri.exe").read_bytes(), b"public immutable executable fixture")

    def test_archive_checksum_mismatch_is_rejected_before_extraction(self):
        self.make("kiri.exe")
        with self.assertRaises(RuntimeError):
            candidate.extract_verified(self.archive, self.root / "verified", "sha256:" + "0" * 64)
        self.assertFalse((self.root / "verified").exists())

    def test_archive_cannot_escape_its_candidate_directory(self):
        for index, filename in enumerate(("../kiri.exe", "/kiri.exe", "C:/kiri.exe", "folder/../../kiri.exe")):
            with self.subTest(filename=filename):
                self.make(filename)
                with self.assertRaises(RuntimeError):
                    candidate.extract_verified(self.archive, self.root / str(index), "sha256:" + candidate.digest(self.archive))

    def test_different_original_compiled_bytes_are_recorded_and_payload_install_must_match(self):
        compiled, payload, installed = (self.root / name for name in ("compiled.exe", "payload.exe", "installed.exe"))
        compiled.write_bytes(b"original compiled __TAURI_BUNDLE_TYPE_VAR_UNK portable executable")
        payload.write_bytes(compiled.read_bytes().replace(b"_VAR_UNK", b"_VAR_NSS"))
        installed.write_bytes(payload.read_bytes())
        identities = candidate.executable_identities(compiled, payload, installed)
        self.assertFalse(identities["compiled_matches_installed"])
        self.assertEqual(identities["installer_payload_sha256"], identities["executable_sha256"])
        self.assertNotEqual(identities["compiled_executable_sha256"], identities["executable_sha256"])
        self.assertEqual(identities["bundle_marker_proof"]["cli_version"], "2.11.4")
        installed.write_bytes(b"a different installed executable")
        with self.assertRaisesRegex(RuntimeError, "installer payload"):
            candidate.executable_identities(compiled, payload, installed)

    def test_no_extra_payload_change_or_duplicate_marker_can_pass(self):
        compiled, payload, installed = (self.root / name for name in ("compiled.exe", "payload.exe", "installed.exe"))
        compiled.write_bytes(b"__TAURI_BUNDLE_TYPE_VAR_UNK")
        payload.write_bytes(b"__TAURI_BUNDLE_TYPE_VAR_NSS" + b"another change")
        installed.write_bytes(payload.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "beyond"):
            candidate.executable_identities(compiled, payload, installed)
        compiled.write_bytes(compiled.read_bytes() * 2)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            candidate.executable_identities(compiled, payload, installed)


class ConfirmationExecutableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Execute the actual path/identity function without importing Windows
        # UI dependencies or launching an application.
        path = Path(__file__).with_name("confirmation-native.py")
        source = ast.parse(path.read_text(), filename=str(path))
        function = next(node for node in source.body
                        if isinstance(node, ast.FunctionDef) and node.name == "confirmation_executable")
        namespace = {"Path": Path, "os": os, "re": re, "hashlib": hashlib}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"), namespace)
        cls.identity = staticmethod(namespace["confirmation_executable"])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.compiled = self.root / "src-tauri/target/release/kiri.exe"
        self.compiled.parent.mkdir(parents=True)
        self.compiled.write_bytes(b"compiled portable payload")
        self.installed = self.root / "Program Files/Kiri 测试/kiri.exe"
        self.installed.parent.mkdir(parents=True)
        self.installed.write_bytes(b"NSIS installed payload")
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.root)

    def result(self, **env):
        with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40, **env}, clear=True):
            return self.identity()

    def test_confirmation_uses_installed_payload_and_records_its_actual_identity(self):
        result = self.result(KIRI_QA_INSTALLED_EXE=str(self.installed))
        self.assertEqual(result["executable"], str(self.installed.resolve()))
        self.assertEqual(result["executable_kind"], "installed")
        self.assertEqual(result["executable_sha256"], hashlib.sha256(self.installed.read_bytes()).hexdigest())
        self.assertNotEqual(result["executable_sha256"], hashlib.sha256(self.compiled.read_bytes()).hexdigest())
        self.assertEqual(result["source_sha"], "a" * 40)

    def test_confirmation_keeps_compiled_fallback_when_no_installed_path_is_requested(self):
        result = self.result()
        self.assertEqual(result["executable"], str(self.compiled.resolve()))
        self.assertEqual(result["executable_kind"], "compiled")
        self.assertEqual(result["executable_sha256"], hashlib.sha256(self.compiled.read_bytes()).hexdigest())

    def test_replay_records_candidate_source_separately_from_harness(self):
        for field in ("KIRI_LIBRARY_FILES_CANDIDATE_SHA", "KIRI_COLOR_CANDIDATE_SHA"):
            with self.subTest(field=field):
                result = self.result(KIRI_QA_INSTALLED_EXE=str(self.installed), **{field: "b" * 40})
                self.assertEqual(result["source_sha"], "b" * 40)
                self.assertEqual(result["harness_sha"], "a" * 40)

    def test_bad_explicit_installed_path_cannot_silently_use_compiled_binary(self):
        for path in (str(self.root / "missing.exe"), str(self.installed.parent), ""):
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "executable is missing"):
                self.result(KIRI_QA_INSTALLED_EXE=path)

    def test_confirmation_identity_requires_a_complete_source_sha(self):
        for sha in ("", "short", "not-a-commit"):
            with self.subTest(sha=sha), self.assertRaisesRegex(RuntimeError, "source commit SHA"):
                self.result(GITHUB_SHA=sha)


class NativePackageIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.roaming, self.local = self.root / "Roaming", self.root / "Local"
        self.profiles = (self.roaming / "kiri", self.local / "io.yuxino.kiri")
        for path in self.profiles:
            path.mkdir(parents=True)
            (path / "prior.txt").write_text("original QA profile")
        self.recovery, self.output = self.root / "recovery", self.root / "evidence"
        self.recovery.mkdir(); self.output.mkdir()
        self.portable, self.installed = self.root / "portable/kiri.exe", self.root / "installed/kiri.exe"
        for path in (self.portable, self.installed):
            path.parent.mkdir(); path.write_bytes(b"application")
        (self.portable.parent / "kiri.portable").write_text("")
        self.report = {"success": False}
        self.events, self.labels = [], []
        self.scope = 0
        self.fail_smoke = self.fail_stop = self.fail_restore = self.extra_portable_file = False

        @contextmanager
        def isolate():
            self.scope += 1
            current = self.scope
            self.events.append(("enter", current))
            with isolated_app_directories(self.profiles, self.recovery):
                try:
                    yield {"APPDATA": str(self.roaming), "LOCALAPPDATA": str(self.local)}
                finally:
                    self.events.append(("restore", current))
                    # The log must already be safe before directory restoration.
                    filename = "portable-native.log" if current == 1 else "NSIS-native.log"
                    self.assertTrue((self.output / filename).is_file())
            if self.fail_restore:
                raise RuntimeError("profile restoration failed")

        def smoke(executable, update_button, label):
            self.labels.append(label)
            self.events.append(("smoke", label))
            self.assertEqual((executable, update_button),
                             (self.portable, "Open Releases Page") if label == "portable ZIP"
                             else (self.installed, "Check for Updates"))
            cache = self.profiles[1] / "EBWebView"
            self.assertFalse(cache.exists(), "The next executable reused the previous WebView profile")
            self.assertFalse((self.profiles[0] / "prior.txt").exists())
            cache.mkdir(); (cache / "owner.txt").write_text(label)
            log = self.profiles[1] / "logs/kiri.log"
            log.parent.mkdir(); log.write_text(label + " log\n")
            (self.profiles[0] / "generated.txt").write_text(label)
            if self.extra_portable_file:
                (self.portable.parent / "unexpected.txt").write_text("unexpected")
            if self.fail_smoke:
                raise ValueError("native acceptance failed")

        def stop():
            self.events.append(("stop", self.scope))
            if self.fail_stop:
                raise RuntimeError("process-tree stop failed")

        source = ast.parse(Path(__file__).with_name("windows-release-native.py").read_text())
        helper = next(node for node in source.body if isinstance(node, ast.FunctionDef)
                      and node.name == "smoke_isolated_package")
        main = next(node for node in source.body if isinstance(node, ast.Try))
        self.driver = compile(ast.Module(body=[helper, *main.body], type_ignores=[]), "native-package-driver", "exec")
        self.namespace = {"Path": Path, "os": Mock(environ={"KIRI_QA_PORTABLE_EXE": str(self.portable),
                                                          "KIRI_QA_INSTALLED_EXE": str(self.installed)}),
                          "isolated_windows_profile": isolate, "smoke": smoke, "stop": stop,
                          "report": self.report, "output": self.output}

    def run_driver(self):
        exec(self.driver, self.namespace)

    def assert_original_profiles_restored(self):
        for path in self.profiles:
            self.assertEqual((path / "prior.txt").read_text(), "original QA profile")
            self.assertFalse((path / "generated.txt").exists())
            self.assertFalse((path / "EBWebView").exists())
        self.assertEqual(list(self.recovery.iterdir()), [])

    def test_each_real_package_driver_gets_fresh_profiles_and_its_own_log(self):
        (self.output / "kiri-native.log").write_text("stale log from an earlier run\n")
        self.run_driver()
        self.assertEqual(self.events, [("enter", 1), ("smoke", "portable ZIP"), ("stop", 1), ("restore", 1),
                                       ("enter", 2), ("smoke", "NSIS installation"), ("stop", 2), ("restore", 2)])
        self.assertTrue(self.report["success"])
        self.assertTrue(self.report["native_acceptance_success"])
        self.assertEqual((self.output / "portable-native.log").read_text(), "portable ZIP log\n")
        self.assertEqual((self.output / "NSIS-native.log").read_text(), "NSIS installation log\n")
        self.assertEqual((self.output / "kiri-native.log").read_text(), "portable ZIP log\nNSIS installation log\n")
        self.assert_original_profiles_restored()

    def test_acceptance_stop_or_restore_failure_cannot_start_the_next_package(self):
        for field, message in (("fail_smoke", "native acceptance failed"),
                               ("fail_stop", "process-tree stop failed"),
                               ("fail_restore", "profile restoration failed")):
            with self.subTest(failure=field):
                setattr(self, field, True)
                with self.assertRaisesRegex((RuntimeError, ValueError), message):
                    self.run_driver()
                self.assertEqual(self.labels, ["portable ZIP"])
                self.assertFalse(self.report["success"])
                self.assertNotIn("native_acceptance_success", self.report)
                self.assertEqual((self.output / "portable-native.log").read_text(), "portable ZIP log\n")
                self.assertFalse((self.output / "NSIS-native.log").exists())
                self.assert_original_profiles_restored()
                setattr(self, field, False)
                self.scope = 0; self.labels.clear(); self.events.clear()

    def test_portable_side_file_check_is_preserved_before_installed_launch(self):
        self.extra_portable_file = True
        with self.assertRaisesRegex(RuntimeError, "Portable copy wrote unexpected files"):
            self.run_driver()
        self.assertEqual(self.labels, ["portable ZIP"])
        self.assertFalse(self.report["success"])
        self.assert_original_profiles_restored()


class NativeSettingsRouteTests(unittest.TestCase):
    def test_package_support_checks_open_the_about_tab_before_finding_its_controls(self):
        source = Path(__file__).with_name("windows-release-native.py").read_text()
        smoke = next(node for node in ast.parse(source).body
                     if isinstance(node, ast.FunctionDef) and node.name == "smoke")
        body = next(node for node in smoke.body if isinstance(node, ast.Try)).body
        # Execute the real navigation prefix without importing Windows-only UIA
        # or invoking native clipboard APIs on this host.
        clipboard_start = next(index for index, node in enumerate(body)
                               if isinstance(node, ast.Assign)
                               and isinstance(node.targets[0], ast.Tuple)
                               and [target.id for target in node.targets[0].elts] == ["user32", "kernel32"])
        navigation = ast.Module(body=body[:clipboard_start], type_ignores=[])
        for label, update_button in (("portable ZIP", "Open Releases Page"),
                                     ("NSIS installation", "Check for Updates")):
            with self.subTest(package=label):
                page = "library"
                clicks = []
                lookups = []
                focused = []

                def find(name, *, control_type="Button", scroll=False):
                    nonlocal page
                    lookups.append((name, control_type, scroll))
                    expected_page = "library" if name == "Settings" else "general" if name == "About" else "about"
                    self.assertEqual(page, expected_page, f"{name} requested from {page}")
                    self.assertEqual(control_type, "TabItem" if name == "About" else "Button")
                    control = Mock()
                    control.top_level_parent.return_value.set_focus.side_effect = lambda: focused.append(True)

                    def click():
                        nonlocal page
                        clicks.append(name)
                        if name == "Settings":
                            page = "general"
                        elif name == "About":
                            page = "about"

                    control.click_input.side_effect = click
                    return control

                namespace = {"find": find, "snapshot": Mock(), "label": label, "update_button": update_button}
                exec(compile(navigation, "native-settings-navigation", "exec"), namespace)
                self.assertEqual(clicks, ["Settings", "About", "Copy Info"])
                self.assertEqual(focused, [True])
                self.assertIn((update_button, "Button", True), lookups)


class LibrarySettingsRouteTests(unittest.TestCase):
    def navigation(self, function_name, stop_assignment, initial_tab):
        path = Path(__file__).with_name("windows-library-files-native.py")
        source = ast.parse(path.read_text(), filename=str(path))
        function = next(node for node in source.body
                        if isinstance(node, ast.FunctionDef) and node.name == function_name)
        end = next(index for index, node in enumerate(function.body)
                   if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                   and node.targets[0].id == stop_assignment)
        navigation = ast.Module(body=function.body[:end], type_ignores=[])
        window = object()
        page = "library"
        clicks = []
        destinations = []
        lookups = []

        def find(name, *, kinds, scope, scroll=False):
            nonlocal page
            self.assertIs(scope, window)
            lookups.append((name, kinds, scroll))
            if name == "Settings":
                self.assertEqual((page, kinds), ("library", ("Button",)))
            elif kinds == ("TabItem",):
                self.assertIn(page, ("general", "about"))
                self.assertIn(name, ("General", "About"))
            elif name == "GitHub":
                self.assertEqual((page, kinds), ("about", ("Button",)))
            elif name == "Open Folder":
                self.assertIn(page, ("general", "about"))
                self.assertEqual(kinds, ("Button",))
            else:
                self.fail(f"Obsolete or ambiguous settings lookup: {name} {kinds}")
            control = Mock()

            def click():
                nonlocal page
                clicks.append(name)
                if name == "Settings":
                    page = initial_tab
                elif kinds == ("TabItem",):
                    page = name.lower()
                elif name == "Open Folder":
                    destinations.append("current library" if page == "general" else "support menu")

            control.click_input.side_effect = click
            return control

        namespace = {"find": find, "phase": Mock(), "focus_library": Mock(), "library_window": window}
        exec(compile(navigation, str(path), "exec"), namespace)
        return clicks, destinations, lookups

    def test_library_folder_opens_general_even_when_an_update_selects_about(self):
        for initial_tab in ("general", "about"):
            with self.subTest(initial_tab=initial_tab):
                clicks, destinations, _ = self.navigation("verify_folder_and_rename", "window", initial_tab)
                self.assertEqual(clicks, ["Settings", "General", "Open Folder"])
                self.assertEqual(destinations, ["current library"])

    def test_support_folders_open_about_without_ambiguous_same_name_groups(self):
        for initial_tab in ("general", "about"):
            with self.subTest(initial_tab=initial_tab):
                clicks, destinations, lookups = self.navigation("verify_support_folders", "destinations", initial_tab)
                self.assertEqual(clicks, ["Settings", "About"])
                self.assertEqual(destinations, [])
                self.assertIn(("GitHub", ("Button",), True), lookups)


class NativePollingTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("windows-release-native.py").read_text()
        function = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.FunctionDef) and node.name == "wait_for")
        self.now = 0
        def sleep(seconds):
            self.now += seconds
        self.process = Mock()
        self.process.poll.return_value = None
        namespace = {"time": Mock(monotonic=lambda: self.now, sleep=sleep), "process": self.process}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "native-wait", "exec"), namespace)
        self.wait = namespace["wait_for"]

    def test_transient_read_lock_waits_for_the_real_condition(self):
        predicate = Mock(side_effect=[PermissionError("replace in progress"), False, "restored"])
        self.assertEqual(self.wait("restored index", predicate, timeout=1), "restored")
        self.assertEqual(predicate.call_count, 3)

    def test_persistent_read_lock_still_fails_at_the_original_deadline(self):
        predicate = Mock(side_effect=PermissionError("still denied"))
        with self.assertRaisesRegex(RuntimeError, "Timed out") as error:
            self.wait("restored index", predicate, timeout=0.2)
        self.assertIsInstance(error.exception.__cause__, PermissionError)
        self.assertGreaterEqual(self.now, 0.2)

    def test_malformed_index_is_not_treated_as_a_read_lock(self):
        predicate = Mock(side_effect=ValueError("invalid JSON"))
        with self.assertRaisesRegex(ValueError, "invalid JSON"):
            self.wait("restored index", predicate, timeout=1)
        self.assertEqual(predicate.call_count, 1)

    def test_process_exit_is_not_retried(self):
        self.process.poll.return_value = 1
        predicate = Mock(return_value=True)
        with self.assertRaisesRegex(RuntimeError, "Kiri exited"):
            self.wait("restored index", predicate, timeout=1)
        predicate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
