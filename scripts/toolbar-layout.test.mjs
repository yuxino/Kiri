import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { captureToolbarPosition } from "../src/windows/toolbar-layout.js";
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
