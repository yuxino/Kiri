"""Candidate provenance and the observed WebView2 coordinate-node regression."""
import ast
import copy
import importlib.util
from pathlib import Path
import re
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("color_candidate", ROOT / "windows-capture-color-candidate.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.run = {"id": 123, "repository": {"full_name": "yuxino/Kiri"},
                    "head_repository": {"full_name": "yuxino/Kiri"},
                    "path": ".github/workflows/build.yml", "event": "workflow_dispatch",
                    "status": "completed", "head_sha": "a" * 40}
        stages = ["Run Windows regression and native video export tests", "Build Windows acceptance installer",
                  "Package and verify portable Windows build", "Verify countdown and recording controls on the actual desktop",
                  "Verify configurable shortcuts on the actual desktop", "Install and smoke-test both Windows packages"]
        self.jobs = [{"name": candidate.WINDOWS_JOB, "status": "completed", "conclusion": "failure",
                      "steps": [{"name": stage, "conclusion": "success"} for stage in stages] +
                      [{"name": candidate.COLOR_STEP, "conclusion": "failure"}]}]

    def test_allows_qa_only_retry_after_real_package_and_install_acceptance(self):
        candidate.validate(self.run, self.jobs, 123, ["scripts/qa/windows-capture-color-native.py", ".github/workflows/build.yml"])

    def test_rejects_wrong_repository_run_and_unfinished_candidates(self):
        for field, value in [("id", 124), ("head_repository", {"full_name": "fork/Kiri"}),
                             ("event", "pull_request"), ("path", ".github/workflows/other.yml"),
                             ("status", "in_progress"), ("head_sha", "bad")]:
            run = {**self.run, field: value}
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                candidate.validate(run, self.jobs, 123, [])

    def test_rejects_app_or_packaging_changes_and_other_native_failures(self):
        for path in ["src/windows/OverlayWindow.tsx", "src-tauri/tauri.conf.json", "scripts/package-windows-portable.ps1"]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                candidate.validate(self.run, self.jobs, 123, [path])
        jobs = copy.deepcopy(self.jobs)
        jobs[0]["steps"][0]["conclusion"] = "failure"
        with self.assertRaises(RuntimeError):
            candidate.validate(self.run, jobs, 123, [])

    def test_reads_coordinates_from_actual_split_statusbar_text_shape(self):
        tree = ast.parse((ROOT / "windows-capture-color-native.py").read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "displayed_coordinates")
        class Node:
            def __init__(self, text, kind="Text", children=()):
                self.text, self.children = text, children
                self.element_info = SimpleNamespace(control_type=kind)
            def window_text(self): return self.text
            def descendants(self, **kwargs): return self.children
        # Observed in run 38024060740: output Name is empty; x/comma/y are children.
        nodes = [Node("", "StatusBar", [Node("110"), Node(", "), Node("250")]),
                 Node("", "StatusBar", [Node("#000302")])]
        scope = {"re": re, "controls": lambda: nodes}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "coordinate reader", "exec"), scope)
        self.assertEqual(scope["displayed_coordinates"](), (110, 250))

    def test_edit_lookup_uses_accessible_name_instead_of_current_value(self):
        tree = ast.parse((ROOT / "windows-capture-color-native.py").read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "find")
        for label, value in [("Width (px)", "680"), ("Text content", "")]:
            control = SimpleNamespace(element_info=SimpleNamespace(name=label, control_type="Edit"),
                                      window_text=lambda: value, is_enabled=lambda: True)
            scope = {"controls": lambda: [control], "wait_for": lambda description, predicate, timeout: predicate()}
            exec(compile(ast.Module(body=[function], type_ignores=[]), "edit lookup", "exec"), scope)
            self.assertIs(scope["find"](label, kind="Edit"), control)


if __name__ == "__main__":
    unittest.main()
