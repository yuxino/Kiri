import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";
import * as crop from "../src/annotation/crop.js";
import * as editorDocument from "../src/annotation/editor-document.js";
import * as imageEditState from "../src/annotation/image-edit-state.js";
import * as project from "../src/annotation/project.js";
import * as textComposition from "../src/annotation/text-composition.js";
import * as interactionLock from "../src/annotation/interaction-lock.js";

const editorSource = 'import React from "react";\n' + readFileSync(new URL("../src/windows/EditorWindow.tsx", import.meta.url), "utf8");
const overlaySource = 'import React from "react";\n' + readFileSync(new URL("../src/qr/QrOverlay.tsx", import.meta.url), "utf8");
const text = { kind: "text", id: 1, text: "saved", rect: { x: 8, y: 5, width: 80, height: 24 }, color: "white", background: "transparent", fontSize: 18 };
const find = (tree, type) => nodes(tree).find(node => node?.type === type);
const tool = (tree, title) => nodes(tree).find(node => node?.props?.title === title);
const button = (tree, title) => nodes(tree).find(node => node?.type === "button" && nodes(node).includes(title));
const qr = tree => find(tree, "qr-overlay");
const scan = (id, width = 1200, height = 800, codes = [{index: 0}]) => ({ requestId: id, width, height, codes, imageUrl: "unused-preview" });

