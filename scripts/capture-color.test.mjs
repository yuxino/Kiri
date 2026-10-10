import assert from "node:assert/strict";
import test from "node:test";
import { captureColorHex, captureColorPixel, captureColorPosition } from "../src/windows/capture-color.js";
import { canCopyCaptureOnKeyDown } from "../src/windows/viewer-copy-shortcut.js";

test("color coordinates use actual frozen pixels at Retina and fractional scales", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(captureColorPixel({ x: 123.75, y: 99.5 }, bounds, { width: 1600, height: 1200 }), { x: 247, y: 199 });
  assert.deepEqual(captureColorPixel({ x: 123.75, y: 99.5 }, bounds, { width: 1000, height: 750 }), { x: 154, y: 124 });
  assert.deepEqual(captureColorPixel({ x: 799.99, y: 599.99 }, bounds, { width: 1001, height: 751 }), { x: 1000, y: 750 });
  assert.deepEqual(captureColorPixel({ x: -799.5, y: -99.5 }, { ...bounds, x: -800, y: -100 }, { width: 1600, height: 1200 }), { x: 1, y: 1 });
  for (const point of [{ x: -1, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 600 }, { x: NaN, y: 3 }]) {
    assert.equal(captureColorPixel(point, bounds, { width: 1600, height: 1200 }), null);
  }
  assert.equal(captureColorPixel({ x: 0, y: 0 }, bounds, { width: 0, height: 0 }), null);
});

test("HEX preserves leading zeros and copies uppercase RGB without alpha", () => {
  assert.equal(captureColorHex(new Uint8ClampedArray([0, 3, 2, 255])), "#000302");
  assert.equal(captureColorHex([250, 128, 255, 255]), "#FA80FF");
  assert.equal(captureColorHex([255, 255, 255, 255]), "#FFFFFF");
});

test("hover panel flips clear of the pointer at all display edges", () => {
  const bounds = { x: 0, y: 0, width: 800, height: 600 };
  const size = { width: 184, height: 276 };
  for (const x of [0, 400, 799]) for (const y of [0, 300, 599]) {
    const position = captureColorPosition({ x, y }, bounds, size);
    assert.ok(position.left >= 8 && position.left + size.width <= 792);
    assert.ok(position.top >= 8 && position.top + size.height <= 592);
    assert.ok(x < position.left || x > position.left + size.width || y < position.top || y > position.top + size.height);
  }
});

test("copy shortcut preserves native editors, selections, composition and modified chords", () => {
  const event = { key: "c", metaKey: true, ctrlKey: false, target: { closest: () => null } };
  const actions = { canCopy: () => true, hasTextSelection: () => false };
  assert.ok(canCopyCaptureOnKeyDown(event, actions));
  assert.ok(canCopyCaptureOnKeyDown({ ...event, metaKey: false, ctrlKey: true }, actions));
  for (const patch of [{ altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { target: { closest: () => ({}) } }]) {
    assert.equal(canCopyCaptureOnKeyDown({ ...event, ...patch }, actions), false);
  }
  assert.equal(canCopyCaptureOnKeyDown(event, { ...actions, hasTextSelection: () => true }), false);
  assert.equal(canCopyCaptureOnKeyDown(event, { ...actions, canCopy: () => false }), false);
});
