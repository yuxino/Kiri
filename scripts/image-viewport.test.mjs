import assert from "node:assert/strict";
import test from "node:test";
import {imageViewport, imageZoomAnchor, scrollToImageAnchor, visibleImageViewport} from "../src/annotation/image-viewport.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} must be ${expected}`);
const pointNear = (actual, expected) => {near(actual.x, expected.x); near(actual.y, expected.y);};

test("ordinary images fit both axes without enlarging beyond native device pixels", () => {
  const view = {width: 800, height: 560};
  const layout = imageViewport({width: 1200, height: 800}, view);
  near(layout.width, 776); near(layout.height, 1552 / 3);
  near(layout.x, 12); near(layout.y, 64 / 3);
  assert.equal(layout.surfaceWidth, view.width); assert.equal(layout.surfaceHeight, view.height);
  const small = imageViewport({width: 300, height: 200}, view, "auto", 1, 2);
  assert.equal(small.width, 150); assert.equal(small.height, 100);
  assert.equal(small.zoom, 1); assert.equal(small.x, 325); assert.equal(small.y, 230);
});

test("long screenshots default to legible width or native scale with their first row at the top", () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    const image = {width: 1200, height: 12000}, view = {width: 800, height: 560};
    const layout = imageViewport(image, view, "auto", 1, dpr);
    near(layout.scale, Math.min(776 / 1200, 1 / dpr));
    assert.equal(layout.y, 12);
    assert.equal(layout.surfaceHeight, layout.height + 24);
    assert.ok(layout.height > view.height);
    assert.ok(layout.zoom <= 1);
  }
});

test("fit width may enlarge a small image explicitly while fit image respects native resolution", () => {
  const image = {width: 320, height: 240}, view = {width: 1000, height: 700};
  const width = imageViewport(image, view, "width", 1, 2);
  assert.equal(width.width, 976); assert.equal(width.scale, 3.05); assert.equal(width.zoom, 6.1);
  assert.equal(width.surfaceWidth, 1000); assert.equal(width.surfaceHeight, width.height + 24);
  const fit = imageViewport(image, view, "fit", 1, 2);
  assert.equal(fit.width, 160); assert.equal(fit.height, 120); assert.equal(fit.zoom, 1);
});

test("actual size and manual zoom map each source pixel to the requested device pixels at fractional DPI", () => {
  for (const dpr of [1, 1.25, 1.5, 2, 3]) for (const zoom of [.125, .5, 1, 2, 8]) {
    const image = {width: 1181, height: 31001}, view = {width: 911, height: 633};
    const layout = imageViewport(image, view, "manual", zoom, dpr);
    near(layout.width * dpr, image.width * zoom);
    near(layout.height * dpr, image.height * zoom);
    near(layout.zoom, zoom);
    assert.ok(layout.x >= 12 && layout.y >= 12);
    assert.ok(layout.surfaceWidth >= view.width && layout.surfaceHeight >= view.height);
  }
});

test("zoom preserves both a cursor anchor and a center anchor in source coordinates", () => {
  const image = {width: 4000, height: 30000}, view = {width: 800, height: 560};
  for (const dpr of [1, 1.5, 2]) for (const point of [{x: 400, y: 280}, {x: 140.25, y: 451.5}]) {
    const old = imageViewport(image, view, "manual", 1, dpr);
    const source = imageZoomAnchor(old, {x: 240, y: 4000}, point);
    const next = imageViewport(image, view, "manual", 1.25, dpr);
    const scroll = scrollToImageAnchor(next, view, source, point);
    pointNear(imageZoomAnchor(next, scroll, point), source);
  }
});

test("zooming out to a centered image clamps scrolling rather than creating unreachable negative overflow", () => {
  const view = {width: 800, height: 560};
  const layout = imageViewport({width: 640, height: 360}, view, "manual", .5, 2);
  assert.deepEqual(scrollToImageAnchor(layout, view, {x: 0, y: 0}, {x: 400, y: 280}), {x: 0, y: 0});
  assert.deepEqual(scrollToImageAnchor(layout, view, {x: 640, y: 360}, {x: 0, y: 0}), {x: 0, y: 0});
  assert.ok(layout.x > 0 && layout.y > 0);
});

test("extreme anchors clamp to the scrollable surface edges", () => {
  const view = {width: 800, height: 560};
  const layout = imageViewport({width: 2000, height: 10000}, view, "manual", 2, 2);
  assert.deepEqual(scrollToImageAnchor(layout, view, {x: -10000, y: -10000}, {x: 400, y: 280}), {x: 0, y: 0});
  assert.deepEqual(scrollToImageAnchor(layout, view, {x: 100000, y: 100000}, {x: 400, y: 280}),
    {x: layout.surfaceWidth - view.width, y: layout.surfaceHeight - view.height});
});

test("resizing or changing DPI preserves the center source point whenever bounds permit", () => {
  const image = {width: 4000, height: 30000}, oldSize = {width: 800, height: 560};
  const old = imageViewport(image, oldSize, "manual", 1, 1);
  const source = imageZoomAnchor(old, {x: 500, y: 8000}, {x: 400, y: 280});
  for (const [size, dpr] of [[{width: 1000, height: 700}, 1], [oldSize, 2]]) {
    const next = imageViewport(image, size, "manual", 1, dpr), center = {x: size.width / 2, y: size.height / 2};
    const scroll = scrollToImageAnchor(next, size, source, center);
    pointNear(imageZoomAnchor(next, scroll, center), source);
  }
});

test("visible raster covers every on-screen image pixel with bounded overscan throughout a long document", () => {
  const view = {width: 800, height: 560};
  for (const image of [{width: 200, height: 120}, {width: 1200, height: 12000}, {width: 30000, height: 1200}]) {
    for (const zoom of [.5, 1, 4]) {
      const layout = imageViewport(image, view, "manual", zoom, 2);
      for (const fraction of [0, .2, .5, 1]) {
        const scroll = {x: (layout.surfaceWidth - view.width) * fraction, y: (layout.surfaceHeight - view.height) * fraction};
        const visible = visibleImageViewport(layout, view, scroll);
        assert.ok(visible.width <= view.width + 192 && visible.height <= view.height + 192);
        assert.ok(visible.x >= 0 && visible.y >= 0);
        assert.ok(visible.x + visible.width <= layout.width + 1e-7);
        assert.ok(visible.y + visible.height <= layout.height + 1e-7);
        assert.ok(visible.x <= Math.max(0, scroll.x - layout.x));
        assert.ok(visible.y <= Math.max(0, scroll.y - layout.y));
        assert.ok(visible.x + visible.width >= Math.min(layout.width, scroll.x - layout.x + view.width));
        assert.ok(visible.y + visible.height >= Math.min(layout.height, scroll.y - layout.y + view.height));
      }
    }
  }
});