function editor(options = {}) {
  const calls = [], mutations = [];
  let listener, sequence = 0, resize, pendingIntent = options.pendingIntent ?? false;
  const size = { width: options.width ?? 1200, height: options.height ?? 800 };
  const document = { schemaVersion: 1, canvas: { width: size.width / 2, height: size.height / 2 }, sourcePixels: size, marks: [text] };
  const container = { clientWidth: 800, clientHeight: 560 };
  const snapshot = { state: "valid", readOnly: options.readOnly ?? false, revisionSha256: "opened-revision", documentJson: JSON.stringify(document) };
  const canvas = {
    exportResult: async () => { mutations.push("export"); return null; },
    undo: () => mutations.push("undo"), redo: () => mutations.push("redo"),
    deleteSelection: () => mutations.push("delete"),
  };
  const api = {
    getAssetAnnotationProject: async () => options.snapshot ? await options.snapshot : snapshot,
    scanQr: (...args) => { calls.push(args); return options.scanQr?.(...args) ?? Promise.resolve(scan(args[0], size.width, size.height)); },
    cancelQr: async id => { calls.push(["cancel", id]); },
    getAsset: async () => { mutations.push("getAsset"); return null; },
    takeEditorQrRequest: async () => { const requested = pendingIntent; pendingIntent = false; return requested; },
  };
  const harness = createLibraryHarness({}, editorSource, {
    search: options.search,
    strictEffects: options.strictEffects,
    modules: {
      "../lib/ipc": { api, isEditorRevisionMismatch: error => String(error) === "The screenshot changed after the editor opened.",
        onEditorRecognizeQr: async callback => { listener = callback; if (options.listenerReady) await options.listenerReady; return () => { if (listener === callback) listener = null; }; } },
      "../annotation/model": { COLOR_HEX: { white: "#fff" }, COLOR_LABELS: { white: "White" }, COLOR_PRESETS: ["white"],
        nextCalloutNumber: marks => Math.min(999, marks.reduce((next,mark) => mark.kind === "callout" ? Math.max(next,mark.number+1) : next,1)) },
      "../annotation/LabelControls": {LabelControls: props => ({type:"label-controls",props})},
      "../annotation/CalloutControls": {CalloutControls: "callout-controls"},
      "../annotation/TextToolPicker": {TextToolPicker: "text-tool-picker"},
      "../annotation/text-composition.js": textComposition,
      "../annotation/useAnnotationAppearance": { useAnnotationAppearance: () => [{ color: "white", penWidth: 3, shapeWidth: 2, textFontSize: 18, textBackgroundStyle: "transparent", mosaicBrushDiameter: 24, mosaicStyle: "pixel", mosaicIntensity: "standard" }, () => {}] },
      "../annotation/AnnotationCanvas": { __esModule: true, default: "annotation-canvas" },
      "../annotation/CropOverlay": { CropOverlay: "crop-overlay" },
      "../annotation/crop.js": crop,
      "../annotation/editor-document.js": editorDocument,
      "../annotation/interaction-lock.js": interactionLock,
      "../annotation/project.js": project,
      "../annotation/image-edit-state.js": imageEditState,
      "../qr/QrOverlay": { QrOverlay: "qr-overlay" },
      "./ImageCloseGuard": { ImageCloseGuard: "image-close-guard" },
    },
    globals: {
      crypto: { randomUUID: () => `request-${++sequence}` },
      fetch: async () => ({ ok: true, blob: async () => ({}) }),
      URL: { createObjectURL: () => "blob:opened-clean-source", revokeObjectURL: () => {} },
      Image: class { naturalWidth = size.width; naturalHeight = size.height; complete = true; async decode() {} },
      ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
      Element: class {},
    },
    attachRef(node) {
      if (!node.props?.ref) return;
      if (node.type === "div") node.props.ref.current = container;
      if (node.type === "annotation-canvas") node.props.ref.current = canvas;
      if (node.type === "image-close-guard") node.props.ref.current = {
        requestClose: async () => mutations.push("closeEditor"),
        closeSaved: async () => mutations.push("closeSaved"),
      };
    },
  });
  const component = harness.mount("EditorWindow", { id: "saved-image" });
  return { ...harness, component, calls, mutations, document,
    recognize: () => { pendingIntent = true; listener?.(); },
    resize: (width, height) => { container.clientWidth = width; container.clientHeight = height; resize(); },
    key(key, extra = {}) {
      const event = { type: "keydown", key, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
      harness.window.dispatchEvent(event);
      return event;
    },
  };
}

async function loadedEditor(options) {
  const h = editor(options);
  h.component.render();
  await settleRequests();
  h.component.render();
  return h;
}

test("saved-image recognition uses the original stage and exact opened revision without exporting edits", async () => {
  const h = await loadedEditor();
  const before = h.component.render();
  const source = find(before, "annotation-canvas").props.image;
  tool(before, "Recognize QR Codes").props.onClick();
  let tree = h.component.render();
  assert.deepEqual(h.calls[0], ["request-1", null, "saved-image", "opened-revision"]);
  assert.equal(qr(tree).props.scan, null);
  assert.equal(find(tree, "annotation-canvas").props.image, source);
  assert.equal(find(tree, "annotation-canvas").props.interactionDisabled, true);
  assert.ok(nodes(tree).some(node => node?.props?.style?.backgroundImage === 'url("blob:opened-clean-source")'));
  assert.ok(nodes(tree).some(node => node?.props?.style?.visibility === "hidden"));
  assert.equal(nodes(tree).some(node => ["dialog", "img", "qr-dialog"].includes(node?.type)), false);
  assert.deepEqual(h.mutations, []);
  await settleRequests();
  tree = h.component.render();
  assert.equal(qr(tree).props.scan.requestId, "request-1");
  qr(tree).props.onOpened();
  tree = h.component.render();
  assert.equal(qr(tree), undefined);
  assert.equal(find(tree, "annotation-canvas").props.image, source);
  assert.equal(find(tree, "annotation-canvas").props.interactionDisabled, false);
  assert.equal(nodes(tree).some(node => node?.props?.style?.visibility === "hidden"), false);
  assert.deepEqual(h.mutations, [], "default-browser success leaves this editor open");
  h.component.unmount();
});

test("QR arrows follow centered aspect-fit CSS pixels across resize, independent of the logical document and pending crop", async () => {
  const h = await loadedEditor();
  tool(h.component.render(), "Crop (C)").props.onClick();
  let tree = h.component.render();
  const pendingCrop = { x: 30, y: 40, width: 350, height: 210 };
  find(tree, "crop-overlay").props.onChange(pendingCrop);
  tool(h.component.render(), "Recognize QR Codes").props.onClick();
  tree = h.component.render();
  assert.equal(qr(tree).props.sourceRect.x, 0);
  assert.equal(qr(tree).props.sourceRect.width, 800);
  assert.ok(Math.abs(qr(tree).props.sourceRect.y - 40 / 3) < 1e-9);
  assert.ok(Math.abs(qr(tree).props.sourceRect.height - 1600 / 3) < 1e-9);
  assert.deepEqual(find(tree, "annotation-canvas").props.region, { x: 0, y: 0, width: 600, height: 400 });
  assert.deepEqual(find(tree, "crop-overlay").props.selection, pendingCrop);
  assert.equal(find(tree, "crop-overlay").props.active, false);
  h.resize(250, 100);
  tree = h.component.render();
  assert.deepEqual(qr(tree).props.sourceRect, { x: 50, y: 0, width: 150, height: 100 });
  assert.deepEqual(qr(tree).props.bounds, { x: 0, y: 0, width: 250, height: 100 });
  h.key("Escape");
  tree = h.component.render();
  assert.deepEqual(find(tree, "crop-overlay").props.selection, pendingCrop);
  assert.equal(find(tree, "crop-overlay").props.active, true);
  h.component.unmount();
});

test("QR pauses background shortcuts synchronously and Escape restores crop, marks and an uncommitted text draft", async () => {
  const pending = deferred();
  const h = await loadedEditor({ scanQr: () => pending.promise });
  let tree = h.component.render();
  const canvas = find(tree, "annotation-canvas");
  canvas.props.onTextDraftChange({ ...text, id: 2, text: "uncommitted" }, null, true);
  canvas.props.onDocumentChange([text, { ...text, id: 3, text: "new mark" }]);
  tool(tree, "Crop (C)").props.onClick();
  tree = h.component.render();
  const cropBefore = find(tree, "crop-overlay").props.selection;
  tool(tree, "Recognize QR Codes").props.onClick();
  assert.equal(canvas.props.interactionLock.locked, true, "first await already prevents canvas mutation");
  assert.equal(find(tree, "image-close-guard").props.lock.locked, false, "native close retains its dirty-edit guard");
  for (const [key, extra] of [["Enter", {}], ["z", {metaKey: true}], ["Delete", {}], ["v", {}]]) h.key(key, extra);
  tree = h.component.render();
  assert.deepEqual(h.mutations, []);
  assert.equal(button(tree, "Save").props.disabled, true);
  assert.equal(button(tree, "Save As…").props.disabled, true);
  assert.ok(nodes(tree).some(node => node?.props?.inert === true));
  const imeEscape = h.key("Escape", { isComposing: true });
  assert.equal(imeEscape.defaultPrevented, false);
  assert.ok(qr(h.component.render()));
  const escape = h.key("Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  tree = h.component.render();
  assert.equal(qr(tree), undefined);
  assert.deepEqual(find(tree, "crop-overlay").props.selection, cropBefore);
  assert.equal(find(tree, "crop-overlay").props.active, true);
  assert.equal(find(tree, "image-close-guard").props.dirty, true);
  // Restoring the marks still leaves the same uncommitted text draft dirty.
  find(tree, "annotation-canvas").props.onDocumentChange([text]);
  find(tree, "crop-overlay").props.onChange(null);
  tree = h.component.render();
  assert.equal(find(tree, "image-close-guard").props.dirty, true);
  find(tree, "annotation-canvas").props.onTextDraftChange(null, null, false);
  assert.equal(find(h.component.render(), "image-close-guard").props.dirty, false);
  pending.resolve(scan("request-1"));
  await settleRequests();
  assert.equal(qr(h.component.render()), undefined, "a cancelled late scan cannot reopen QR");
  assert.deepEqual(h.calls.filter(call => call[0] === "cancel"), [["cancel", "request-1"]]);
  assert.deepEqual(h.mutations, []);
  h.component.unmount();
});

test("failed and mismatched scans never place arrows; retry uses a new request and ignores old responses", async () => {
  const requests = [deferred(), deferred()];
  let attempt = 0;
  const h = await loadedEditor({ scanQr: () => requests[attempt++].promise });
  tool(h.component.render(), "Recognize QR Codes").props.onClick();
  let tree = h.component.render();
  qr(tree).props.onRetry();
  tree = h.component.render();
  requests[0].reject("old error");
  await settleRequests();
  assert.equal(qr(h.component.render()).props.failed, false);
  requests[1].resolve(scan("request-2", 1199, 800));
  await settleRequests();
  tree = h.component.render();
  assert.equal(qr(tree).props.scan, null);
  assert.equal(qr(tree).props.failed, true);
  assert.equal(qr(tree).props.error, "The screenshot changed. Close and reopen the editor.");
  assert.deepEqual(h.calls.slice(0, 3), [["request-1", null, "saved-image", "opened-revision"], ["cancel", "request-1"], ["request-2", null, "saved-image", "opened-revision"]]);
  h.component.unmount();
});

test("revision rejection retains the source and draft; closing a loading QR request cancels only that request", async () => {
  const h = await loadedEditor({ scanQr: async () => { throw "The screenshot changed after the editor opened."; } });
  let tree = h.component.render();
  find(tree, "annotation-canvas").props.onTextDraftChange({ ...text, id: 2, text: "keep me" }, null, true);
  tool(tree, "Recognize QR Codes").props.onClick();
  await settleRequests();
  tree = h.component.render();
  assert.equal(qr(tree).props.error, "The screenshot changed. Close and reopen the editor.");
  qr(tree).props.onClose();
  tree = h.component.render();
  assert.equal(find(tree, "image-close-guard").props.dirty, true);
  assert.deepEqual(h.mutations, []);
  h.component.unmount();

  const pending = deferred();
  const loading = await loadedEditor({ scanQr: () => pending.promise });
  tool(loading.component.render(), "Recognize QR Codes").props.onClick();
  loading.component.unmount();
  pending.resolve(scan("request-1"));
  await settleRequests();
  assert.deepEqual(loading.calls, [["request-1", null, "saved-image", "opened-revision"], ["cancel", "request-1"]]);
});

test("a canvas cancellation in the pre-render gap only leaves QR and keeps the editor open", async () => {
  const pending = deferred();
  const h = await loadedEditor({ scanQr: () => pending.promise });
  const tree = h.component.render();
  tool(tree, "Recognize QR Codes").props.onClick();
  await find(tree, "annotation-canvas").props.onCancel();
  assert.equal(qr(h.component.render()), undefined);
  assert.deepEqual(h.calls.at(-1), ["cancel", "request-1"]);
  assert.deepEqual(h.mutations, []);
  pending.resolve(scan("request-1"));
  await settleRequests();
  assert.equal(qr(h.component.render()), undefined);
  h.component.unmount();
});

test("new-editor query and existing-editor event both wait for the revision-bound image before scanning", async () => {
  for (const fromQuery of [true, false]) {
    const opening = deferred();
    const h = editor({ search: fromQuery ? "?window=editor&qr=1" : "", snapshot: opening.promise, strictEffects: true });
    h.component.render();
    if (!fromQuery) h.recognize();
    assert.equal(h.calls.length, 0);
    opening.resolve({ state: "valid", revisionSha256: "ready-revision", documentJson: JSON.stringify(h.document) });
    await settleRequests();
    h.component.render();
    assert.deepEqual(h.calls[0], ["request-1", null, "saved-image", "ready-revision"]);
    h.recognize();
    assert.equal(h.calls.length, 1, "repeated entry requests do not duplicate an active scan");
    h.component.unmount();
  }
});

test("OCR images stay read-only after leaving QR and expose only recognition and close", async () => {
  const h = await loadedEditor({ search: "?window=editor&qr=1&readonly=1", readOnly: true });
  let tree = h.component.render();
  assert.ok(qr(tree));
  h.key("Escape");
  tree = h.component.render();
  assert.equal(qr(tree), undefined);
  assert.ok(tool(tree, "Recognize QR Codes"));
  assert.ok(button(tree, "Close"));
  for (const title of ["Crop (C)", "Pen (P)", "Undo (⌘Z)", "Recognize Saved Image Locally"]) assert.equal(tool(tree, title), undefined);
  assert.equal(button(tree, "Save"), undefined);
  assert.equal(button(tree, "Save As…"), undefined);
  assert.equal(find(tree, "annotation-canvas").props.interactionDisabled, true);
  assert.equal(find(tree, "annotation-canvas").props.interactionLock.locked, true);
  for (const [key, extra] of [["Enter", {}], ["z", { metaKey: true }], ["Delete", {}], ["c", {}]]) h.key(key, extra);
  assert.deepEqual(h.mutations, []);
  assert.equal(find(h.component.render(), "image-close-guard").props.dirty, false);
  h.key("Escape");
  assert.deepEqual(h.mutations, ["closeEditor"]);
  h.component.unmount();
});

test("an existing editor drains a queued request after its listener is ready", async () => {
  const ready = deferred();
  const h = await loadedEditor({ pendingIntent: true, listenerReady: ready.promise, strictEffects: true });
  assert.equal(h.calls.length, 0, "no unregistered setup consumes the queued intent");
  ready.resolve();
  await settleRequests();
  let tree = h.component.render();
  assert.deepEqual(h.calls[0], ["request-1", null, "saved-image", "opened-revision"]);
  assert.ok(qr(tree));
  h.key("Escape");
  h.component.render();
  h.recognize();
  await settleRequests();
  tree = h.component.render();
  assert.equal(qr(tree).props.scan.requestId, "request-2");
  assert.equal(h.calls.filter(call => call[0].startsWith("request-")).length, 2);
  h.component.unmount();
});

test("native dirty-guard save first leaves QR and still exports through the original editor", async () => {
  const pending = deferred();
  const h = await loadedEditor({ scanQr: () => pending.promise });
  tool(h.component.render(), "Recognize QR Codes").props.onClick();
  const tree = h.component.render();
  await find(tree, "image-close-guard").props.onSave();
  assert.equal(qr(h.component.render()), undefined);
  assert.deepEqual(h.calls.at(-1), ["cancel", "request-1"]);
  assert.deepEqual(h.mutations, ["export"]);
  h.component.unmount();
});

test("saved editor's compact overlay reuses its CSS source rect; capture keeps outward rounding", () => {
  const harness = createLibraryHarness({}, overlaySource, { modules: { "./QrResults": { QrResults: "qr-results" } } });
  const sourceRect = { x: 50, y: 0, width: 150, height: 100 };
  const viewport = { x: 0, y: 0, width: 250, height: 100 };
  const component = harness.mount("QrOverlay", { scan: scan("request-1"), failed: false,
    sourceRect, selection: {x: 0, y: 0, width: 600, height: 400}, bounds: viewport, scale: 2, onClose() {}, onOpened() {} });
  let tree = component.render();
  assert.equal(find(tree, "qr-results").props.sourceRect, sourceRect);
  assert.equal(find(tree, "qr-results").props.viewport, viewport);
  assert.equal(nodes(tree).some(node => node?.type === "img" || node?.type === "dialog"), false);
  tree = component.render({ scan: scan("capture", 121, 61), failed: false,
    selection: {x: 10.2, y: 20.7, width: 60, height: 30}, bounds: viewport, scale: 2, onClose() {}, onOpened() {} });
  assert.deepEqual(find(tree, "qr-results").props.sourceRect, { x: 10, y: 20.5, width: 60.5, height: 30.5 });
  component.unmount();
});

test("loading, no-result and failure use a small status with close/retry and no duplicated preview", () => {
  let closed = 0, retried = 0;
  const harness = createLibraryHarness({}, overlaySource, { modules: { "./QrResults": { QrResults: "qr-results" } } });
  const props = { scan: null, failed: false, selection: { x: 0, y: 0, width: 400, height: 300 }, bounds: { x: 0, y: 0, width: 400, height: 300 }, scale: 1, onClose: () => closed++, onRetry: () => retried++, onOpened() {} };
  const component = harness.mount("QrOverlay", props);
  let tree = component.render();
  assert.ok(nodes(tree).includes("Recognizing QR Codes…"));
  assert.equal(button(tree, "Retry"), undefined);
  tree = component.render({ ...props, failed: true });
  assert.ok(nodes(tree).includes("QR recognition failed."));
  assert.equal(find(tree, "div").props.className, "qr-overlay");
  button(tree, "Retry").props.onClick();
  nodes(tree).find(node => node?.props?.["aria-label"] === "Close").props.onClick();
  assert.equal(retried, 1); assert.equal(closed, 1);
  tree = component.render({ ...props, scan: scan("empty", 400, 300, []) });
  assert.ok(nodes(tree).includes("No QR codes found. Try a clearer image or a larger selection."));
  assert.ok(button(tree, "Retry"));
  assert.equal(nodes(tree).some(node => ["dialog", "img"].includes(node?.type)), false);
  component.unmount();
});
