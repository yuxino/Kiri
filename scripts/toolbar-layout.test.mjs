import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capturePanelLayout, captureToolOptionsLayout, captureToolbarPosition, recordingPanelLayout } from "../src/windows/toolbar-layout.js";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

const overlaps = (position, size, rect) => position.left < rect.x + rect.width &&
  position.left + size.width > rect.x && position.top < rect.y + rect.height &&
  position.top + size.height > rect.y;

test("800×600 bottom-right region leaves a measured wrapped toolbar above the selection", () => {
  const selection = { x: 650, y: 420, width: 140, height: 160 };
  const size = { width: 784, height: 81 };
  const position = captureToolbarPosition(selection, { x: 0, y: 0, width: 800, height: 600 }, size);
  assert.deepEqual(position, { left: 8, top: 329 });
  assert.equal(position.top + size.height, selection.y - 10);
});

test("wide displays retain the centered row below the selection", () => {
  assert.deepEqual(captureToolbarPosition(
    { x: 500, y: 200, width: 500, height: 150 },
    { x: 0, y: 0, width: 1512, height: 982 },
    { width: 810, height: 48 },
  ), { left: 345, top: 360 });
});

test("all corners remain inside logical viewport bounds after height changes", () => {
  for (const [width, height] of [[640, 480], [800, 600], [1512, 982]]) {
    for (const toolbarHeight of [48, 81, 116]) {
      for (const x of [0, width - 140]) for (const y of [0, height - 160]) {
        const size = { width: Math.min(810, width - 16), height: toolbarHeight };
        const p = captureToolbarPosition({ x, y, width: 140, height: 160 }, { x: 0, y: 0, width, height }, size);
        assert.ok(p.left >= 8 && p.left + size.width <= width - 8);
        assert.ok(p.top >= 8 && p.top + size.height <= height - 8);
      }
    }
  }
});

test("nonzero bounds and constrained height do not force the toolbar off screen", () => {
  const bounds = { x: -800, y: -200, width: 800, height: 180 };
  const size = { width: 784, height: 116 };
  assert.deepEqual(captureToolbarPosition(
    { x: -150, y: -100, width: 140, height: 70 }, bounds, size,
  ), { left: -792, top: -144 });
});

test("a tall settings stack near the top stays inside the selection when neither outside edge fits", () => {
  const selection = { x: 80, y: 150, width: 1040, height: 620 };
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const mode = { x: 445, y: 44, width: 310, height: 44 };
  for (const height of [94, 130, 230]) {
    const size = { width: 550, height };
    const position = captureToolbarPosition(selection, bounds, size, false, mode);
    assert.ok(position.top >= selection.y + 10);
    assert.ok(position.top + size.height <= selection.y + selection.height - 10);
    assert.ok(!overlaps(position, size, mode));
  }
});

test("a mode selector only reserves its actual area, leaving clear room above a selection", () => {
  const selection = { x: 680, y: 155, width: 400, height: 620 };
  const size = { width: 420, height: 96 };
  const mode = { x: 280, y: 44, width: 310, height: 44 };
  const position = captureToolbarPosition(selection, { x: 0, y: 0, width: 1200, height: 800 }, size, false, mode);
  assert.deepEqual(position, { left: 670, top: 49 });
  assert.equal(position.top + size.height + 10, selection.y);
  assert.ok(!overlaps(position, size, mode));
});

test("a wrapped mode selector reserves both rows without trapping a compact toolbar", () => {
  const bounds = { x: 0, y: 0, width: 320, height: 480 };
  const selection = { x: 20, y: 130, width: 280, height: 330 };
  const mode = { x: 8, y: 44, width: 304, height: 80 };
  for (const height of [81, 160, 210]) {
    const size = { width: 304, height };
    const position = captureToolbarPosition(selection, bounds, size, false, mode);
    assert.ok(position.left >= 8 && position.left + size.width <= 312);
    assert.ok(position.top >= 8 && position.top + size.height <= 472);
    assert.ok(!overlaps(position, size, mode), "the selector's second row must also stay clear");
  }
});

test("narrow full-height selections use free side space before covering the canvas", () => {
  const selection = { x: 80, y: 0, width: 130, height: 800 };
  const size = { width: 550, height: 140 };
  const mode = { x: 445, y: 44, width: 310, height: 44 };
  const position = captureToolbarPosition(selection, { x: 0, y: 0, width: 1200, height: 800 }, size, false, mode);
  assert.deepEqual(position, { left: 220, top: 330 });
  assert.ok(!overlaps(position, size, selection));
  assert.ok(!overlaps(position, size, mode));
});

test("full-display and corner selections keep two and three rows clear of a moved mode selector", () => {
  for (const [width, height] of [[480, 640], [800, 600], [1512, 982]]) {
    const bounds = { x: 0, y: 0, width, height };
    for (const mode of [
      { x: width / 2 - 150, y: 44, width: 300, height: 44 },
      { x: 8, y: height - 70, width: 300, height: 44 },
    ]) for (const toolbarHeight of [94, 130, 230]) {
      const size = { width: Math.min(550, width - 16), height: toolbarHeight };
      for (const selection of [bounds,
        { x: 0, y: 0, width: 100, height: 160 },
        { x: width - 100, y: 0, width: 100, height: 160 },
        { x: 0, y: height - 160, width: 100, height: 160 },
        { x: width - 100, y: height - 160, width: 100, height: 160 },
      ]) {
        const position = captureToolbarPosition(selection, bounds, size, false, mode);
        assert.ok(position.left >= 8 && position.left + size.width <= width - 8);
        assert.ok(position.top >= 8 && position.top + size.height <= height - 8);
        assert.ok(!overlaps(position, size, mode));
      }
    }
  }
});

