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

// Render both real components with the same mocked hooks/IPC. Reconcile the
// history child from the parent's returned tree so leaving Text History runs
// its cleanup and discards its local hooks, as a real navigation would.
const workspaceSource = readFileSync(new URL("../src/windows/LibraryWindow.tsx", import.meta.url), "utf8")
  .replace('import { TextHistory, OcrDialog } from "../ocr/TextHistory";', "") +
  '\nimport { isTextComposition, setTextComposition } from "../annotation/text-composition.js";\n' +
  'import { useRecordSelection } from "../components/useRecordSelection";\n' +
  'import { RecordMoreActions } from "../components/RecordMoreActions";\n' +
  source.replace(/^import .*$/gm, "");

async function textWorkspace(api = {}) {
  const harness = createLibraryHarness({ listOcrRecords: async () => [record("one", "original")], ...api }, workspaceSource);
  const library = harness.mount("LibraryWindow");
  let history;
  const render = () => {
    const tree = library.render();
    const child = nodes(tree).find(node => node?.type?.name === "TextHistory");
    if (!child) { history?.unmount(); history = undefined; }
    else { history ??= harness.mount("TextHistory", child.props); }
    return { tree, history: history?.render(child.props) };
  };
  const navigate = index => {
    nodes(render().tree).find(node => node?.type?.name === "SegmentedPicker").props.onChange(index);
    return render();
  };
  render(); await settleRequests(); navigate(1); await pause(5); await settleRequests();
  return {
    render, navigate, harness,
    unmount() { history?.unmount(); library.unmount(); },
    edit(value) {
      button(render().history, "Edit Text").props.onClick();
      nodes(render().history).find(node => node?.props?.editor?.type === "textarea").props.editor.props.onChange({ target: { value } });
    },
    editor() { return nodes(render().history).find(node => node?.props?.editor?.type === "textarea")?.props.editor; },
  };
}

test("main navigation keeps an unsaved OCR correction until explicit cancellation", async () => {
  const workspace = await textWorkspace();
  const staleNavigate = nodes(workspace.render().tree).find(node => node?.type?.name === "SegmentedPicker").props.onChange;
  workspace.edit("keep my correction");
  staleNavigate(0);
  assert.equal(workspace.editor()?.props.value, "keep my correction", "even a pre-edit sidebar handler observes the synchronous lock");
  for (const destination of [0, 2, 3, 4]) {
    workspace.navigate(destination);
    assert.equal(workspace.editor()?.props.value, "keep my correction");
  }
  const picker = nodes(workspace.render().tree).find(node => node?.type?.name === "SegmentedPicker");
  const buttons = nodes(picker.type(picker.props)).filter(node => node?.type === "button");
  assert.equal(buttons.filter(node => node.props.disabled).length, 4);
  button(workspace.render().history, "Cancel").props.onClick();
  assert.equal(workspace.navigate(4).history, undefined);
  workspace.navigate(1); await pause(5); await settleRequests();
  assert.equal(workspace.editor(), undefined);
  workspace.unmount();
});

test("navigation during a failed OCR save retains the submitted draft and error for retry", async () => {
  const pending = deferred();
  const changes = [];
  let attempt = 0;
  const workspace = await textWorkspace({ updateOcrHistoryText: (...args) => {
    changes.push(args);
    return attempt++ ? Promise.resolve(record("one", "keep my correction")) : pending.promise;
  } });
  workspace.edit("keep my correction");
  button(workspace.render().history, "Save").props.onClick();
  // Directly exercise the handler as well as the rendered disabled state.
  workspace.navigate(0);
  assert.equal(workspace.editor()?.props.disabled, true);
  pending.reject(new Error("index write failed")); await settleRequests();
  workspace.navigate(1);
  assert.equal(workspace.editor()?.props.value, "keep my correction");
  assert.equal(hasText(workspace.render().history, "Couldn't save the text. Reload Text History and try again."), true);
  workspace.navigate(2);
  assert.equal(workspace.editor()?.props.value, "keep my correction");
  button(workspace.render().history, "Save").props.onClick(); await settleRequests();
  assert.deepEqual(changes, [["one", "original", "keep my correction", null], ["one", "original", "keep my correction", null]]);
  assert.equal(workspace.editor(), undefined);
  assert.equal(workspace.navigate(0).history, undefined);
  workspace.unmount();
});

