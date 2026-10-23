import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests, testAsset } from "./helpers/library-render-harness.mjs";
import * as viewerState from "../src/windows/viewer-state.js";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/ocr/TextHistory.tsx", import.meta.url), "utf8");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (id, text) => ({ ...testAsset, id, ocrText: text });
const hasText = (tree, text) => nodes(tree).includes(text);
// Text History passes its edit controls to the real reader's toolbar slot.
const button = (tree, text) => {
  const reader = nodes(tree).find((node) => node?.type?.name === "TextReader");
  return [...nodes(tree), ...nodes(reader?.props.actions)].find((node) => node?.type === "button" && hasText(node, text));
};

test("an older search response cannot replace the current text history", async () => {
  const first = deferred(), second = deferred();
  const queries = [];
  const harness = createLibraryHarness({ listOcrRecords: (query) => { queries.push(query); return query ? second.promise : first.promise; } }, source);
  const component = harness.mount("TextHistory");
  let tree = component.render();
  await pause(5);
  nodes(tree).find((node) => node?.type === "input").props.onChange({ target: { value: "new" } });
  component.render();
  await pause(170);
  second.resolve([record("new", "Newest result")]);
  await settleRequests();
  tree = component.render();
  assert.equal(hasText(tree, "Newest result"), true);
  first.resolve([record("old", "Old result")]);
  await settleRequests();
  tree = component.render();
  assert.equal(hasText(tree, "Newest result"), true);
  assert.equal(hasText(tree, "Old result"), false);
  assert.deepEqual(queries, ["", "new"]);
  component.unmount();
});

test("copy completion for another record never marks the newly selected text copied", async () => {
  const pending = deferred();
  const copied = [];
  const harness = createLibraryHarness({ copyHistoryText: (text) => { copied.push(text); return pending.promise; } }, source);
  const component = harness.mount("TextReader", { text: "first", imageId: "one" });
  let tree = component.render();
  button(tree, "Copy Text").props.onClick();
  component.render({ text: "second", imageId: "two" });
  pending.resolve(); await settleRequests();
  tree = component.render();
  assert.deepEqual(copied, ["first"]);
  assert.equal(hasText(tree, "Text Copied"), false);
  component.unmount();
});

test("copy failures and unsaved recognition remain visible without losing text", async () => {
  const harness = createLibraryHarness({ copyHistoryText: async () => { throw new Error("clipboard unavailable"); } }, source);
  const component = harness.mount("TextReader", { text: "keep this text", saved: false });
  let tree = component.render();
  button(tree, "Copy Text").props.onClick(); await settleRequests(); tree = component.render();
  assert.equal(hasText(tree, "keep this text"), true);
  assert.equal(hasText(tree, "Couldn't copy text."), true);
  assert.equal(hasText(tree, "History wasn't saved. Copy the text before closing."), true);
  component.unmount();
});

test("OCR dialog starts once and reads saved text without recognizing again", async () => {
  let calls = 0;
  const pending = deferred();
  const harness = createLibraryHarness({ recognizeAssetLocal: () => { calls++; return pending.promise; } }, source);
  const component = harness.mount("OcrDialog", { asset: testAsset, onClose() {} });
  component.render(); component.render(); assert.equal(calls, 1);
  component.unmount(); pending.resolve({ text: "complete", saved: true, asset: record("new", "complete") }); await settleRequests();
  const saved = harness.mount("OcrDialog", { asset: record("saved", "already recognized"), onClose() {} });
  saved.render(); assert.equal(calls, 1); saved.unmount();
});

test("an already open OCR dialog uses refreshed saved corrections", async () => {
  const harness = createLibraryHarness({ recognizeAssetLocal: () => { throw new Error("saved text must not be recognized again"); } }, source);
  const component = harness.mount("OcrDialog", { asset: record("saved", "first version"), onClose() {} });
  const reader = (tree) => nodes(tree).find(node => node?.type?.name === "TextReader");
  assert.equal(reader(component.render()).props.text, "first version");
  const updated = record("saved", "second version");
  assert.equal(reader(component.render({ asset: updated, onClose() {} })).props.text, "second version");
  const restored = record("saved", "original version");
  assert.equal(reader(component.render({ asset: restored, onClose() {} })).props.text, "original version");
  component.unmount();
});