test("choosing N and changing property heights keeps the main toolbar anchored below its selection", () => {
  const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  // Compile the real tool definitions and both toolbar rows, including all
  // three direct text tools; no empty TOOLS shortcut hides wrap groups.
  const toolbar = source.slice(source.indexOf("const TOOLS:"));
  const css = readFileSync(new URL("../src/styles/design-system.css", import.meta.url), "utf8");
  const optionsCss = css.match(/\.kiri-capture-tool-options\s*\{([^}]+)\}/)?.[1];
  assert.ok(optionsCss, "the property HUD has an explicit input and width boundary");
  const optionsStyle = Object.fromEntries(optionsCss.split(";").filter(value => value.trim()).map(value => {
    const index = value.indexOf(":"); return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
  }));
  let height = 48, panelStyle;
  const measured = { get scrollHeight() { return height; },
    get offsetHeight() { return Math.min(height, panelStyle.maxHeight); },
    get clientHeight() { return Math.min(height, panelStyle.maxHeight); } };
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    import {AnnotationToolbarButton} from "../components/AnnotationToolbarButton";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}, captureToolOptionsLayout=${captureToolOptionsLayout.toString()}; ${toolbar}`, {
    attachRef(node) {
      if (node.props.className?.includes("kiri-annotation-tool-row")) node.props.ref.current = {offsetWidth: 550, offsetHeight: 48};
      if (node.props.className === "kiri-hud kiri-capture-tool-options") {
        panelStyle = node.props.style; node.props.ref.current = measured;
      }
    },
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
  });
  const props = { selection: { x: 80, y: 150, width: 1040, height: 540 },
    bounds: { x: 0, y: 0, width: 1200, height: 800 }, modeSelectorBounds: { x: 445, y: 44, width: 310, height: 44 },
    tool: "select", appearance: {}, canSetSize: true, disabled: false };
  const component = harness.mount("Toolbar", props);
  let tree = component.render();
  let root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.pointerEvents, "none");
  assert.ok(root.props.style.zIndex > 5, "selection keylines must not paint over controls");
  const anchor = {left: root.props.style.left, top: root.props.style.top};
  assert.equal(anchor.top, props.selection.y + props.selection.height + 10);
  const checkProperties = settings => {
    const position = {left: anchor.left + settings.props.style.left, top: anchor.top + settings.props.style.top};
    const size = {width: settings.props.style.width, height: Math.min(height, settings.props.style.maxHeight)};
    assert.ok(position.left >= 8 && position.left + size.width <= 1192);
    assert.ok(position.top >= 8 && position.top + size.height <= 792);
    assert.ok(!overlaps(position, size, {x: anchor.left, y: anchor.top, width: 550, height: 48}), "properties cannot cover main actions");
    assert.ok(!overlaps(position, size, props.modeSelectorBounds), "properties cannot cover mode choices");
  };
  height = 230;
  tree = component.render({ ...props, tool: "callout", canSetSize: false, styleControls: "callout-controls" });
  root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.deepEqual({left: root.props.style.left, top: root.props.style.top}, anchor);
  const hud = nodes(tree).find(node => node?.props?.className?.includes("kiri-annotation-tool-row"));
  assert.equal(hud.props.style.pointerEvents, "auto");
  const settings = nodes(tree).find(node => node?.props?.className === "kiri-hud kiri-capture-tool-options");
  assert.ok(nodes(settings).includes("callout-controls"));
  assert.equal(settings.props.className, "kiri-hud kiri-capture-tool-options");
  assert.equal(optionsStyle["pointer-events"], "auto", "only the visible property HUD receives input");
  assert.equal(optionsStyle.width, "100%", "the property HUD remains within the measured toolbar width");
  assert.ok(settings.props.style.maxHeight > 0);
  checkProperties(settings);
  assert.ok(settings.props.style.top < 0, "only the properties flip above when the lower screen edge leaves no room");
  height = 130;
  tree = component.render({ ...props, canSetSize: false, selectedMark: {kind: "text", id: 2, labelDirection: "left"}, styleControls: "label-controls" });
  root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.pointerEvents, "none", "a selected label must keep blank toolbar space pass-through");
  const labelSettings = nodes(tree).find(node => node?.props?.className === "kiri-hud kiri-capture-tool-options");
  assert.ok(nodes(labelSettings).includes("label-controls"));
  assert.ok(labelSettings, "selecting an existing label opens its settings");
  assert.equal(labelSettings.props.className, "kiri-hud kiri-capture-tool-options");
  assert.equal(optionsStyle["pointer-events"], "auto", "label color and font controls remain interactive");
  assert.equal(root.props.style.maxWidth, props.bounds.width - 16);
  assert.deepEqual({left: root.props.style.left, top: root.props.style.top}, anchor);
  checkProperties(labelSettings);
  assert.ok(!nodes(tree).some(node => node?.props?.children?.includes("callout-controls")), "changing to a label must remove stale callout settings");
  tree = component.render({...props, selectedMark: null, styleControls: "empty-select-options"});
  assert.ok(!nodes(tree).some(node => node?.props?.children?.includes("empty-select-options")), "clearing selection closes inactive Select settings");
  root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.pointerEvents, "none");
  assert.deepEqual({left: root.props.style.left, top: root.props.style.top}, anchor);
  root = nodes(component.render({...props, selection: {...props.selection, y: 20, height: 200}}))
    .find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.top, 230, "a real selection move/resize still repositions its toolbar");
  component.unmount();
});

test("properties avoid the fixed toolbar and dragged mode selector at every screen edge", () => {
  for (const [x, y, width, height] of [[0, 0, 320, 480], [0, 0, 800, 600], [-1512, -200, 1512, 982]]) {
    const bounds = {x, y, width, height};
    const toolbarSize = {width: Math.min(850, width - 16), height: width === 320 ? 160 : 48};
    for (const mode of [
      {x: x + 8, y: y + 44, width: Math.min(304, width - 16), height: width === 320 ? 80 : 44},
      {x: x + width - Math.min(304, width - 16) - 8, y: y + height - 80, width: Math.min(304, width - 16), height: 44},
    ]) for (const selection of [bounds,
      {x: x + 20, y: y + 20, width: 140, height: 120},
      {x: x + width - 160, y: y + height - 140, width: 140, height: 120},
    ]) {
      const anchor = captureToolbarPosition(selection, bounds, toolbarSize, false, mode);
      const toolbar = {x: anchor.left, y: anchor.top, ...toolbarSize};
      for (const naturalHeight of [64, 130, 230, 900]) {
        const p = captureToolOptionsLayout(toolbar, bounds, {width: Math.min(620, toolbarSize.width), height: naturalHeight}, mode);
        const size = {width: p.width, height: Math.min(naturalHeight, p.maxHeight)};
        assert.ok(p.maxHeight > 0, JSON.stringify({bounds, toolbar, mode, p}));
        assert.ok(p.left >= x + 8 && p.left + size.width <= x + width - 8);
        assert.ok(p.top >= y + 8 && p.top + size.height <= y + height - 8);
        assert.ok(!overlaps(p, size, toolbar), "properties must keep main buttons reachable");
        assert.ok(!overlaps(p, size, mode), "properties must keep mode buttons reachable");
      }
    }
  }
});

test("legacy outside-panel layout keeps its actions clear of the mode selector", () => {
  const selection = { x: 300, y: 10, width: 680, height: 380 };
  const bounds = { x: 0, y: 0, width: 1280, height: 800 };
  const mode = { x: 492, y: 44, width: 296, height: 44 };
  const natural = { width: 360, height: 460 };
  const layout = capturePanelLayout(selection, bounds, natural, mode);
  assert.equal(layout.top, 400);
  assert.equal(layout.maxHeight, 392);
  assert.ok(!overlaps(layout, { width: layout.width, height: layout.maxHeight }, mode));
  assert.ok(layout.top + layout.maxHeight <= 792, "scrolling content must leave Start/Cancel on screen");
  const mp4 = { left: layout.left + 18, top: layout.top + 56 };
  assert.ok(!overlaps(mp4, { width: 158, height: 32 }, mode), "MP4 must not click the Screenshot selector");
});

test("scrollable OCR panels stay clear of wrapped and dragged modes at every edge", () => {
  for (const [width, height] of [[320, 480], [480, 640], [1280, 800]]) {
    const bounds = { x: 0, y: 0, width, height };
    const modeWidth = Math.min(304, width - 16), modeHeight = width === 320 ? 80 : 44;
    for (const mode of [
      { x: (width - modeWidth) / 2, y: 44, width: modeWidth, height: modeHeight },
      { x: 8, y: height / 2 - modeHeight / 2, width: modeWidth, height: modeHeight },
      { x: width - modeWidth - 8, y: height - modeHeight - 8, width: modeWidth, height: modeHeight },
    ]) for (const selection of [bounds,
      { x: 0, y: 0, width: 100, height: 120 },
      { x: width - 100, y: height - 120, width: 100, height: 120 },
    ]) for (const natural of [{ width: 360, height: 460 }, { width: 368, height: 204 }, { width: 440, height: 740 }]) {
      const p = capturePanelLayout(selection, bounds, natural, mode);
      const size = { width: p.width, height: Math.min(natural.height, p.maxHeight) };
      assert.ok(p.left >= 8 && p.left + size.width <= width - 8);
      assert.ok(p.top >= 8 && p.top + size.height <= height - 8);
      assert.ok(!overlaps(p, size, mode), JSON.stringify({ bounds, mode, selection, natural, p }));
      assert.ok(p.maxHeight >= 160, "constrained content must still leave a usable reading area and actions");
    }
  }
});

function recordingSetup() {
  const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const panel = source.slice(source.indexOf("export function RecordOptionsPanel("), source.indexOf("interface ToolbarProps"));
  const clamp = source.slice(source.indexOf("function clampFloatingControl("), source.indexOf("// --- window hover candidate"));
  let naturalHeight = 184, style, changes = [], starts = 0, cancels = 0;
  const measured = {
    getBoundingClientRect() { return { height: Math.min(naturalHeight, style.maxHeight) }; },
    get clientHeight() { return Math.min(naturalHeight, style.maxHeight); },
    get scrollHeight() { return style.maxHeight < 168 ? naturalHeight : this.clientHeight; },
  };
  const scroll = { get scrollHeight() { return naturalHeight - 64; },
    get clientHeight() { return style.maxHeight < 168 ? naturalHeight - 64 : Math.max(0, Math.min(naturalHeight, style.maxHeight) - 64); }, firstElementChild: {} };
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const Mic="mic", Volume2="volume", MousePointer2="pointer", MousePointerClick="clicks", RecordingMicrophoneSelect="mic-select";
    const FLOATING_CONTROL_MARGIN=8,minX=r=>r.x,minY=r=>r.y,maxX=r=>r.x+r.width,maxY=r=>r.y+r.height;
    ${clamp} const recordingPanelLayout=${recordingPanelLayout.toString()}; ${panel}; export {RecordInput};`, {
    attachRef(node) {
      if (node.props.ref && node.props.className === "kiri-record-options") { style = node.props.style; node.props.ref.current = measured; }
      if (node.props.ref && node.props.className === "kiri-record-options__scroll") node.props.ref.current = scroll;
    },
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
  });
  const props = { anchor: { x: 100, y: 140, width: 600, height: 350 }, bounds: { x: 0, y: 0, width: 1280, height: 800 },
    modeSelectorBounds: { x: 492, y: 44, width: 296, height: 44 }, options: { outputFormat: "mp4", usesCountdown: true,
      capturesSystemAudio: true, capturesMicrophone: false, showsCursor: true, highlightsClicks: true }, sizeControlsOpen: false,
    systemAudioSupported: true, micSupported: true, clickHighlightsSupported: true, trayRecordingControls: false,
    onChange: value => changes.push(value), onStart: () => starts++, onCancel: () => cancels++, onToggleSize() {} };
  const component = harness.mount("RecordOptionsPanel", props);
  return { component, props, harness, changes, counts: () => ({ starts, cancels }),
    height(value) { naturalHeight = value; } };
}