test("successful OCR saving releases main navigation after its pending operation", async () => {
  const pending = deferred();
  const workspace = await textWorkspace({ updateOcrHistoryText: () => pending.promise });
  workspace.edit("saved correction");
  button(workspace.render().history, "Save").props.onClick();
  workspace.navigate(4);
  assert.equal(workspace.editor()?.props.value, "saved correction");
  pending.resolve(record("one", "saved correction")); await settleRequests();
  assert.equal(workspace.editor(), undefined);
  assert.equal(workspace.navigate(4).history, undefined);
  workspace.unmount();
});

for (const operation of ["import", "paste"]) test(`a previously started media ${operation} cannot navigate away from an OCR correction`, async () => {
  const pending = deferred();
  const workspace = await textWorkspace({ importMedia: () => pending.promise, pasteClipboardImage: () => pending.promise });
  workspace.navigate(0);
  button(workspace.render().tree, operation === "import" ? "Import media" : "Paste Image").props.onClick();
  workspace.navigate(1); await pause(5); await settleRequests();
  workspace.edit("keep my correction");
  pending.resolve({ ids: ["imported"], failed: 0 }); await settleRequests();
  assert.equal(workspace.editor()?.props.value, "keep my correction");
  workspace.unmount();
});

test("a media drop during OCR editing cannot start an import that discards the draft", async () => {
  let imports = 0;
  const workspace = await textWorkspace({ importMedia: async () => { imports++; return { ids: ["imported"], failed: 0 }; } });
  workspace.edit("keep my correction");
  workspace.harness.emit("mediaDrop", { payload: { type: "drop", paths: ["/test/image.png"] } });
  await settleRequests();
  assert.equal(imports, 0);
  assert.equal(workspace.editor()?.props.value, "keep my correction");
  workspace.unmount();
});

