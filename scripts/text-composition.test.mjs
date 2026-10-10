import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { handleTextEditorKey, isTextComposition, setTextComposition } from "../src/annotation/text-composition.js";
import { installVideoProjectShortcuts } from "../src/windows/video-project-shortcuts.js";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

function key(options = {}) {
  return { key: "Enter", target: {}, isComposing: false, keyCode: 13,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }, ...options };
}
function actions() {
  const calls = [];
  return { calls, ...Object.fromEntries(["cancel", "commit", "undo", "redo", "finish"]
    .map(name => [name, () => calls.push(name)])) };
}

test("IME Enter/Escape/undo preserve composition and never act on the canvas", () => {
  for (const signal of [{ isComposing: true }, { keyCode: 229 }, { lifecycle: true }]) {
    for (const eventKey of ["Enter", "Escape", "z"]) {
      const e = key({ ...signal, key: eventKey, ctrlKey: eventKey === "z" });
      if (signal.lifecycle) setTextComposition(e.target, true);
      const a = actions();
      a.nativeHistory = command => { a.calls.push(command); return true; };
      // Check the same predicate used before the textarea in window capture.
      assert.equal(isTextComposition(e), true);
      handleTextEditorKey(e, a, true);
      assert.deepEqual(a.calls, []);
      assert.equal(e.defaultPrevented, false);
      assert.equal(e.stopped, true);
      setTextComposition(e.target, false);
    }
  }
});
test("composition end or blur releases only its own input", () => {
  const first = {}, second = {};
  setTextComposition(first, true);
  assert.equal(isTextComposition(key({ target: second })), false);
  assert.equal(isTextComposition(key({ nativeEvent: { target: first, isComposing: false, keyCode: 13 } })), true);
  setTextComposition(first, false);
  const e = key({ target: first }), a = actions();
  handleTextEditorKey(e, a, true);
  assert.deepEqual(a.calls, ["commit", "finish"]);
});
test("native Ctrl/Cmd undo and redo execute focused history once without committing", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) for (const shiftKey of [false, true]) {
    const e = key({ key: "z", [modifier]: true, shiftKey }), a = actions();
    a.nativeHistory = command => { a.calls.push(command); return true; };
    handleTextEditorKey(e, a, true);
    assert.deepEqual(a.calls, [shiftKey ? "redo" : "undo"]);
    assert.equal(e.defaultPrevented, true);
    assert.equal(e.stopped, true);
  }
});
test("empty native history preserves platform fallback and never uses canvas history", () => {
  const e = key({ key: "z", ctrlKey: true }), a = actions();
  a.nativeHistory = () => false;
  handleTextEditorKey(e, a, true);
  assert.deepEqual(a.calls, []);
  assert.equal(e.defaultPrevented, false);
  assert.equal(e.stopped, true);
});
test("normal Escape cancels edit; Shift+Enter keeps newline; legacy history stays ordered", () => {
  const esc = key({ key: "Escape" }), a = actions();
  handleTextEditorKey(esc, a, true);
  assert.deepEqual(a.calls, ["cancel"]);
  assert.equal(esc.defaultPrevented, true);
  const newline = key({ shiftKey: true }), b = actions();
  handleTextEditorKey(newline, b, true);
  assert.deepEqual(b.calls, []);
  assert.equal(newline.defaultPrevented, false);
  const redo = key({ key: "z", ctrlKey: true, shiftKey: true }), c = actions();
  handleTextEditorKey(redo, c, false);
  assert.deepEqual(c.calls, ["commit", "redo"]);
});
test("Return commits before finishing capture; a saved-image editor only commits", () => {
  const capture = actions(), enter = key();
  handleTextEditorKey(enter, capture, true);
  assert.deepEqual(capture.calls, ["commit", "finish"]);
  assert.equal(enter.defaultPrevented, true);
  const image = actions();
  delete image.finish;
  handleTextEditorKey(key(), image, true);
  assert.deepEqual(image.calls, ["commit"]);
});
test("capture-phase video save/close does not commit an active IME even with false flags", () => {
  let handler;
  const surface = { addEventListener(_, callback) { handler = callback; }, removeEventListener() {} };
  const calls = [];
  const stop = installVideoProjectShortcuts(surface, { save: () => calls.push("save"), close: () => calls.push("close") });
  const target = {};
  setTextComposition(target, true);
  for (const eventKey of ["s", "w"]) {
    const e = key({ target, key: eventKey, ctrlKey: true });
    handler(e);
    assert.deepEqual(calls, []);
    assert.equal(e.defaultPrevented, false);
  }
  setTextComposition(target, false);
  handler(key({ target, key: "s", ctrlKey: true }));
  assert.deepEqual(calls, ["save"]);
  stop();
});