const recordingRoot = tree => nodes(tree).find(node => node?.props?.className === "kiri-record-options");
const setupPointer = (x, y, button = false, header = true) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
  target: { closest: selector => selector === ".kiri-record-options__header" ? header : button }, currentTarget: { setPointerCapture() {} }, preventDefault() {}, stopPropagation() {} });

test("recording setup centers inside a roomy selection and below a small selection", () => {
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };
  const size = { width: 336, height: 184 };
  assert.deepEqual(recordingPanelLayout({ x: 100, y: 140, width: 600, height: 350 }, bounds, size),
    { left: 232, top: 223, width: 336, maxHeight: 784 });
  const small = recordingPanelLayout({ x: 100, y: 140, width: 280, height: 94 }, bounds, size);
  assert.equal(small.left, 72); assert.equal(small.top, 246);
  const bottom = recordingPanelLayout({ x: 850, y: 690, width: 280, height: 94 }, bounds, size);
  assert.equal(bottom.top, 494); assert.ok(bottom.left + bottom.width <= 1192);
  const side = recordingPanelLayout({ x: 20, y: 0, width: 90, height: 800 }, bounds, size);
  assert.equal(side.left, 122); assert.equal(side.top, 308);
});

test("recording setup keeps resized dimensions controls clear above and beside small selections", () => {
  const p = recordingPanelLayout({ x: 400, y: 450, width: 180, height: 130 },
    { x: 0, y: 0, width: 800, height: 600 }, { width: 336, height: 300 }, null, true);
  assert.equal(p.top, 100);
  assert.ok(p.top + 300 <= 412, "the width field at y=412 remains reachable");
  const side = recordingPanelLayout({ x: 20, y: 0, width: 90, height: 800 },
    { x: 0, y: 0, width: 1200, height: 800 }, { width: 336, height: 184 }, null, true);
  assert.equal(side.left, 190, "right side placement clears the height field");
});

