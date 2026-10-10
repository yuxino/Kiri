import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capturePanelLayout, captureToolbarPosition } from "../src/windows/toolbar-layout.js";
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

test("only visible HUD rows receive pointer input, with measurement updated when settings grow", () => {
  const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const toolbar = source.slice(source.indexOf("const toolbarRowStyle:"), source.indexOf("function ColorSwatch("));
  let height = 48;
  const measured = { get offsetWidth() { return 550; }, get offsetHeight() { return height; } };
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const TOOLS=[], COLOR_PRESETS=[];
    const captureToolbarPosition=${captureToolbarPosition.toString()}; ${toolbar}; export {Toolbar};`, {
    attachRef(node) { if (node.props.className === "kiri-capture-toolbar") node.props.ref.current = measured; },
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
  });
  const props = { selection: { x: 80, y: 150, width: 1040, height: 620 },
    bounds: { x: 0, y: 0, width: 1200, height: 800 }, modeSelectorBounds: { x: 445, y: 44, width: 310, height: 44 },
    tool: "select", appearance: {}, canSetSize: false, disabled: false };
  const component = harness.mount("Toolbar", props);
  let tree = component.render();
  let root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.pointerEvents, "none");
  assert.ok(root.props.style.zIndex > 5, "selection keylines must not paint over controls");
  height = 230;
  tree = component.render({ ...props, tool: "callout", selectedCalloutId: 1, showCalloutControls: true, calloutControls: "callout-controls" });
  root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.ok(root.props.style.top >= props.selection.y + 10);
  assert.ok(root.props.style.top + height <= props.selection.y + props.selection.height - 10);
  const hud = nodes(tree).find(node => node?.props?.className === "kiri-hud");
  assert.equal(hud.props.style.pointerEvents, "auto");
  const settings = nodes(tree).find(node => node?.props?.children?.includes("callout-controls"));
  assert.equal(settings.props.style.pointerEvents, "auto");
  assert.equal(settings.props.style.width, "max-content");
  height = 130;
  tree = component.render({ ...props, tool: "select", selectedLabelId: 2,
    showLabelControls: true, labelControls: "label-controls" });
  root = nodes(tree).find(node => node?.props?.className === "kiri-capture-toolbar");
  assert.equal(root.props.style.pointerEvents, "none", "a selected label must keep blank toolbar space pass-through");
  const labelSettings = nodes(tree).find(node => node?.props?.children?.includes("label-controls"));
  assert.ok(labelSettings, "selecting an existing label opens its settings");
  assert.equal(labelSettings.props.style.pointerEvents, "auto", "label color and font controls remain interactive");
  assert.equal(labelSettings.props.style.width, "max-content", "label settings must not fill the wider main toolbar");
  assert.equal(labelSettings.props.style.maxWidth, "100%");
  assert.ok(root.props.style.top >= props.selection.y + 10);
  assert.ok(root.props.style.top + height <= props.selection.y + props.selection.height - 10);
  assert.ok(!nodes(tree).some(node => node?.props?.children?.includes("callout-controls")), "changing to a label must remove stale callout settings");
  component.unmount();
});

test("the installed X11 recording region keeps MP4 and its footer clear of the Screenshot mode button", () => {
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

test("scrollable Record and OCR panels stay clear of wrapped and dragged modes at every edge", () => {
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

test("panel placement measures hidden recording content while keeping the footer outside its scroll area", () => {
  const source = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const panel = source.slice(source.indexOf("export function RecordOptionsPanel("), source.indexOf("interface ToolbarProps"));
  let naturalHeight = 460, style;
  const measured = { getBoundingClientRect() { return { height: Math.min(naturalHeight, style.maxHeight) }; } };
  const scroll = { get scrollHeight() { return naturalHeight - 76; },
    get clientHeight() { return Math.max(0, Math.min(naturalHeight, style.maxHeight) - 76); }, firstElementChild: {} };
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const ToolButton=()=>null, captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()};
    ${panel}`, {
    attachRef(node) {
      if (node.props.ref && node.props.className === "kiri-hud") { style = node.props.style; node.props.ref.current = measured; }
      if (node.props.ref && node.props.style?.overflowY === "auto") node.props.ref.current = scroll;
    },
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
  });
  const props = { anchor: { x: 300, y: 10, width: 680, height: 380 }, bounds: { x: 0, y: 0, width: 1280, height: 800 },
    modeSelectorBounds: { x: 492, y: 44, width: 296, height: 44 }, options: { outputFormat: "mp4" }, sizeControlsOpen: false };
  const component = harness.mount("RecordOptionsPanel", props);
  let tree = component.render();
  let root = nodes(tree).find(node => node?.props?.className === "kiri-hud");
  assert.equal(root.props.style.top, 400);
  assert.equal(root.props.style.maxHeight, 392);
  naturalHeight = 740;
  tree = component.render({ ...props, bounds: { x: 0, y: 0, width: 320, height: 480 },
    anchor: { x: 0, y: 0, width: 320, height: 480 }, modeSelectorBounds: { x: 8, y: 44, width: 304, height: 80 } });
  root = nodes(tree).find(node => node?.props?.className === "kiri-hud");
  assert.equal(root.props.style.width, 304);
  assert.ok(root.props.style.top >= 134);
  assert.ok(root.props.style.top + root.props.style.maxHeight <= 472);
  const footer = nodes(tree).find(node => node?.props?.style?.flexShrink === 0 && node.props.style.display === "flex");
  assert.ok(footer, "Start/Cancel must remain in the fixed footer");
  assert.ok(!nodes(footer).some(node => node?.props?.ref?.current === scroll));
  component.unmount();
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