test("restoring original OCR text only blocks navigation until its request settles", async () => {
  for (const succeeds of [false, true]) {
    const pending = deferred();
    const workspace = await textWorkspace({
      listOcrRecords: async () => [{ ...record("one", "correction"), ocrOriginalText: "original" }],
      updateOcrHistoryText: () => pending.promise,
    });
    button(workspace.render().history, "Restore Original Text").props.onClick();
    assert.ok(workspace.navigate(0).history);
    if (succeeds) pending.resolve(record("one", "original"));
    else pending.reject(new Error("save failed"));
    await settleRequests();
    assert.equal(workspace.navigate(0).history, undefined);
    workspace.unmount();
  }
});

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
    updateOcrHistoryText: async (id, expectedText, replacement, expectedRevision) => {
      changes.push([id, expectedText, replacement, expectedRevision]);
      if (expectedText !== current.ocrText || expectedRevision !== (current.ocrRevision ?? null)) throw new Error("OCR text changed");
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
  current = { ...record("ocr-1", "other window's correction"), ocrRevision: "different-revision" };
  harness.emit("libraryChanged"); component.render();
  await pause(5); await settleRequests();
  button(component.render(), "Save").props.onClick(); await settleRequests();
  const tree = component.render();
  assert.deepEqual(changes, [["ocr-1", "original", "my correction", null]]);
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
    assert.deepEqual(changes, [["one", "original", "submitted correction", null]]);
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


test("a single history record can move directly to Trash and reports a failed attempt", async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  let records = [record("one", "first"), record("two", "second")];
  const harness = createLibraryHarness({
    listOcrRecords: async () => records,
    moveToTrash: id => { requests.push(id); return requests.length === 1 ? first.promise : second.promise; },
  }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  const reader = () => nodes(component.render()).find(node => node?.type?.name === "TextReader");
  const initial = component.render();
  const initialReader = nodes(initial).find(node => node?.type?.name === "TextReader");
  const trash = button(initial, "Move to Trash");
  assert.ok(initialReader.props.actions.props.children.includes(trash), "Trash is visible outside the overflow menu");
  trash.props.onClick(); trash.props.onClick();
  assert.deepEqual(requests, ["one"]);
  first.reject(new Error("write failed")); await settleRequests();
  assert.equal(reader().props.text, "first");
  assert.equal(hasText(component.render(), "Couldn't move this text to Trash."), true);
  button(component.render(), "Move to Trash").props.onClick();
  records = records.slice(1);
  second.resolve(); await settleRequests();
  assert.equal(reader().props.text, "second");
  assert.equal(hasText(component.render(), "Couldn't move this text to Trash."), false);
  component.unmount();
});

const preparedRequest = (requestId, profile = null) => ({
  requestId, imageWidth: 100, imageHeight: 200, byteLength: 800, profile,
  engine: profile ? { kind: "profile", profileId: profile.id } : { kind: "local" },
});

test("recognizing a corrected record asks before replacement and sends only after remote approval", async () => {
  for (const profile of [null, { id: "remote", name: "Selected provider", origin: "https://ocr.example", model: "chosen", revision: 2 }]) {
    const starts = [], sends = [], cancellations = [];
    const pending = deferred();
    const harness = createLibraryHarness({
      listOcrRecords: async () => [{ ...record("one", "my correction"), ocrOriginalText: "machine text", ocrRevision: "rev-1" }],
      prepareOcrHistoryRequest: async (...args) => { starts.push(args); return preparedRequest(String(starts.length), profile); },
      recognizeOcrHistoryRequest: (...args) => { sends.push(args); return pending.promise; },
      cancelOcrHistoryRequest: async id => { cancellations.push(id); },
    }, source);
    const component = harness.mount("TextHistory");
    component.render(); await pause(5); await settleRequests();
    const consent = () => nodes(component.render()).find(node => node?.type?.name === "HistoryRecognitionDialog");
    const begin = button(component.render(), "Recognize Again");
    begin.props.onClick(); begin.props.onClick(); await settleRequests();
    assert.deepEqual(starts, [["one", "rev-1"]]);
    assert.equal(consent().props.consent.replaceCorrection, true);
    assert.equal(consent().props.consent.prepared.profile, profile);
    assert.deepEqual(sends, []);
    consent().props.onCancel();
    assert.equal(consent(), undefined);
    assert.deepEqual(cancellations, ["1"]);

    button(component.render(), "Recognize Again").props.onClick(); await settleRequests();
    const { onConfirm } = consent().props;
    onConfirm(); onConfirm();
    assert.deepEqual(sends, [["2", Boolean(profile), true]]);
    assert.equal(button(component.render(), "Edit Text").props.disabled, true);
    pending.resolve(null); await settleRequests();
    assert.equal(hasText(component.render(), "No text found. The saved text was kept."), true);
    assert.ok(button(component.render(), "Restore Original Text"));
    component.unmount();
  }
});

test("local rerecognition retries IPC failures and ignores a late list that predates the save", async () => {
  let current = record("one", "older text");
  const lateList = deferred();
  const recognition = deferred();
  let nextList, calls = 0;
  const harness = createLibraryHarness({
    listOcrRecords: () => nextList ?? Promise.resolve([current]),
    prepareOcrHistoryRequest: async () => preparedRequest("local"),
    recognizeOcrHistoryRequest: (_id, sendRemote, replaceCorrection) => {
      assert.equal(sendRemote, false);
      assert.equal(replaceCorrection, false);
      return calls++ === 0 ? Promise.reject(new Error("IPC failed")) : recognition.promise;
    },
  }, source);
  const component = harness.mount("TextHistory");
  component.render(); await pause(5); await settleRequests();
  button(component.render(), "Recognize Again").props.onClick(); await settleRequests();
  assert.equal(hasText(component.render(), "Couldn't recognize this text again."), true);
  component.render(); await pause(5); await settleRequests();

  button(component.render(), "Recognize Again").props.onClick(); await settleRequests();
  nextList = lateList.promise;
  harness.emit("libraryChanged"); component.render(); await pause(5);
  const old = current;
  current = { ...record("one", "fresh text"), ocrRevision: "rev-2" };
  recognition.resolve(current); await settleRequests();
  lateList.resolve([old]); await settleRequests();
  nextList = null;
  assert.equal(hasText(component.render(), "older text"), false);
  assert.equal(hasText(component.render(), "fresh text"), true);
  assert.equal(hasText(component.render(), "New text saved."), true);
  component.unmount();
});