test("recording setup edges stay on screen and clear wrapped/moved mode selectors", () => {
  for (const [width, height] of [[320, 480], [800, 600], [1512, 982]]) {
    const bounds = { x: 0, y: 0, width, height };
    const mode = { x: 8, y: 44, width: Math.min(304, width - 16), height: width === 320 ? 80 : 44 };
    for (const selection of [bounds, { x: 0, y: 0, width: 100, height: 90 },
      { x: width - 100, y: height - 90, width: 100, height: 90 }]) {
      for (const panelHeight of [184, 400, 800]) {
        const p = recordingPanelLayout(selection, bounds, { width: 336, height: panelHeight }, mode);
        const size = { width: p.width, height: Math.min(panelHeight, p.maxHeight) };
        assert.ok(p.left >= 8 && p.left + size.width <= width - 8);
        assert.ok(p.top >= 8 && p.top + size.height <= height - 8);
        assert.ok(!overlaps(p, size, mode), JSON.stringify({ p, size, mode, selection }));
      }
    }
  }
});

test("recording setup stays still during selection gestures and always follows its selection", () => {
  const h = recordingSetup();
  let root = recordingRoot(h.component.render());
  const start = root.props.style;
  root = recordingRoot(h.component.render({ ...h.props, selectionAdjusting: true,
    anchor: { x: 600, y: 450, width: 180, height: 100 } }));
  assert.equal(root.props.style.left, start.left); assert.equal(root.props.style.top, start.top);
  assert.equal(root.props["data-adjusting"], true);
  root = recordingRoot(h.component.render({ ...h.props, anchor: { x: 600, y: 450, width: 180, height: 100 } }));
  assert.equal(root.props.style.top, 562);
  const automaticPosition = root.props.style;
  root.props.onPointerDown(setupPointer(700, 570));
  root.props.onPointerMove(setupPointer(4000, 4000));
  root.props.onPointerUp(setupPointer(4000, 4000));
  root = recordingRoot(h.component.render());
  assert.deepEqual(root.props.style, automaticPosition, "panel does not support manual dragging");
  h.component.unmount();
  const fresh = recordingSetup();
  root = recordingRoot(fresh.component.render());
  assert.equal(root.props.style.left, 232); assert.equal(root.props.style.top, 223);
  fresh.component.unmount();
});

test("recording setup keeps four direct controls without a second settings panel", () => {
  const h = recordingSetup();
  let tree = h.component.render();
  const header = nodes(tree).find(node => node?.props?.className === "kiri-record-options__header");
  const start = nodes(header).find(node => node?.props?.className === "kiri-record-options__start");
  start.props.onClick(); assert.equal(h.counts().starts, 1);
  assert.deepEqual(nodes(tree).filter(node => node?.props?.onToggle).map(node => node.props.label),
    ["System audio", "Microphone", "Pointer", "Click highlight"]);
  assert.ok(!nodes(tree).some(node => node?.props?.["aria-label"] === "More Actions"));
  assert.ok(!nodes(tree).some(node => node?.props?.label === "3-second countdown"));
  const microphone = nodes(tree).find(node => node?.props?.label === "Microphone");
  assert.ok(microphone.props.accessory, "microphone selection is beside its control");
  h.height(240);
  tree = h.component.render({ ...h.props, bounds: { x: 0, y: 0, width: 320, height: 480 },
    anchor: { x: 0, y: 0, width: 320, height: 480 }, modeSelectorBounds: { x: 8, y: 44, width: 304, height: 80 } });
  const root = recordingRoot(tree);
  assert.equal(root.props.style.width, 304);
  assert.ok(root.props.style.top >= 136);
  assert.ok(root.props.style.top + Math.min(240, root.props.style.maxHeight) <= 472);
  h.component.unmount();
});

test("recording switches expose their real state and keep the device action independent", () => {
  const h = recordingSetup();
  let toggles = 0;
  const accessory = {type: "device-entry", props: {}};
  const props = {label: "Microphone", checked: false, disabled: false, icon: "microphone-icon", accessory,
    onToggle() {toggles++;}};
  const component = h.harness.mount("RecordInput", props);
  let tree = component.render();
  let control = nodes(tree).find(node => node?.props?.role === "switch");
  assert.equal(control.props["aria-checked"], false);
  assert.ok(nodes(control).includes("Microphone"), "the switch keeps its visible name");
  assert.equal(nodes(tree).filter(node => node?.type === "device-entry").length, 1);
  assert.ok(!nodes(control).includes(accessory), "device selection is outside the toggle hit area");
  const indicator = nodes(control).find(node => node?.props?.className === "kiri-record-options__input-toggle");
  assert.equal(indicator.props["aria-hidden"], "true", "the decoration does not duplicate the switch name");
  control.props.onClick(); assert.equal(toggles, 1);
  tree = component.render({...props, checked: true, disabled: true});
  control = nodes(tree).find(node => node?.props?.role === "switch");
  assert.equal(control.props["aria-checked"], true); assert.equal(control.props.disabled, true);
  component.unmount(); h.component.unmount();
});

