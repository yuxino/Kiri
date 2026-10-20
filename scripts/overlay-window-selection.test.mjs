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

// Mount the entire real OverlayWindow and dispatch its rendered handlers.
// Only native/data-loading boundaries and unrelated child surfaces are stubbed;
// the selection state, geometry, phase changes and rendered outlines stay real.
async function overlay(t, { windowRects = [floating, normal, background], scale = 2,
  devicePixelRatio = scale, width = 1512, height = 982, scrollingCapture = true } = {}) {
  const errors = [];
  const scrollStarts = [];
  let cancelled = 0;
  const context = { captureId: "capture-1", displayWidth: width, displayHeight: height, scale,
    pixelWidth: Math.round(width * scale), pixelHeight: Math.round(height * scale),
    windowRects, sourceApplication: "selection-test" };
  const harness = createLibraryHarness({}, source, {
    search: "?window=overlay&captureToken=0123456789abcdef0123456789abcdef",
    globals: {
      fetch: async () => ({ ok: true, blob: async () => new Blob(["test frozen capture"]) }),
      Image: class { src = ""; },
      ResizeObserver: class { observe() {} disconnect() {} },
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
  t.after(() => { component.unmount(); assert.deepEqual(errors, []); assert.equal(cancelled, 0); });
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
  return { region, hoverRect, scrollStarts,
    toolbar: () => nodes(render()).find(node => node?.type?.name === "Toolbar"),
    annotationContent(hasContent, canUndo = hasContent) {
      nodes(render()).find(node => node?.type === "annotation-canvas").props.onHistoryChange(canUndo, false, hasContent);
      render();
    },
    hover: (x, y) => pointer("onPointerMove", x, y),
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
