import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createLibraryHarness, nodes, settleRequests } from "./helpers/library-render-harness.mjs";
import { AnnotationInteractionLock } from "../src/annotation/interaction-lock.js";
import { isTextComposition } from "../src/annotation/text-composition.js";
import * as toolbarLayout from "../src/windows/toolbar-layout.js";
import * as captureSize from "../src/windows/capture-size.js";

const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
const geometry = { exports: {} };
new Function("exports", ts.transpileModule(
  readFileSync(new URL("../src/annotation/geom.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText)(geometry.exports);

const recordingOptions = { outputFormat: "mp4", usesCountdown: true, capturesSystemAudio: false,
  capturesMicrophone: false, microphoneDeviceId: null, showsCursor: true, highlightsClicks: false };
const colorPicker = { sample: null, feedback: null, clear() {}, onPointerMove() {}, onCopyKeyDown() { return false; } };
const background = { x: 60, y: 80, width: 1320, height: 830 };
const normal = { x: 200, y: 100, width: 800, height: 680 };
const floating = { x: 350, y: 310, width: 480, height: 120 };

class OverlayTarget {
  constructor(ancestors = []) { this.ancestors = new Set(ancestors); }
  closest(selectors) {
    return selectors.split(",").some(selector => this.ancestors.has(selector.trim())) ? this : null;
  }
}

// Mount the entire real OverlayWindow and dispatch its rendered handlers.
// Only native/data-loading boundaries and unrelated child surfaces are stubbed;
// the selection state, geometry, phase changes and rendered outlines stay real.
async function overlay(t, { windowRects = [floating, normal, background], scale = 2,
  devicePixelRatio = scale, width = 1512, height = 982, scrollingCapture = true, expectedCancellations = 0,
  canvasActions = {} } = {}) {
  const errors = [];
  const scrollStarts = [];
  const confirmations = [];
  let cancelled = 0;
  const context = { captureId: "capture-1", displayWidth: width, displayHeight: height, scale,
    pixelWidth: Math.round(width * scale), pixelHeight: Math.round(height * scale),
    windowRects, sourceApplication: "selection-test" };
  const harness = createLibraryHarness({}, source, {
    search: "?window=overlay&captureToken=0123456789abcdef0123456789abcdef",
    attachRef(node) {
      if (node.type === "annotation-canvas") node.props.ref.current = {
        commitTextEditing: () => true, finishAppearanceAdjustment() {}, clearSelection() {},
        exportResult: async () => ({png: new Uint8Array([1]), document: null}),
        cancelInteraction: () => false, ...canvasActions,
      };
    },
    globals: {
      fetch: async () => ({ ok: true, blob: async () => new Blob(["test frozen capture"]) }),
      Image: class { src = ""; },
      ResizeObserver: class { observe() {} disconnect() {} },
      Element: OverlayTarget,
    },
    modules: {
      "@tauri-apps/api/core": { invoke: async (_command, value) => { errors.push(value); } },
      "@tauri-apps/api/window": { getCurrentWindow: () => ({ close: async () => { cancelled++; } }) },
      "../lib/ipc": { DEFAULT_RECORDING_OPTIONS: recordingOptions, api: {
        startCapture: async () => context,
        getRecordingOptions: async () => recordingOptions,
        micSupported: async () => true,
        platformCapabilities: async () => ({ scrollingCapture, recording: true, microphone: true, systemAudio: true, clickHighlights: true }),
        startScrollCapture: async (captureId, selection) => { scrollStarts.push({ captureId, selection }); },
        confirmCapture: async (...args) => { confirmations.push(args); },
        cancelCapture: async () => { cancelled++; },
      } },
      "../annotation/geom": geometry.exports,
      "../annotation/model": { nextCalloutNumber: () => 1 },
      "../annotation/useAnnotationAppearance": { useAnnotationAppearance: () => [{ mosaicShape: "brush" }, () => {}] },
      "../annotation/AnnotationStyleControls": { AnnotationStyleControls: "annotation-style-controls" },
      "../annotation/AnnotationCanvas": { __esModule: true, default: "annotation-canvas" },
      "../annotation/interaction-lock.js": { AnnotationInteractionLock },
      "../annotation/text-composition.js": { isTextComposition },
      "./RecordingMicrophoneSelect": { __esModule: true, default: "microphone-select" },
      "../qr/QrOverlay": { QrOverlay: "qr-overlay" },
      "../ocr/RemoteOcrConsent": { RemoteOcrConsent: "ocr-consent" },
      "../lib/kiri-resource-url.js": { kiriResourceUrl: () => "kiri://capture/frozen/test.png" },
      "./toolbar-layout.js": toolbarLayout,
      "./CaptureSizeControls": { CaptureSizeControls: "capture-size-controls" },
      "./capture-size.js": captureSize,
      "./CaptureColorPicker": { CaptureColorPicker: "color-picker", useCaptureColorPicker: () => colorPicker },
    },
  });
  Object.assign(harness.window, { innerWidth: width, innerHeight: height, devicePixelRatio });
  const component = harness.mount("OverlayWindow", {});
  t.after(() => { component.unmount(); assert.deepEqual(errors, []); assert.equal(cancelled, expectedCancellations); });
  let tree = component.render();
  await settleRequests();
  tree = component.render();
  assert.equal(tree.props.style.width, width);
  assert.equal(tree.props.style.height, height);
  assert.ok(nodes(tree).some(node => node?.type === "img"), "frozen capture and native context have loaded");
  const render = () => { tree = component.render(); return tree; };
  const region = () => nodes(tree).find(node => node?.type === "annotation-canvas")?.props.region ??
    nodes(tree).find(node => node?.type?.name === "RecordOptionsPanel")?.props.anchor ?? null;
  const hoverRect = () => {
    assert.equal(region(), null, "inspect the hover outline before a selection is committed");
    const outlines = nodes(tree).filter(node => node?.type === "div" && node.props.style?.border);
    assert.ok(outlines.length <= 1, "hover displays at most one window outline");
    const style = outlines[0]?.props.style;
    return style ? { x: style.left, y: style.top, width: style.width, height: style.height } : null;
  };
  const pointer = (handler, x, y) => {
    tree.props[handler]({ button: 0, pointerId: 1, clientX: x, clientY: y,
      preventDefault() {}, stopPropagation() {} });
    render();
  };
  return { region, hoverRect, scrollStarts, confirmations,
    toolbar: () => nodes(render()).find(node => node?.type?.name === "Toolbar"),
    key(key, repeat = false) {
      harness.window.dispatchEvent({type: "keydown", key, repeat, target: new OverlayTarget(),
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}});
      render();
    },
    annotationSelection(mark, editing) {
      nodes(render()).find(node => node?.type === "annotation-canvas").props.onSelectionInfo(mark, editing);
      render();
    },
    contextMenu(ancestors = [], defaultPrevented = false) {
      render();
      const event = { target: new OverlayTarget(ancestors), defaultPrevented,
        preventDefault() { this.defaultPrevented = true; } };
      tree.props.onContextMenu(event);
      render();
      return event;
    },
    annotationContent(hasContent, canUndo = hasContent) {
      nodes(render()).find(node => node?.type === "annotation-canvas").props.onHistoryChange(canUndo, false, hasContent);
      render();
    },
    hover: (x, y) => pointer("onPointerMove", x, y),
    down: (x, y) => pointer("onPointerDown", x, y),
    up: (x, y) => pointer("onPointerUp", x, y),
    click(x, y) { pointer("onPointerDown", x, y); pointer("onPointerUp", x, y); },
    drag(from, move, release) {
      pointer("onPointerDown", ...from);
      pointer("onPointerMove", ...move);
      pointer("onPointerUp", ...release);
    },
    mode(label) {
      const button = nodes(tree).find(node => node?.props?.label === label && node.props.onClick);
      assert.ok(button, `mode ${label} exists`);
      button.props.onClick(); render();
    },
  };
}

test("input and HUD context menus preserve the capture selection and annotation phase", async t => {
  for (const ancestors of [["textarea"], ["input"], ["select"], ["[contenteditable]"],
    ["button"], ["a"], [".kiri-hud"], [".kiri-record-options"], [".kiri-choice-menu"]]) {
    const h = await overlay(t);
    h.click(400, 350);
    h.toolbar().props.setTool("text");
    assert.equal(h.toolbar().props.canSetSize, false);
    const before = h.region();
    const event = h.contextMenu(ancestors);
    assert.equal(event.defaultPrevented, false, `${ancestors} retains its native menu`);
    assert.deepEqual(h.region(), before, `${ancestors} must not unmount the annotated region`);
    assert.equal(h.toolbar().props.canSetSize, false, "the annotation session stays active");
  }
});

test("a context menu already handled by a child cannot reset the capture", async t => {
  const h = await overlay(t);
  h.click(400, 350);
  h.toolbar().props.setTool("rectangle");
  const before = h.region();
  const event = h.contextMenu([], true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.region(), before);
  assert.equal(h.toolbar().props.canSetSize, false);
});

test("blank-canvas context menus retain annotated region and history while returning to Select", async t => {
  let cleared = 0;
  const annotated = await overlay(t, {canvasActions: {clearSelection() { cleared++; }}});
  annotated.click(400, 350);
  annotated.toolbar().props.setTool("rectangle");
  annotated.annotationContent(true);
  const region = annotated.region();
  const before = cleared;
  assert.equal(annotated.contextMenu().defaultPrevented, true);
  assert.deepEqual(annotated.region(), region);
  assert.equal(annotated.toolbar().props.tool, "select");
  assert.equal(annotated.toolbar().props.canUndo, true);
  assert.equal(annotated.toolbar().props.canSetSize, false);
  assert.equal(cleared, before + 1);
  annotated.contextMenu();
  assert.deepEqual(annotated.region(), region, "another right click cannot discard the completed marks");
});

test("right click ends only the current text edit or drag before leaving the drawing tool", async t => {
  for (const editing of [true, false]) {
    let commits = 0, cancelled = 0, cleared = 0;
    const h = await overlay(t, {canvasActions: {
      commitTextEditing() { commits++; return true; },
      cancelInteraction() { cancelled++; return true; },
      clearSelection() { cleared++; },
    }});
    h.click(400, 350);
    h.toolbar().props.setTool("text");
    h.annotationSelection(null, editing);
    const region = h.region();
    const before = {commits, cancelled, cleared};
    h.contextMenu();
    assert.deepEqual(h.region(), region);
    assert.equal(h.toolbar().props.tool, "text");
    assert.equal(commits, before.commits + Number(editing));
    assert.equal(cancelled, before.cancelled + Number(!editing));
    assert.equal(cleared, before.cleared);
  }
});

test("right click clears an unannotated selection before cancelling the capture", async t => {
  const selecting = await overlay(t, {expectedCancellations: 1});
  selecting.click(400, 350);
  assert.equal(selecting.contextMenu().defaultPrevented, true);
  assert.equal(selecting.region(), null);
  assert.equal(selecting.toolbar(), undefined);
  selecting.contextMenu();
});

test("right click while moving or resizing a region cannot restore it on a late move or release", async t => {
  for (const start of [[400, 350], [350, 310]]) {
    const h = await overlay(t);
    h.click(400, 350);
    h.down(...start);
    h.hover(start[0] + 25, start[1] + 25);
    h.contextMenu();
    assert.equal(h.region(), null);
    h.hover(start[0] + 60, start[1] + 60);
    h.up(start[0] + 60, start[1] + 60);
    assert.equal(h.region(), null);
    assert.equal(h.toolbar(), undefined);
    h.drag([100, 100], [400, 300], [400, 300]);
    assert.deepEqual(h.region(), {x: 100, y: 100, width: 300, height: 200}, "a fresh drag still works");
  }
});

test("Select and V preserve region resizing until a drawing tool is chosen", async t => {
  const annotated = await overlay(t);
  annotated.click(400, 350);
  annotated.toolbar().props.setTool("select");
  assert.equal(annotated.toolbar().props.canSetSize, true);
  annotated.key("v");
  assert.equal(annotated.toolbar().props.canSetSize, true);
  annotated.toolbar().props.setTool("rectangle");
  annotated.key("v");
  assert.equal(annotated.toolbar().props.canSetSize, false, "Select cannot move the crop after annotation begins");
});

test("only a fresh Enter confirms after text input has closed", async t => {
  const h = await overlay(t, {expectedCancellations: 1});
  h.click(400, 350);
  h.toolbar().props.setTool("text");
  h.key("Enter", true);
  await settleRequests();
  assert.equal(h.confirmations.length, 0, "held Enter cannot finish the capture after closing an input");
  h.key("Enter");
  await settleRequests();
  assert.equal(h.confirmations.length, 1, "a new Enter outside input still confirms the screenshot");
});

for (const [scale, devicePixelRatio] of [[1, 1], [2, 2], [2, 2.5]]) {
  test(`hover and click agree for overlapping app and floating windows at scale ${scale}, DPR ${devicePixelRatio}`, async t => {
    for (const [point, expected] of [[[400, 350], floating], [[250, 200], normal], [[100, 200], background]]) {
      const h = await overlay(t, { scale, devicePixelRatio });
      h.hover(400, 350);
      assert.deepEqual(h.hoverRect(), floating);
      h.hover(1490, 950);
      assert.equal(h.hoverRect(), null, "moving onto blank desktop clears the previous hover outline");
      h.hover(...point);
      assert.deepEqual(h.hoverRect(), expected, "the frontmost containing native rectangle is drawn in logical coordinates");
      h.click(...point);
      assert.deepEqual(h.region(), expected, "a plain click commits the same rectangle without applying pixel scale again");
    }
  });
}

test("overlapping windows follow native front-to-back order rather than area", async t => {
  for (const windowRects of [[normal, floating], [floating, normal]]) {
    const h = await overlay(t, { windowRects });
    h.hover(400, 350);
    assert.deepEqual(h.hoverRect(), windowRects[0]);
    h.click(400, 350);
    assert.deepEqual(h.region(), windowRects[0]);
  }
});

test("dragging across a hovered window commits the manual release endpoint in either direction", async t => {
  for (const [from, move, release, expected] of [
    [[400, 350], [650, 500], [900, 700], { x: 400, y: 350, width: 500, height: 350 }],
    [[800, 350], [500, 450], [250, 600], { x: 250, y: 350, width: 550, height: 250 }],
  ]) {
    const h = await overlay(t);
    h.hover(...from);
    assert.deepEqual(h.hoverRect(), floating);
    h.drag(from, move, release);
    assert.deepEqual(h.region(), expected, "drag overrides window snapping and uses pointer-up, not the previous move frame");
  }
});

test("small and clipped windows use the logical eight-point threshold at Retina scale", async t => {
  for (const [candidate, point, expected] of [
    [{ x: 10, y: 30, width: 7.99, height: 30 }, [12, 40], null],
    [{ x: 60, y: 30, width: 8, height: 8 }, [64, 34], { x: 60, y: 30, width: 8, height: 8 }],
    [{ x: -12, y: 100, width: 20, height: 25 }, [4, 110], { x: 0, y: 100, width: 8, height: 25 }],
    [{ x: 313, y: 100, width: 20, height: 25 }, [316, 110], null],
    [{ x: 280, y: 190, width: 45, height: 50 }, [300, 210], { x: 280, y: 190, width: 40, height: 30 }],
  ]) {
    const h = await overlay(t, { windowRects: [candidate], width: 320, height: 220, scale: 2 });
    h.hover(...point);
    assert.deepEqual(h.hoverRect(), expected);
    h.click(...point);
    assert.deepEqual(h.region(), expected, "only the visible clipped portion is selectable; subminimum slivers stay unselected");
  }
});

test("switching to recording before selection preserves hover and click geometry", async t => {
  const h = await overlay(t);
  h.hover(250, 200);
  assert.deepEqual(h.hoverRect(), normal);
  h.mode("Record");
  assert.equal(h.hoverRect(), null, "switching mode clears the previous transient hover");
  h.hover(400, 350);
  assert.deepEqual(h.hoverRect(), floating);
  h.click(400, 350);
  assert.deepEqual(h.region(), floating, "recording preparation receives exactly the hovered selection");
});


test("scrolling starts from the selected region only when live annotation content is empty", async t => {
  const h = await overlay(t);
  h.click(250, 200);
  h.annotationContent(true);
  assert.equal(h.toolbar().props.scrollCaptureUnavailable, "Remove annotations before starting scrolling capture.");
  h.toolbar().props.onScrollCapture();
  await settleRequests();
  assert.equal(h.scrollStarts.length, 0, "even a queued activation must not discard committed or live marks");
  h.annotationContent(false, true);
  assert.equal(h.toolbar().props.scrollCaptureUnavailable, undefined, "undo history alone does not block a clean document");
  h.toolbar().props.onScrollCapture();
  h.toolbar().props.onScrollCapture();
  assert.deepEqual(h.scrollStarts, [{ captureId: "capture-1", selection: normal }]);
  await settleRequests();
});

test("an unsupported desktop keeps scrolling unavailable without starting a capture", async t => {
  const h = await overlay(t, { scrollingCapture: false });
  h.click(250, 200);
  assert.equal(h.toolbar().props.scrollCaptureUnavailable, "Scrolling capture is unavailable on this desktop.");
  h.toolbar().props.onScrollCapture();
  await settleRequests();
  assert.equal(h.scrollStarts.length, 0);
});