test("very short available space scrolls the whole setup without losing its natural height", () => {
  const h = recordingSetup();
  h.height(300);
  const root = recordingRoot(h.component.render({ ...h.props,
    bounds: { x: 0, y: 0, width: 480, height: 320 },
    anchor: { x: 0, y: 0, width: 480, height: 320 },
    modeSelectorBounds: { x: 88, y: 138, width: 304, height: 44 },
  }));
  assert.equal(root.props.style.maxHeight, 118);
  assert.equal(root.props["data-constrained"], true);
  const expanded = recordingRoot(h.component.render(h.props));
  assert.equal(expanded.props["data-constrained"], undefined);
  assert.equal(expanded.props.style.top, 165, "restored space centers the full 300px panel, not the clipped 118px viewport");
  h.component.unmount();
});

test("format and device controls preserve silent GIF, platform limits, and pointer-highlight dependency", () => {
  const h = recordingSetup();
  let tree = h.component.render();
  const pointer = nodes(tree).find(node => node?.props?.label === "Pointer");
  pointer.props.onToggle();
  assert.equal(h.changes[0].showsCursor, false); assert.equal(h.changes[0].highlightsClicks, false);
  const gif = nodes(tree).find(node => node?.props?.className === "kiri-record-options__format" && node.props.children.includes("GIF"));
  gif.props.onClick(); assert.equal(h.changes[1].outputFormat, "gif");
  tree = h.component.render({ ...h.props, options: { ...h.props.options, outputFormat: "gif" } });
  assert.equal(nodes(tree).find(node => node?.props?.label === "System audio").props.disabled, true);
  assert.equal(nodes(tree).find(node => node?.props?.label === "Microphone").props.disabled, true);
  assert.equal(nodes(tree).find(node => node?.props?.label === "System audio").props.checked, false);
  const mp4 = nodes(tree).find(node => node?.props?.className === "kiri-record-options__format" && node.props.children.includes("MP4"));
  mp4.props.onClick();
  assert.equal(h.changes.at(-1).capturesSystemAudio, true, "returning from GIF preserves the MP4 audio preference");
  tree = h.component.render({ ...h.props, systemAudioSupported: false, micSupported: false });
  for (const label of ["System audio", "Microphone"]) {
    const input = nodes(tree).find(node => node?.props?.label === label);
    assert.equal(input.props.disabled, true); assert.equal(input.props.title, "Unavailable on this platform");
  }
  tree = h.component.render({ ...h.props, clickHighlightsSupported: false });
  assert.equal(nodes(tree).find(node => node?.props?.label === "Click highlight").props.disabled, true);
  tree = h.component.render({ ...h.props, options: { ...h.props.options, showsCursor: false } });
  const highlight = nodes(tree).find(node => node?.props?.label === "Click highlight");
  assert.equal(highlight.props.disabled, true); assert.equal(highlight.props.checked, false);
  const root = recordingRoot(tree), previous = root.props.style;
  root.props.onPointerDown(setupPointer(200, 200, true));
  root.props.onPointerMove(setupPointer(600, 600));
  assert.deepEqual(recordingRoot(h.component.render()).props.style, previous, "control clicks cannot drag the panel");
  root.props.onPointerDown(setupPointer(200, 200, false, false));
  root.props.onPointerMove(setupPointer(600, 600));
  assert.deepEqual(recordingRoot(h.component.render()).props.style, previous, "scrollable settings remain available to touch scrolling");
  h.component.unmount();
});