// Execute the actual window handlers with isolated action boundaries. This
// catches a missed integration, not only correctness of the shared predicate.
function windowHandler(filename, name) {
  const source = readFileSync(new URL(`../src/windows/${filename}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      assert.equal(handler, undefined, "handler must have an unambiguous production boundary");
      handler = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(handler);
  const calls = [];
  const action = name => () => calls.push(name);
  const context = { isTextComposition, completionLock: { locked: false },
    colorPicker: { onCopyKeyDown: () => false },
    qrRequestRef: { current: null }, readOnlyRef: { current: false }, closeQr: action("closeQr"),
    phaseRef: { current: "annotating" }, tool: "select",
    canvasRef: { current: { cancelTextEditing: () => false,
      undo: action("undo"), redo: action("redo"), deleteSelection: action("delete") } },
    cancel: action("cancel"), closeWindow: action("close"), complete: action("complete"),
    cancelCrop: action("cancelCrop"), selectTool: action("selectTool"), Element: class Element {} };
  const compiled = ts.transpileModule(`const handler = ${handler};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const run = new Function(...Object.keys(context), `${compiled}\nreturn handler;`)(...Object.values(context));
  return { run, calls };
}
for (const [file, name, ordinaryKey, expected] of [
  ["OverlayWindow.tsx", "onEscape", "Escape", "cancel"],
  ["OverlayWindow.tsx", "onKeyDown", "Enter", "complete"],
  ["EditorWindow.tsx", "onKeyDown", "Escape", "close"],
]) test(`${file} ${name} leaves composition with false key flags alone`, () => {
  const { run, calls } = windowHandler(file, name), target = {};
  setTextComposition(target, true);
  for (const eventKey of ["Enter", "Escape", "z"]) {
    const e = key({ target, key: eventKey, ctrlKey: eventKey === "z",
      stopImmediatePropagation() { this.stopped = true; } });
    run(e);
    assert.deepEqual(calls, []);
    assert.equal(e.defaultPrevented, false);
  }
  setTextComposition(target, false);
  run(key({ target, key: ordinaryKey, stopImmediatePropagation() { this.stopped = true; } }));
  assert.deepEqual(calls, [expected]);
});

for (const eventKey of ["Enter", " "]) test(`text tool buttons activate with ${JSON.stringify(eventKey)} without completing capture`, () => {
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/annotation/TextToolPicker.tsx", import.meta.url), "utf8");
  const selected = [];
  const anchor = {getBoundingClientRect: () => ({left: 20, top: 20, bottom: 48}), focus() {}};
  const h = createLibraryHarness({}, source, {
    modules: {"./callout-controls.css": {}},
    attachRef(node) {if (node.props?.className === "kiri-text-tool-toggle") node.props.ref.current = anchor;},
  });
  h.window.innerWidth = 800; h.window.innerHeight = 600;
  const picker = h.mount("TextToolPicker", {tool: "select", onSelect: value => selected.push(value)});
  const overlay = windowHandler("OverlayWindow.tsx", "onKeyDown");
  const activate = button => {
    const event = key({key: eventKey});
    button.props.onKeyDown(event);
    if (!event.stopped) overlay.run(event);
    assert.equal(event.defaultPrevented, false, "native button activation remains available");
    button.props.onClick();
  };
  let tree = picker.render();
  activate(nodes(tree).find(node => node?.props?.className === "kiri-text-tool-main"));
  assert.deepEqual(selected, ["text"]);
  tree = picker.render();
  activate(nodes(tree).find(node => node?.props?.className === "kiri-text-tool-toggle"));
  tree = picker.render();
  assert.ok(nodes(tree).some(node => node?.props?.role === "menu"));
  const option = nodes(tree).find(node => node?.props?.role === "menuitemradio" && nodes(node).includes("Numbered callout"));
  option.props.onClick();
  assert.deepEqual(selected, ["text", "callout"]);
  assert.deepEqual(overlay.calls, [], "tool activation never reaches confirmCapture");
  picker.unmount();
});