test("an existing source viewer refreshes OCR metadata after saved asset changes", async () => {
  let asset = record("saved", "first version");
  const viewerSource = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ViewerWindow.tsx", import.meta.url), "utf8");
  const harness = createLibraryHarness({
    getAsset: async () => asset,
    platformCapabilities: async () => ({ videoEditing: false }),
  }, viewerSource, { modules: {
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ close: async () => {} }) },
    "./VideoTrimPlayer": { VideoTrimPlayer: "video-player" },
    "./viewer-state.js": viewerState,
  } });
  const viewer = harness.mount("ViewerWindow", { id: asset.id });
  viewer.render(); await settleRequests();
  button(viewer.render(), "Read Text").props.onClick();
  const dialog = () => nodes(viewer.render()).find(node => node?.type === "ocr-dialog");
  assert.equal(dialog().props.asset.ocrText, "first version");
  for (const text of ["second version", "third version"]) {
    asset = record("saved", text);
    harness.emit("assetContentChanged", asset.id); await settleRequests();
    assert.equal(dialog().props.asset.ocrText, text);
  }
  viewer.unmount();
});

test("load failures are not presented as empty history", async () => {
  const harness = createLibraryHarness({ listOcrRecords: async () => { throw new Error("offline"); } }, source);
  const component = harness.mount("TextHistory"); component.render(); await pause(5); await settleRequests();
  const tree = component.render();
  assert.equal(hasText(tree, "Couldn't load Text History."), true);
  assert.equal(hasText(tree, "Your text, ready to revisit"), false);
  component.unmount();
});

