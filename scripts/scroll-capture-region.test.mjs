import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ScrollCaptureRegionWindow.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/windows/scroll-capture-region.css", import.meta.url), "utf8");
const overlap = (a, b) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
function region(t, selection, size = { width: 800, height: 600, scale: 2 }) {
  const h = createLibraryHarness({}, source);
  h.window.innerWidth = size.width; h.window.innerHeight = size.height; h.window.devicePixelRatio = size.scale;
  const component = h.mount("ScrollCaptureRegionWindow", selection);
  t.after(() => component.unmount());
  return { render: () => component.render(), resize(width, height, scale = size.scale) {
    h.window.innerWidth = width; h.window.innerHeight = height; h.window.devicePixelRatio = scale;
    h.window.dispatchEvent({ type: "resize" });
    return component.render();
  } };
}
const painted = tree => nodes(tree).filter(node => /kiri-scroll-region__(mask|border|hint-slot)$/.test(node?.props?.className));

test("the mask partitions only the area outside the selection and its border stays outside", t => {
  const selection = { x: 200, y: 150, width: 400, height: 300 };
  const h = region(t, selection);
  const tree = h.render();
  const hole = { left: 200, top: 150, width: 400, height: 300 };
  const masks = nodes(tree).filter(node => node?.props?.className === "kiri-scroll-region__mask").map(node => node.props.style);
  assert.equal(masks.length, 4);
  assert.equal(masks.reduce((area, rect) => area + rect.width * rect.height, 0), 800 * 600 - 400 * 300);
  for (const node of painted(tree)) assert.equal(overlap(node.props.style, hole), 0);
  for (let a = 0; a < masks.length; a++) for (let b = a + 1; b < masks.length; b++) assert.equal(overlap(masks[a], masks[b]), 0);
});

test("fractional scales and every display edge keep all painted pixels outside the true selection", t => {
  for (const scale of [1, 1.25, 1.5, 2, 3]) for (const selection of [
    { x: 0, y: 0, width: 400, height: 300 },
    { x: 400, y: 0, width: 400, height: 300 },
    { x: 0, y: 300, width: 400, height: 300 },
    { x: 400, y: 300, width: 400, height: 300 },
    { x: 0, y: 0, width: 800, height: 600 },
    { x: 111.3, y: 99.7, width: 410.4, height: 311.8 },
    { x: -20.3, y: -10.2, width: 500.1, height: 400.4 },
  ]) {
    const h = region(t, selection, { width: 800, height: 600, scale });
    const hole = { left: Math.max(0, selection.x), top: Math.max(0, selection.y),
      width: Math.min(800, selection.x + selection.width) - Math.max(0, selection.x),
      height: Math.min(600, selection.y + selection.height) - Math.max(0, selection.y) };
    for (const node of painted(h.render())) assert.equal(overlap(node.props.style, hole), 0,
      `${node.props.className} must stay outside at scale ${scale}`);
  }
});

test("the hint moves below a top-edge selection and disappears when no outside space is available", t => {
  const top = region(t, { x: 200, y: 0, width: 400, height: 300 });
  const hint = nodes(top.render()).find(node => node?.props?.className === "kiri-scroll-region__hint-slot");
  assert.equal(hint.props.style.top, 308);
  const full = region(t, { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(nodes(full.render()).find(node => node?.props?.className === "kiri-scroll-region__hint-slot"), undefined);
  assert.equal(nodes(full.render()).filter(node => node?.props?.className === "kiri-scroll-region__mask").length, 0);
});

test("viewport changes recompute the transparent hole and hint without stale full-screen extents", t => {
  const h = region(t, { x: 100, y: 10, width: 400, height: 300 }); h.render();
  const tree = h.resize(450, 310, 1.5);
  const masks = nodes(tree).filter(node => node?.props?.className === "kiri-scroll-region__mask").map(node => node.props.style);
  assert.deepEqual(masks, [
    { left: 0, top: 0, width: 450, height: 10 },
    { left: 0, top: 10, width: 100, height: 300 },
  ]);
  assert.equal(nodes(tree).find(node => node?.props?.className === "kiri-scroll-region__hint-slot"), undefined);
});

test("invalid, empty or entirely off-display selections never paint a blocking full-screen layer", t => {
  for (const selection of [
    { x: NaN, y: 0, width: 400, height: 300 },
    { x: 0, y: Infinity, width: 400, height: 300 },
    { x: 0, y: 0, width: 0, height: 300 },
    { x: 0, y: 0, width: 400, height: -1 },
    { x: -400, y: 0, width: 100, height: 300 },
    { x: 900, y: 0, width: 100, height: 300 },
  ]) assert.equal(region(t, selection).render(), null);
});

test("the whole passive surface has no handlers or focus targets and never paints inside the hole", t => {
  const tree = region(t, { x: 200, y: 150, width: 400, height: 300 }).render();
  assert.equal(tree.props["aria-hidden"], "true");
  for (const node of nodes(tree).filter(node => node?.props)) {
    assert.equal(node.props.tabIndex, undefined);
    assert.ok(!["button", "input", "textarea", "select", "a"].includes(node.type));
    assert.deepEqual(Object.keys(node.props).filter(key => /^on[A-Z]/.test(key)), []);
  }
  assert.match(css, /\.kiri-scroll-region,\s*\.kiri-scroll-region \*\s*\{\s*pointer-events:\s*none;/);
  assert.match(css, /\.kiri-scroll-region\s*\{[^}]*background:\s*transparent;/);
  assert.doesNotMatch(css, /box-shadow|backdrop-filter|filter:|outline:|border:\s*[^0]/);
});

test("the lazy route passes display-local logical query coordinates into the passive window", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /case "scroll-capture-region":\s*return <ScrollCaptureRegionWindow/);
  for (const name of ["x", "y", "width", "height"]) assert.ok(main.includes(`${name}={Number(params.get("${name}"))}`));
});
