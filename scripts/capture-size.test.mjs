import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";
import { capturePanelLayout, captureToolbarPosition } from "../src/windows/toolbar-layout.js";
import { capturePixelSize, captureSizePositions, resizeCapturePixels } from "../src/windows/capture-size.js";

test("Retina and fractional-scale dimensions are physical pixels", () => {
  assert.deepEqual(capturePixelSize({ x: 0, y: 0, width: 100, height: 80 }, 2), { width: 200, height: 160 });
  const bounds = { x: -800, y: -100, width: 800, height: 600 };
  const selection = { x: -600, y: 100, width: 100, height: 80 };
  const resized = resizeCapturePixels(selection, bounds, 1.25, "width", 321);
  assert.equal(capturePixelSize(resized, 1.25).width, 321);
  assert.equal(resized.height, selection.height);
  assert.equal(resized.y, selection.y);
  assert.equal(resized.x + resized.width / 2, selection.x + selection.width / 2);
});

test("exact-size changes fit the display and keep a usable selection", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const selection = { x: 700, y: 500, width: 80, height: 80 };
  assert.deepEqual(resizeCapturePixels(selection, bounds, 2, "width", 900),
    { x: 350, y: 500, width: 450, height: 80 });
  assert.deepEqual(resizeCapturePixels(selection, bounds, 2, "height", 5000),
    { x: 700, y: 0, width: 80, height: 600 });
  assert.equal(resizeCapturePixels(selection, bounds, 2, "width", 1).width, 3);
  for (const value of [0, -10, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(resizeCapturePixels(selection, bounds, 2, "width", value), selection);
  }
});

test("edge fields clear resize handles and stay within every display corner", () => {
  const bounds = { x: -800, y: -100, width: 800, height: 600 };
  const sizes = { width: { width: 52, height: 24 }, height: { width: 48, height: 24 } };
  for (const width of [3, 80, 600]) for (const height of [3, 80, 500]) {
    for (const x of [bounds.x, bounds.x + bounds.width - width]) {
      for (const y of [bounds.y, bounds.y + bounds.height - height]) {
        const positions = captureSizePositions({ x, y, width, height }, bounds, sizes);
        for (const axis of ["width", "height"]) {
          const position = positions[axis];
          assert.ok(position.left >= bounds.x + 6);
          assert.ok(position.top >= bounds.y + 6);
          assert.ok(position.left + sizes[axis].width <= bounds.x + bounds.width - 6);
          assert.ok(position.top + sizes[axis].height <= bounds.y + bounds.height - 6);
        }
        const a = positions.width, b = positions.height;
        assert.ok(a.left + sizes.width.width <= b.left || b.left + sizes.height.width <= a.left ||
          a.top + sizes.width.height <= b.top || b.top + sizes.height.height <= a.top,
        `labels overlap for ${JSON.stringify({ x, y, width, height })}`);
      }
    }
  }
});

test("the existing screenshot sliders toggle edge fields without completing capture", () => {
  const overlay = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");
  const toolbar = overlay.slice(overlay.indexOf("const TOOLS:"));
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}; ${toolbar}`);
  let toggles = 0, captures = 0;
  const props = { selection:{x:100,y:100,width:140,height:160}, bounds:{x:0,y:0,width:1000,height:700},
    tool:"select", appearance:{}, canUndo:false, canRedo:false, canSetSize:true, disabled:false,
    sizeControlsOpen:false, onToggleSize:()=>toggles++, onDone:()=>captures++ };
  const component = harness.mount("Toolbar", props);
  let tree = component.render();
  let button = nodes(tree).find(node => node?.props?.title === "Resize selection");
  assert.ok(button);
  assert.equal(button.props.expanded, false);
  button.props.onClick();
  assert.equal(toggles, 1);
  assert.equal(captures, 0);
  tree = component.render({ ...props, sizeControlsOpen:true });
  button = nodes(tree).find(node => node?.props?.title === "Resize selection");
  assert.equal(button.props.active, true);
  assert.equal(button.props.expanded, true);
  assert.equal(nodes(tree).filter(node => node?.type === "input").length, 0);
  component.unmount();
});

test("above-selection toolbar placement leaves space for the width field", () => {
  const selection = { x: 650, y: 420, width: 140, height: 160 };
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const toolbar = { width: 784, height: 81 };
  const position = captureToolbarPosition(selection, bounds, toolbar, true);
  const fields = captureSizePositions(selection, bounds, {width:{width:52,height:24},height:{width:48,height:24}});
  assert.ok(position.top + toolbar.height + 10 <= fields.width.top);
});