test("OCR history saves a correction, restores the original, and cancels an edit", async () => {
  let current = record("ocr-1", "tezt");
  const changes = [];
  const harness = createLibraryHarness({
    listOcrRecords: async () => [current],
    updateOcrHistoryText: async (id, expectedText, replacement) => {
      changes.push([id, expectedText, replacement]);
      current = { ...current, ocrText: replacement ?? current.ocrOriginalText,
        ocrOriginalText: replacement == null ? null : current.ocrOriginalText ?? expectedText };
      return current;
    },
  }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  let tree = component.render();
  button(tree, "Edit Text").props.onClick();
  tree = component.render();
  const editor = nodes(tree).find((node) => node?.props?.editor?.type === "textarea")?.props.editor;
  editor.props.onChange({ target: { value: "text" } });
  tree = component.render();
  button(tree, "Save").props.onClick(); await settleRequests();
  tree = component.render();
  assert.deepEqual(changes[0], ["ocr-1", "tezt", "text"]);
  assert.equal(hasText(tree, "text"), true);
  assert.ok(button(tree, "Restore Original Text"));
  button(tree, "Restore Original Text").props.onClick(); await settleRequests();
  tree = component.render();
  assert.deepEqual(changes[1], ["ocr-1", "text", null]);
  assert.equal(hasText(tree, "tezt"), true);
  assert.equal(button(tree, "Restore Original Text"), undefined);
  button(tree, "Edit Text").props.onClick();
  tree = component.render();
  nodes(tree).find((node) => node?.props?.editor?.type === "textarea")?.props.editor.props.onChange({ target: { value: "discarded" } });
  tree = component.render();
  button(tree, "Cancel").props.onClick();
  tree = component.render();
  assert.equal(hasText(tree, "tezt"), true);
  assert.equal(changes.length, 2);
  component.unmount();
});

test("a library refresh cannot rebase an open correction over another window's edit", async () => {
  let current = record("ocr-1", "original");
  const changes = [];
  const harness = createLibraryHarness({
    listOcrRecords: async () => [current],
    updateOcrHistoryText: async (id, expectedText, replacement) => {
      changes.push([id, expectedText, replacement]);
      if (expectedText !== current.ocrText) throw new Error("OCR text changed");
      current = { ...current, ocrText: replacement };
      return current;
    },
  }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  button(component.render(), "Edit Text").props.onClick();
  const editor = tree => nodes(tree).find(node => node?.props?.editor?.type === "textarea")?.props.editor;
  editor(component.render()).props.onChange({ target: { value: "my correction" } });
  component.render();
  current = record("ocr-1", "other window's correction");
  harness.emit("libraryChanged"); component.render();
  await pause(5); await settleRequests();
  button(component.render(), "Save").props.onClick(); await settleRequests();
  const tree = component.render();
  assert.deepEqual(changes, [["ocr-1", "original", "my correction"]]);
  assert.equal(current.ocrText, "other window's correction");
  assert.equal(editor(tree).props.value, "my correction");
  assert.equal(hasText(tree, "Couldn't save the text. Reload Text History and try again."), true);
  component.unmount();
});


test("OCR correction keeps its draft when record or search navigation is attempted", async () => {
  const queries = [];
  const harness = createLibraryHarness({ listOcrRecords: async query => {
    queries.push(query); return [record("one", "first original"), record("two", "second original")];
  } }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  button(component.render(), "Edit Text").props.onClick();
  const reader = () => nodes(component.render()).find(node => node?.type?.name === "TextReader");
  reader().props.editor.props.onChange({ target: { value: "keep my correction" } });
  const tree = component.render();
  const other = nodes(tree).find(node => node?.props?.className === "ocr-history__item" && hasText(node, "second original"));
  const search = nodes(tree).find(node => node?.type === "input");
  assert.equal(other.props.disabled, true);
  assert.equal(search.props.disabled, true);
  other.props.onClick();
  search.props.onChange({ target: { value: "second" } });
  assert.equal(reader().props.editor.props.value, "keep my correction");
  assert.equal(reader().props.text, "first original");
  await pause(170); await settleRequests();
  assert.deepEqual(queries, [""]);
  button(component.render(), "Cancel").props.onClick();
  assert.equal(nodes(component.render()).find(node => node?.type === "input").props.disabled, false);
  component.unmount();
});

test("an in-flight search and library refresh retain the editing record until cancellation", async () => {
  const filtered = deferred();
  let failRefresh = false;
  const harness = createLibraryHarness({ listOcrRecords: async query => {
    if (failRefresh) throw new Error("offline");
    return query ? filtered.promise : [record("one", "first original"), record("two", "second original")];
  } }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  nodes(component.render()).find(node => node?.type === "input").props.onChange({ target: { value: "second" } });
  component.render(); await pause(170);
  button(component.render(), "Edit Text").props.onClick();
  const reader = () => nodes(component.render()).find(node => node?.type?.name === "TextReader");
  reader().props.editor.props.onChange({ target: { value: "keep my correction" } });
  filtered.resolve([record("two", "second original")]); await settleRequests();
  assert.equal(reader().props.editor.props.value, "keep my correction");
  assert.equal(reader().props.text, "first original");
  failRefresh = true; harness.emit("libraryChanged"); component.render(); await pause(170); await settleRequests();
  assert.equal(reader().props.editor.props.value, "keep my correction", "a failed refresh cannot hide the only draft");
  assert.equal(hasText(component.render(), "Couldn't load Text History."), true);
  failRefresh = false; harness.emit("libraryChanged"); component.render(); await pause(170); await settleRequests();
  button(component.render(), "Cancel").props.onClick();
  assert.equal(reader().props.editor, undefined);
  assert.equal(reader().props.text, "second original");
  component.unmount();
});

test("IME Escape preserves OCR correction across native flags and composition lifecycle", async () => {
  const harness = createLibraryHarness({ listOcrRecords: async () => [record("one", "original")] }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  button(component.render(), "Edit Text").props.onClick();
  const editor = () => nodes(component.render()).find(node => node?.props?.editor?.type === "textarea")?.props.editor;
  editor().props.onChange({ target: { value: "正在校正" } });
  const target = {};
  const escape = flags => ({ key: "Escape", target, currentTarget: target, stopPropagation() {}, preventDefault() {}, ...flags });
  editor().props.onKeyDown(escape({ nativeEvent: { isComposing: true, target } }));
  assert.equal(editor().props.value, "正在校正");
  editor().props.onKeyDown(escape({ keyCode: 229 }));
  assert.equal(editor().props.value, "正在校正");
  editor().props.onCompositionStart({ currentTarget: target });
  editor().props.onKeyDown(escape({ isComposing: false }));
  assert.equal(editor().props.value, "正在校正");
  editor().props.onCompositionEnd({ currentTarget: target });
  editor().props.onKeyDown(escape({}));
  assert.equal(editor(), undefined, "ordinary Escape still cancels the edit");
  component.unmount();
});

test("a pending OCR save locks further typing and Escape until success or failure", async () => {
  for (const succeeds of [true, false]) {
    const pending = deferred();
    const changes = [];
    const harness = createLibraryHarness({
      listOcrRecords: async () => [record("one", "original")],
      updateOcrHistoryText: (...args) => { changes.push(args); return pending.promise; },
    }, source);
    const component = harness.mount("TextHistory");
    component.render(); await pause(5); await settleRequests();
    button(component.render(), "Edit Text").props.onClick();
    const editor = () => nodes(component.render()).find(node => node?.props?.editor?.type === "textarea")?.props.editor;
    editor().props.onChange({ target: { value: "submitted correction" } });
    const beforeSave = editor();
    const save = button(component.render(), "Save");
    save.props.onClick(); save.props.onClick();
    beforeSave.props.onChange({ target: { value: "would be silently lost" } });
    beforeSave.props.onKeyDown({ key: "Escape", stopPropagation() {}, preventDefault() {} });
    assert.equal(editor().props.disabled, true);
    assert.equal(editor().props.value, "submitted correction");
    assert.deepEqual(changes, [["one", "original", "submitted correction"]]);
    if (succeeds) pending.resolve(record("one", "submitted correction"));
    else pending.reject(new Error("save failed"));
    await settleRequests();
    if (succeeds) assert.equal(editor(), undefined);
    else {
      assert.equal(editor().props.value, "submitted correction");
      assert.equal(editor().props.disabled, false);
      assert.equal(hasText(component.render(), "Couldn't save the text. Reload Text History and try again."), true);
    }
    component.unmount();
  }
});