test("remote OCR measures wrapped content without hiding the mode selector or sending on layout changes", () => {
  const source = readFileSync(new URL("../src/ocr/RemoteOcrConsent.tsx", import.meta.url), "utf8");
  const panel = source.slice(source.indexOf("export function RemoteOcrConsent("));
  let naturalHeight = 600, style, sends = 0, local = 0;
  const measured = { children: [], getBoundingClientRect() { return { height: Math.min(naturalHeight, style.maxHeight) }; },
    get scrollHeight() { return naturalHeight - 2; }, get clientHeight() { return Math.min(naturalHeight, style.maxHeight) - 2; } };
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t,fmt} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const useDialogFocusTrap=()=>useRef(null), ocrProviderLabel=value=>value,
      captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}; ${panel}`, {
    attachRef(node) {
      if (node.props.ref && node.props.className === "kiri-hud kiri-remote-consent") { style=node.props.style; node.props.ref.current=measured; }
    },
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
  });
  const props = { anchor: { x: 0, y: 0, width: 320, height: 480 }, bounds: { x: 0, y: 0, width: 320, height: 480 },
    modeSelectorBounds: { x: 8, y: 44, width: 304, height: 80 },
    prepared: { profile: { name: "A long profile", provider: "openai", origin: "https://fixture.invalid", model: "OCR" },
      imageWidth: 320, imageHeight: 480, byteLength: 2048 }, failed: false,
    onSend: () => sends++, onUseLocal: () => local++, onCancel() {} };
  const component = harness.mount("RemoteOcrConsent", props);
  let tree = component.render();
  let root = nodes(tree).find(node => node?.props?.role === "dialog");
  assert.equal(root.props.style.width, 304);
  assert.ok(root.props.style.top >= 134 && root.props.style.top + root.props.style.maxHeight <= 472);
  naturalHeight = 740;
  const mode = { x: 8, y: 200, width: 304, height: 80 };
  tree = component.render({ ...props, failed: true, modeSelectorBounds: mode });
  root = nodes(tree).find(node => node?.props?.role === "dialog");
  assert.ok(!overlaps(root.props.style, { width: 304, height: root.props.style.maxHeight }, mode));
  assert.equal(sends, 0);
  assert.equal(local, 0);
  const send = nodes(tree).find(node => node?.props?.className?.includes("kiri-remote-consent__send"));
  send.props.onClick();
  assert.equal(sends, 1, "remote OCR remains an explicit button action");
  component.unmount();
});


test("full-display properties avoid bottom annotations including a separate empty callout editor", () => {
  const bounds = {x: 0, y: 0, width: 1200, height: 800};
  const toolbar = {x: 200, y: 740, width: 800, height: 48};
  const size = {width: 620, height: 160};
  const badge = {x: 600, y: 690, width: 36, height: 36};
  const editor = {x: 350, y: 590, width: 400, height: 90};
  const old = captureToolOptionsLayout(toolbar, bounds, size);
  assert.ok(overlaps(old, size, editor), "this reproduces the previously covered bottom editor");
  const actual = captureToolOptionsLayout(toolbar, bounds, size, null, [badge, editor]);
  assert.ok(!overlaps(actual, size, badge));
  assert.ok(!overlaps(actual, size, editor));
  assert.ok(!overlaps(actual, size, toolbar));
  assert.ok(actual.top >= 8 && actual.top + size.height <= 792);
});

test("manual property position wins over annotation avoidance and grows by scrolling in place", () => {
  const bounds = {x: -800, y: -200, width: 1200, height: 800};
  const toolbar = {x: -600, y: 540, width: 800, height: 48};
  const preferred = {x: -700, y: 250};
  const annotation = {x: -650, y: 300, width: 200, height: 80};
  for (const height of [100, 160, 500]) {
    const panel = captureToolOptionsLayout(toolbar, bounds, {width: 620, height}, null, [annotation], preferred);
    assert.equal(panel.left, preferred.x);
    assert.equal(panel.top, preferred.y);
    assert.equal(panel.maxHeight, toolbar.y - 6 - preferred.y);
  }
});

test("dragged properties clamp at screen edges and keep toolbar and mode selector accessible", () => {
  const bounds = {x: 0, y: 0, width: 800, height: 600};
  const toolbar = {x: 8, y: 542, width: 784, height: 48};
  const mode = {x: 260, y: 44, width: 280, height: 44};
  for (const preferred of [{x: -1000, y: -1000}, {x: 1000, y: -1000}, {x: 1000, y: 1000}, {x: -1000, y: 1000}]) {
    const panel = captureToolOptionsLayout(toolbar, bounds, {width: 620, height: 210}, mode, [], preferred);
    const size = {width: panel.width, height: Math.min(210, panel.maxHeight)};
    assert.ok(panel.left >= 8 && panel.left + size.width <= 792);
    assert.ok(panel.top >= 8 && panel.top + size.height <= 592);
    assert.ok(!overlaps(panel, size, toolbar));
    assert.ok(!overlaps(panel, size, mode));
  }
});

function movableToolbar() {
  const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const toolbar = source.slice(source.indexOf("const TOOLS:"));
  let height = 160, panelStyle;
  const measured = {get scrollHeight() {return height;}, get offsetHeight() {return Math.min(height, panelStyle.maxHeight);},
    get clientHeight() {return Math.min(height, panelStyle.maxHeight);}};
  const runtime = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    import {AnnotationToolbarButton} from "../components/AnnotationToolbarButton";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}, captureToolOptionsLayout=${captureToolOptionsLayout.toString()}; ${toolbar}`, {
    attachRef(node) {
      if (node.props.className?.includes("kiri-annotation-tool-row")) node.props.ref.current = {offsetWidth: 784, offsetHeight: 48};
      if (node.props.className === "kiri-hud kiri-capture-tool-options") {panelStyle = node.props.style; node.props.ref.current = measured;}
    },
    globals: {ResizeObserver: class {observe() {} disconnect() {}}},
  });
  const props = {selection: {x: 0, y: 0, width: 1000, height: 800}, bounds: {x: 0, y: 0, width: 1000, height: 800},
    tool: "text", appearance: {}, canSetSize: false, disabled: false, selectedMark: {id: 1},
    renderStyleControls: chrome => ({type: "fieldset", props: {className: "real-heading-fixture", children: [chrome, "properties"]}})};
  const component = runtime.mount("Toolbar", props);
  const tree = () => component.render();
  const find = className => nodes(tree()).find(node => node?.props?.className === className);
  const position = () => {
    const root = find("kiri-capture-toolbar"), panel = find("kiri-hud kiri-capture-tool-options");
    return {left: root.props.style.left + panel.props.style.left, top: root.props.style.top + panel.props.style.top};
  };
  return {runtime, component, props, tree, find, position, height: value => {height = value;}};
}
function panelPointer(currentTarget, patch = {}) {
  return {button: 0, isPrimary: true, pointerId: 7, clientX: 400, clientY: 600, currentTarget,
    prevented: false, stopped: false, preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}, ...patch};
}

test("explicitly hiding properties survives new selections until the toolbar options button reopens them", () => {
  const ui = movableToolbar();
  const hide = ui.find("kiri-capture-options-hide");
  assert.ok(hide);
  hide.props.onClick({currentTarget: {}});
  assert.equal(ui.find("kiri-hud kiri-capture-tool-options"), undefined);
  ui.component.render({...ui.props, tool: "callout", selectedMark: {id: 2}});
  assert.equal(ui.find("kiri-hud kiri-capture-tool-options"), undefined);
  nodes(ui.tree()).find(node => node?.props?.icon === "slider.horizontal.3").props.onClick();
  assert.ok(ui.find("kiri-hud kiri-capture-tool-options"));
  ui.component.unmount();
});

