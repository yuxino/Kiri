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
  devicePixelRatio = scale, width = 1512, height = 982, scrolling = false, scrollFailures = [] } = {}) {
  const errors = [];
  const scrollSelections = [];
  let cancelled = 0;
  const context = { displayWidth: width, displayHeight: height, scale,
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
        platformCapabilities: async () => ({ recording: true, microphone: true, systemAudio: true, clickHighlights: true }),
        scrollCaptureSupported: async () => scrolling,
        startScrollCapture: async selection => {
          scrollSelections.push(selection);
          const failure = scrollFailures[scrollSelections.length - 1];
          if (failure !== undefined) throw failure;
        },
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
  t.after(() => {
    component.unmount();
    assert.deepEqual(errors, scrollFailures.map(error => ({ message: `start_scroll_capture rejected: ${String(error)}` })));
    assert.equal(cancelled, 0);
  });
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
  return { region, hoverRect,
    scrollSelections,
    text: () => nodes(render()),
    toolbar: () => nodes(tree).find(node => node?.type?.name === "Toolbar")?.props,
    history(hasMarks) {
      nodes(tree).find(node => node?.type === "annotation-canvas").props.onHistoryChange(hasMarks, false, hasMarks);
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

test("scrolling screenshot entry is capability gated and refuses to discard annotations", async t => {
  const supported = await overlay(t, { scrolling: true });
  supported.click(250, 200);
  assert.equal(typeof supported.toolbar().onScrollCapture, "function");
  supported.history(true);
  assert.equal(supported.toolbar().scrollCaptureDisabled, true);
  supported.toolbar().onScrollCapture();
  await settleRequests();
  assert.deepEqual(supported.scrollSelections, [], "calling the disabled action also preserves annotation data");
  supported.history(false);
  assert.equal(supported.toolbar().scrollCaptureDisabled, false);
  supported.toolbar().onScrollCapture();
  supported.toolbar().onScrollCapture();
  await settleRequests();
  assert.deepEqual(supported.scrollSelections, [normal], "the session starts once with unchanged logical selection coordinates");

  const unsupported = await overlay(t);
  unsupported.click(250, 200);
  assert.equal(unsupported.toolbar().onScrollCapture, undefined);
});

test("scroll startup errors preserve the specific remedy and leave the selection ready for retry", async t => {
  const known = [
    "Escape is unavailable. Close the other capture tool and try again.",
    "Leave space beside the selection for scrolling capture controls.",
    "Select a larger scrolling content area.",
    "Scrolling capture is not available on this desktop.",
  ];
  const fallback = "Could not start scrolling capture. Try a smaller selection with room for the controls.";
  const scrollFailures = [...known.map(message => new Error(message)), new Error("private native detail")];
  const h = await overlay(t, { scrolling: true, scrollFailures });
  h.click(250, 200);
  for (const [index, expected] of [...known, fallback].entries()) {
    h.toolbar().onScrollCapture();
    await settleRequests();
    assert.ok(h.text().includes(expected));
    assert.equal(h.text().includes("private native detail"), false);
    assert.equal(h.toolbar().disabled, false, "a rejected startup releases the completion lock");
    assert.deepEqual(h.region(), normal, "the original selection remains available");
    assert.equal(h.scrollSelections.length, index + 1);
  }
  h.toolbar().onScrollCapture();
  await settleRequests();
  h.text();
  assert.equal(h.scrollSelections.length, scrollFailures.length + 1, "retry can start the native session after the error");
  assert.equal(h.toolbar().disabled, true);
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