test("dragging properties retains their position across value and selection updates without moving the main toolbar", () => {
  const ui = movableToolbar();
  const root = ui.find("kiri-capture-toolbar");
  const anchor = {left: root.props.style.left, top: root.props.style.top};
  const initial = ui.position();
  let captured = null, releases = 0;
  const target = {setPointerCapture(id) {captured = id;}, hasPointerCapture(id) {return captured === id;},
    releasePointerCapture() {captured = null; releases++;}};
  const start = panelPointer(target);
  ui.find("kiri-capture-options-move").props.onPointerDown(start);
  assert.equal(start.prevented, true, "dragging the grip preserves a live text editor's focus");
  assert.equal(captured, 7);
  ui.find("kiri-capture-options-move").props.onPointerMove(panelPointer(target, {clientX: 320, clientY: 400}));
  ui.find("kiri-capture-options-move").props.onPointerUp(panelPointer(target));
  const dragged = ui.position();
  assert.deepEqual(dragged, {left: initial.left - 80, top: initial.top - 200});
  assert.equal(releases, 1);
  ui.height(500);
  ui.component.render({...ui.props, selectedMark: {id: 2}, appearance: {textFontSize: 40},
    avoidBounds: [{x: dragged.left, y: dragged.top, width: 500, height: 100}]});
  assert.deepEqual(ui.position(), dragged);
  const next = ui.find("kiri-capture-toolbar");
  assert.deepEqual({left: next.props.style.left, top: next.props.style.top}, anchor);
  ui.component.unmount();
});

test("property grip keyboard moves stay local and pointer capture releases on cancel or unmount", () => {
  const ui = movableToolbar();
  const before = ui.position();
  const key = panelPointer({}, {key: "ArrowLeft", shiftKey: true});
  ui.find("kiri-capture-options-move").props.onKeyDown(key);
  assert.equal(key.prevented, true); assert.equal(key.stopped, true);
  assert.equal(ui.position().left, before.left - 10);
  const enter = panelPointer({}, {key: "Enter"});
  ui.find("kiri-capture-options-move").props.onKeyDown(enter);
  assert.equal(enter.prevented, true); assert.equal(enter.stopped, true);
  let captured = false, released = 0;
  const target = {setPointerCapture() {captured = true;}, hasPointerCapture() {return captured;}, releasePointerCapture() {captured = false; released++;}};
  ui.find("kiri-capture-options-move").props.onPointerDown(panelPointer(target));
  ui.find("kiri-capture-options-move").props.onPointerCancel(panelPointer(target));
  assert.equal(released, 1);
  ui.find("kiri-capture-options-move").props.onPointerDown(panelPointer(target));
  ui.component.unmount();
  assert.equal(released, 2);
});


test("manual main toolbar positions clamp to the screen and avoid modes independently of selection", () => {
  for (const bounds of [{x: 0, y: 0, width: 1000, height: 800}, {x: -1200, y: -200, width: 1200, height: 800}]) {
    const size = {width: 784, height: 48};
    const mode = {x: bounds.x + 100, y: bounds.y + 120, width: 300, height: 44};
    for (const preferred of [{x: bounds.x + 80, y: bounds.y + 110}, {x: bounds.x - 500, y: bounds.y - 500},
      {x: bounds.x + 2000, y: bounds.y + 2000}]) {
      const position = captureToolbarPosition(bounds, bounds, size, false, mode, preferred);
      assert.ok(position.left >= bounds.x + 8 && position.left + size.width <= bounds.x + bounds.width - 8);
      assert.ok(position.top >= bounds.y + 8 && position.top + size.height <= bounds.y + bounds.height - 8);
      assert.ok(!overlaps(position, size, mode));
      assert.deepEqual(captureToolbarPosition({x: bounds.x + 200, y: bounds.y + 400, width: 100, height: 100}, bounds, size, true, mode, preferred), position);
    }
  }
});

test("main and property manual positions remain independent across tool changes and avoid each other", () => {
  const ui = movableToolbar();
  const mainPosition = () => {const root = ui.find("kiri-capture-toolbar"); return {left: root.props.style.left, top: root.props.style.top};};
  const target = {setPointerCapture() {}, hasPointerCapture() {return true;}, releasePointerCapture() {}};
  const drag = (className, dx, dy) => {
    ui.find(className).props.onPointerDown(panelPointer(target));
    ui.find(className).props.onPointerMove(panelPointer(target, {clientX: 400 + dx, clientY: 600 + dy}));
    ui.find(className).props.onPointerUp(panelPointer(target));
  };
  drag("kiri-capture-options-move", -40, -200);
  const propertyPosition = ui.position();
  const before = mainPosition();
  drag("kiri-capture-toolbar-move", 40, -100);
  const main = mainPosition();
  assert.deepEqual(main, {left: before.left + 40, top: before.top - 100});
  assert.deepEqual(ui.position(), propertyPosition, "moving the main toolbar does not attach a manually placed properties panel");
  ui.component.render({...ui.props, tool: "callout", selectedMark: {id: 4}, appearance: {textFontSize: 32},
    selection: {x: 50, y: 80, width: 800, height: 600}});
  assert.deepEqual(mainPosition(), main);
  assert.deepEqual(ui.position(), propertyPosition);
  drag("kiri-capture-toolbar-move", 0, -200);
  const next = mainPosition();
  assert.deepEqual(next, {left: main.left, top: main.top - 200}, "properties cannot move the user-positioned main row");
  const panel = ui.find("kiri-hud kiri-capture-tool-options");
  assert.ok(!overlaps(ui.position(), {width: panel.props.style.width, height: Math.min(160, panel.props.style.maxHeight)},
    {x: next.left, y: next.top, width: 784, height: 48}), "properties yield when the main row reaches them");
  ui.component.unmount();
  const fresh = movableToolbar();
  const freshRoot = fresh.find("kiri-capture-toolbar");
  assert.deepEqual({left: freshRoot.props.style.left, top: freshRoot.props.style.top}, before, "a new capture starts with automatic placement");
  fresh.component.unmount();
});

test("main toolbar grip isolates keyboard activation and releases capture when disabled, cancelled, or unmounted", () => {
  const ui = movableToolbar();
  const before = ui.find("kiri-capture-toolbar").props.style.left;
  const arrow = panelPointer({}, {key: "ArrowLeft", shiftKey: false});
  ui.find("kiri-capture-toolbar-move").props.onKeyDown(arrow);
  assert.equal(arrow.prevented, true); assert.equal(arrow.stopped, true);
  assert.equal(ui.find("kiri-capture-toolbar").props.style.left, before - 2);
  const enter = panelPointer({}, {key: "Enter"});
  ui.find("kiri-capture-toolbar-move").props.onKeyDown(enter);
  assert.equal(enter.prevented, true); assert.equal(enter.stopped, true);
  let captured = false, released = 0;
  const target = {setPointerCapture() {captured = true;}, hasPointerCapture() {return captured;}, releasePointerCapture() {captured = false; released++;}};
  ui.find("kiri-capture-toolbar-move").props.onPointerDown(panelPointer(target));
  ui.component.render({...ui.props, disabled: true});
  assert.equal(released, 1);
  ui.component.render(ui.props);
  ui.find("kiri-capture-toolbar-move").props.onPointerDown(panelPointer(target));
  ui.find("kiri-capture-toolbar-move").props.onPointerCancel(panelPointer(target));
  assert.equal(released, 2);
  ui.find("kiri-capture-toolbar-move").props.onPointerDown(panelPointer(target));
  ui.component.unmount();
  assert.equal(released, 3);
});


function adjustingCalloutToolbar() {
  const ui = movableToolbar();
  ui.height(150);
  const props = {...ui.props, tool: "callout", selection: {x: 0, y: 0, width: 1000, height: 650},
    bounds: {x: 0, y: 0, width: 1000, height: 650}};
  const resize = size => ui.component.render({...props,
    avoidBounds: [{x: 450 - size / 2, y: 475 - size / 2, width: size, height: size}]});
  resize(24);
  const field = type => ({matches: selector => selector.startsWith('input[type="number"]') && type === "number",
    closest() {return this;}});
  const panel = () => ui.find("kiri-hud kiri-capture-tool-options");
  return {...ui, field, panel, resize};
}

test("resizing a callout keeps the slider in place until the pointer adjustment ends", () => {
  const ui = adjustingCalloutToolbar(), target = ui.field("range");
  const initial = ui.position();
  assert.equal(initial.top, 303, "the sample starts directly above the small callout");
  const down = panelPointer({}, {target});
  ui.panel().props.onPointerDownCapture(down);
  ui.panel().props.onFocusCapture({target});
  assert.equal(down.prevented, false); assert.equal(down.stopped, false);
  ui.resize(80);
  assert.deepEqual(ui.position(), initial, "new annotation bounds cannot move a slider under the held pointer");
  ui.panel().props.onPointerUpCapture(panelPointer({}, {target}));
  assert.equal(ui.position().top, 275, "release restores automatic avoidance even though the range remains focused");
  ui.component.unmount();
});

test("number editing retains the panel through pointer release and focus transfer, then blur resumes avoidance", () => {
  const ui = adjustingCalloutToolbar(), first = ui.field("number"), next = ui.field("number");
  const initial = ui.position();
  ui.panel().props.onPointerDownCapture(panelPointer({}, {target: first}));
  ui.panel().props.onFocusCapture({target: first});
  ui.resize(36);
  ui.panel().props.onPointerUpCapture(panelPointer({}, {target: first}));
  assert.deepEqual(ui.position(), initial);
  ui.panel().props.onBlurCapture({target: first, relatedTarget: next, currentTarget: {contains: value => value === next}});
  ui.panel().props.onFocusCapture({target: next});
  ui.resize(80);
  assert.deepEqual(ui.position(), initial, "Tab between numeric properties keeps the current reading position");
  ui.panel().props.onBlurCapture({target: next, relatedTarget: null, currentTarget: {contains: () => false}});
  assert.equal(ui.position().top, 275, "the same blur used by Enter/Escape ends the temporary position lock");
  ui.component.unmount();
});

test("cancel, lost capture, window blur, and selection changes cannot leave property placement locked", () => {
  for (const finish of [
    ui => ui.panel().props.onPointerCancelCapture(panelPointer({})),
    ui => ui.panel().props.onLostPointerCaptureCapture(panelPointer({})),
    ui => ui.runtime.window.dispatchEvent({type: "pointerup", pointerId: 7}),
    ui => ui.runtime.window.dispatchEvent({type: "blur"}),
    ui => ui.component.render({...ui.props, selectedMark: {id: 2}}),
  ]) {
    const ui = adjustingCalloutToolbar();
    const initial = ui.position();
    ui.panel().props.onPointerDownCapture(panelPointer({}, {target: ui.field("range")}));
    ui.resize(80);
    assert.deepEqual(ui.position(), initial);
    finish(ui);
    ui.resize(80);
    assert.equal(ui.position().top, 275);
    ui.component.unmount();
  }
});

test("manual property placement takes priority during and after adjustment, while hiding clears temporary locks", () => {
  const ui = adjustingCalloutToolbar();
  const key = panelPointer({}, {key: "ArrowLeft", shiftKey: true});
  ui.find("kiri-capture-options-move").props.onKeyDown(key);
  const manual = ui.position();
  ui.panel().props.onFocusCapture({target: ui.field("number")});
  ui.resize(80);
  assert.deepEqual(ui.position(), manual);
  ui.find("kiri-capture-options-hide").props.onClick({currentTarget: {}});
  nodes(ui.tree()).find(node => node?.props?.icon === "slider.horizontal.3").props.onClick();
  assert.deepEqual(ui.position(), manual, "closing and reopening retains the user's own position");
  ui.component.unmount();
  const automatic = adjustingCalloutToolbar();
  automatic.panel().props.onFocusCapture({target: automatic.field("number")});
  automatic.resize(80);
  automatic.find("kiri-capture-options-hide").props.onClick({currentTarget: {}});
  nodes(automatic.tree()).find(node => node?.props?.icon === "slider.horizontal.3").props.onClick();
  assert.equal(automatic.position().top, 275, "a hidden numeric input cannot retain an automatic position lock");
  automatic.component.unmount();
});
