import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes, settleRequests } from "./helpers/library-render-harness.mjs";
import { isTextComposition } from "../src/annotation/text-composition.js";

const readWindow = name => readFileSync(new URL(`../src/windows/${name}`, import.meta.url), "utf8");
const source = 'import React from "react";\n' + readWindow("useScrollCaptureDrag.ts")
  .replace(/^import .* from "react";\r?\n/m, "")
  .replace(/^import .* from "..\/lib\/ipc";\r?\n/m, "") + readWindow("ScrollCaptureWindow.tsx")
  .replace(/^import .* from ".\/useScrollCaptureDrag";\r?\n/m, "");
const snapshot = (changes = {}) => ({
  sessionId: "scroll-1", phase: "capturing", width: 400, height: 800,
  revision: 1, frames: 3, viewportTop: 100, viewportHeight: 200,
  contentOrigin: 0, canSavePartial: false, ...changes,
});
const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001,
  `${message ?? "preview position"}: expected ${expected}, got ${actual}`);
const visibleImage = h => nodes(h.render()).find(node => node?.type === "img" && node.props["data-visible"]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function panel(t, options = {}) {
  let current = snapshot();
  let sequence = 0;
  const timers = new Map();
  const requests = [];
  const finishes = [];
  const cancellations = [];
  const positions = [], nativeReads = [];
  let nativePosition = { x: -400, y: 100 }, nativeScale = 2, scaleChanged, scaleDisposals = 0;
  const native = {
    outerPosition() { nativeReads.push("position"); return options.outerPosition?.() ?? Promise.resolve({ ...nativePosition }); },
    scaleFactor() { nativeReads.push("scale"); return options.scaleFactor?.() ?? Promise.resolve(nativeScale); },
    async onScaleChanged(callback) {
      scaleChanged = callback;
      await options.scaleSubscription;
      return () => { scaleDisposals++; if (scaleChanged === callback) scaleChanged = null; };
    },
  };
  const captured = new Set(), releases = [];
  const dragTarget = {
    setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); },
    releasePointerCapture(id) { releases.push(id); captured.delete(id); },
  };
  let resize;
  const viewport = { clientWidth: 200, clientHeight: 100, scrollTop: 0, scrollLeft: 0 };
  const images = [], imageElements = new Map();
  const harness = createLibraryHarness({
    moveScrollCapturePanel(sessionId, x, y) {
      const pending = deferred();
      const move = { sessionId, x, y, reject: pending.reject,
        resolve(accepted = { x, y }) {
          if (!options.nativePositionLags) nativePosition = accepted;
          pending.resolve(accepted);
        } };
      positions.push(move);
      if (!options.deferredMoves) move.resolve();
      return pending.promise;
    },
    scrollCaptureStatus: sessionId => {
      requests.push(sessionId);
      return options.read ? options.read() : Promise.resolve(current);
    },
    finishScrollCapture: (sessionId, allowPartial) => {
      finishes.push({ sessionId, allowPartial });
      return options.finish ? options.finish() : Promise.resolve();
    },
    cancelScrollCapture: sessionId => {
      cancellations.push(sessionId);
      return options.cancel ? options.cancel() : Promise.resolve();
    },
  }, source, {
    strictEffects: options.strictEffects,
    modules: {
      "@tauri-apps/api/window": { getCurrentWindow: () => native },
      "../annotation/text-composition.js": { isTextComposition },
    },
    attachRef(node) {
      if (node.props?.className === "kiri-scroll-capture__preview") node.props.ref.current = viewport;
      if (node.type !== "img" || node.props["data-preview-slot"] === undefined) return;
      const slot = node.props["data-preview-slot"];
      if (!imageElements.has(slot)) imageElements.set(slot, {
        src: undefined, complete: false, naturalWidth: 0,
        getAttribute(name) { return name === "src" ? this.src : null; },
      });
      const element = imageElements.get(slot);
      if (element.src === node.props.src) return;
      element.src = node.props.src;
      element.complete = false;
      element.naturalWidth = 0;
      if (!node.props.src) return;
      const pending = deferred();
      let loaded = false;
      const request = { src: node.props.src, slot, element,
        load() {
          if (loaded) return;
          loaded = true;
          element.complete = true; element.naturalWidth = 1200;
          element.decode = () => pending.promise;
          node.props.onLoad({ currentTarget: element });
        },
        resolve() { request.load(); pending.resolve(); },
        reject() { request.load(); pending.reject(new Error("PNG decode failed")); },
        error() { node.props.onError(); },
      };
      images.push(request);
      if (!options.deferredImages) void Promise.resolve().then(() => request.resolve());
    },
    globals: {
      ResizeObserver: class {
        constructor(callback) { resize = callback; }
        observe() {}
        disconnect() { resize = undefined; }
      },
      setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  const component = harness.mount("ScrollCaptureWindow", { sessionId: "scroll-1", compact: !!options.compact });
  component.render();
  t.after(() => component.unmount());
  const render = () => component.render();
  const node = className => nodes(render()).find(item => item?.props?.className === className);
  const ready = async () => {
    for (let pass = 0; pass < 4; pass++) { await settleRequests(); render(); }
    return render();
  };
  const pump = async () => {
    const first = timers.entries().next().value;
    if (first) { timers.delete(first[0]); first[1](); }
    return ready();
  };
  return { component, render, node, timers, requests, finishes, cancellations, viewport,
    positions, nativeReads, dragTarget, captured, releases, images, imageElements,
    scale(value) { nativeScale = value; scaleChanged?.(); },
    scaleDisposals: () => scaleDisposals,

    resize(value) { Object.assign(viewport, value); resize?.(); return render(); },
    ready,
    async update(value) { current = snapshot(value); return pump(); },
    pump,
  };
}

test("a slow status read stays single-flight and unmount stops polling", async t => {
  const pending = deferred();
  const h = panel(t, { read: () => pending.promise });
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
  h.component.render(); h.component.render();
  assert.equal(h.requests.length, 1);
  pending.resolve(snapshot());
  await h.ready();
  assert.equal(h.timers.size, 1);
  h.component.unmount();
  assert.equal(h.timers.size, 0);
});

test("strict effects discard their old read and do not restart a disposed polling chain", async t => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const h = panel(t, { strictEffects: true, read: () => (++reads === 1 ? first : second).promise });
  second.resolve(snapshot({ height: 1200 }));
  await h.ready();
  first.resolve(snapshot({ height: 200 }));
  await h.ready();
  assert.ok(nodes(h.render()).includes(1200));
  assert.equal(h.timers.size, 1);
});





test("Done is single-flight and normal completion never authorizes partial saving", async t => {
  const pending = deferred();
  const h = panel(t, { finish: () => pending.promise });
  await h.ready();
  const button = h.node("kiri-primary-button kiri-scroll-capture__done");
  assert.equal(button.props.disabled, false);
  button.props.onClick(); button.props.onClick();
  assert.deepEqual(h.finishes, [{ sessionId: "scroll-1", allowPartial: false }]);
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, false, "finishing remains cancellable until persistence starts");
  pending.reject(new Error("Could not save scrolling capture. Try again."));
  await h.ready();
  assert.ok(nodes(h.render()).includes("Could not save scrolling capture. Try again."));
  assert.equal(h.node("kiri-primary-button kiri-scroll-capture__done").props.disabled, false);
});

test("unconnected content blocks Done until explicit partial saving is offered", async t => {
  const h = panel(t);
  await h.ready();
  await h.update({ phase: "reconnecting" });
  assert.equal(h.node("kiri-primary-button kiri-scroll-capture__done").props.disabled, true);
  await h.update({ phase: "reconnecting", canSavePartial: true });
  const partial = h.node("kiri-primary-button kiri-scroll-capture__done");
  assert.ok(nodes(partial).includes("Save captured area"));
  partial.props.onClick();
  assert.deepEqual(h.finishes, [{ sessionId: "scroll-1", allowPartial: true }]);
});

test("the panel never captures Enter and Escape ignores composition", async t => {
  const h = panel(t);
  await h.ready();
  let prevented = 0;
  const key = (key, composition = false) => h.render().props.onKeyDown({
    key, repeat: false, nativeEvent: { isComposing: composition, keyCode: composition ? 229 : 0 },
    preventDefault() { prevented++; }, stopPropagation() {},
  });
  key("Enter");
  key("Escape", true);
  assert.equal(prevented, 0);
  assert.equal(h.finishes.length, 0);
  assert.equal(h.cancellations.length, 0);
  key("Escape");
  assert.equal(prevented, 1);
  assert.deepEqual(h.cancellations, ["scroll-1"]);
});

test("compact controls keep status and both actions without building a preview", async t => {
  const h = panel(t, { compact: true });
  await h.ready();
  assert.equal(h.node("kiri-scroll-capture__preview"), undefined);
  assert.ok(h.node("kiri-scroll-capture__status"));
  assert.ok(h.node("kiri-scroll-capture__cancel"));
  assert.ok(h.node("kiri-primary-button kiri-scroll-capture__done"));
});







test("a successful finish stays locked and stops polling while native closure is pending", async t => {
  const h = panel(t);
  await h.ready();
  h.node("kiri-primary-button kiri-scroll-capture__done").props.onClick();
  await h.ready();
  assert.equal(h.node("kiri-primary-button kiri-scroll-capture__done").props.disabled, true);
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, true);
  const reads = h.requests.length;
  await h.pump();
  assert.equal(h.requests.length, reads);
  h.node("kiri-primary-button kiri-scroll-capture__done").props.onClick();
  h.node("kiri-scroll-capture__cancel").props.onClick();
  assert.equal(h.finishes.length, 1);
  assert.equal(h.cancellations.length, 0);
});

test("cancel can interrupt finishing and the old finish error cannot replace cancellation", async t => {
  const finish = deferred(), cancel = deferred();
  const h = panel(t, { finish: () => finish.promise, cancel: () => cancel.promise });
  await h.ready();
  h.node("kiri-primary-button kiri-scroll-capture__done").props.onClick();
  await h.update({ phase: "finishing" });
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, false);
  h.node("kiri-scroll-capture__cancel").props.onClick();
  h.node("kiri-scroll-capture__cancel").props.onClick();
  assert.deepEqual(h.cancellations, ["scroll-1"]);
  finish.reject(new Error("The scrolling capture is no longer active."));
  await h.ready();
  assert.ok(!nodes(h.render()).includes("Could not finish scrolling capture. Try again."));
  cancel.resolve();
  await h.ready();
  const reads = h.requests.length;
  await h.pump();
  assert.equal(h.requests.length, reads);
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, true);
});

test("cancel failure can be retried but saving keeps cancellation unavailable", async t => {
  let attempts = 0;
  const h = panel(t, { cancel: () => ++attempts === 1 ? Promise.reject(new Error("temporary failure")) : Promise.resolve() });
  await h.ready();
  await h.update({ phase: "saving" });
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, true);
  h.node("kiri-scroll-capture__cancel").props.onClick();
  assert.equal(h.cancellations.length, 0);
  await h.update({ phase: "capturing" });
  h.node("kiri-scroll-capture__cancel").props.onClick();
  await h.ready();
  assert.ok(nodes(h.render()).includes("Could not cancel scrolling capture. Try again."));
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, false);
  h.node("kiri-scroll-capture__cancel").props.onClick();
  await h.ready();
  assert.equal(h.cancellations.length, 2);
  assert.equal(h.node("kiri-scroll-capture__cancel").props.disabled, true);
});

test("a recovered live source replaces a prior reconnect error with its current status", async t => {
  const h = panel(t, { finish: () => Promise.reject(new Error("Return to captured content to continue.")) });
  await h.ready();
  h.node("kiri-primary-button kiri-scroll-capture__done").props.onClick();
  await h.ready();
  assert.ok(nodes(h.node("kiri-scroll-capture__status")).includes("Return to captured content to continue."));
  await h.update({ phase: "reconnecting", frames: 4 });
  assert.ok(nodes(h.node("kiri-scroll-capture__status")).includes("Return to captured content to continue."));
  await h.update({ phase: "capturing", frames: 5 });
  assert.ok(nodes(h.node("kiri-scroll-capture__status")).includes("Scroll up or down"));
});


test("one live preview fits the image width without mode or zoom controls", async t => {
  const h = panel(t);
  await h.ready();
  assert.ok(nodes(h.render()).includes("Preparing preview…"));
  const detail = { image: "data:image/png;base64,sharp", revision: 3, left: 0, top: 1200,
    width: 1200, height: 800, displayScale: 2 };
  await h.update({ width: 1200, height: 2400, viewportTop: 1200, viewportHeight: 800, detailPreview: detail });
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 600, aspectRatio: "1200 / 800" });
  assert.equal(visibleImage(h).props.src, detail.image);
  assert.equal(h.viewport.scrollLeft, 0);
  closeTo(h.viewport.scrollTop, (800 * 200 / 1200 - 100) / 2);
  const buttons = nodes(h.render()).filter(node => node?.type === "button");
  assert.equal(buttons.length, 2, "only Cancel and Done remain");
  assert.ok(nodes(buttons[0]).includes("Cancel"));
  assert.ok(nodes(buttons[1]).includes("Done"));
  assert.equal(h.finishes.length, 0);
  assert.equal(h.cancellations.length, 0);
});

test("the live preview follows both source directions at its fitted width", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,sharp", revision: 3, left: 0, top: 800,
    width: 1200, height: 1200, displayScale: 2 };
  await h.update({ width: 1200, height: 2400, viewportTop: 1000, viewportHeight: 600, detailPreview: detail });
  await h.update({ width: 1200, height: 2400, viewportTop: 1200, viewportHeight: 600, detailPreview: detail });
  closeTo(h.viewport.scrollTop, 1000 * 200 / 1200 - 100, "downward scrolling reveals the newest bottom edge");
  await h.update({ width: 1200, height: 2400, viewportTop: 1000, viewportHeight: 600, detailPreview: detail });
  closeTo(h.viewport.scrollTop, 200 * 200 / 1200, "upward scrolling reveals the newly reached top edge");
  assert.equal(h.viewport.scrollLeft, 0);
});

test("preview inspection keeps the same pixels until the pointer leaves, then resumes live", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,sharp-first", revision: 3, left: 0, top: 800,
    width: 1200, height: 1200, displayScale: 2 };
  await h.update({ width: 1200, height: 2400, viewportTop: 1000, viewportHeight: 600, detailPreview: detail });
  h.node("kiri-scroll-capture__preview").props.onWheel();
  h.viewport.scrollTop = 50;
  const latest = { ...detail, image: "data:image/png;base64,sharp-next", revision: 5, top: 1600, height: 800 };
  await h.update({ width: 1200, height: 3200, viewportTop: 1800, viewportHeight: 600, detailPreview: latest });
  assert.equal(visibleImage(h).props.src, detail.image);
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 600, aspectRatio: "1200 / 1200" });
  assert.equal(h.viewport.scrollTop, 50);
  h.node("kiri-scroll-capture__preview").props.onPointerLeave();
  h.render();
  assert.equal(visibleImage(h).props.src, latest.image);
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 600, aspectRatio: "1200 / 800" });
  closeTo(h.viewport.scrollTop, 800 * 200 / 1200 - 100);
});

test("an omitted preview retains the image and geometry while the document grows", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,sharp-first", revision: 3, left: 0, top: -400,
    width: 1200, height: 800, displayScale: 2 };
  await h.update({ width: 1200, height: 2400, viewportTop: 0, contentOrigin: -400, viewportHeight: 800, detailPreview: detail });
  const position = h.viewport.scrollTop;
  for (const height of [4000, 8000, 16000]) {
    await h.update({ width: 1600, height, viewportTop: 0, contentOrigin: -2000, viewportHeight: 800, detailPreview: null });
    assert.equal(visibleImage(h).props.src, detail.image);
    assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 600, aspectRatio: "1200 / 800" });
    assert.equal(h.viewport.scrollTop, position, "unencoded content does not stretch or move the last preview");
    assert.ok(nodes(h.node("kiri-scroll-capture__dimensions")).includes(height));
  }
});

test("a delayed downward PNG still follows the new edge after status arrives first", async t => {
  const h = panel(t);
  await h.ready();
  const first = { image: "data:image/png;base64,first", revision: 1, left: 0, top: 0,
    width: 1180, height: 1280, displayScale: 2 };
  await h.update({ width: 1180, height: 1280, viewportTop: 0, viewportHeight: 1280, detailPreview: first });
  closeTo(h.viewport.scrollTop, (1280 * 200 / 1180 - 100) / 2);
  const oldPosition = h.viewport.scrollTop;
  await h.update({ width: 1180, height: 1684, viewportTop: 404, viewportHeight: 1280, revision: 2, detailPreview: first });
  assert.equal(h.viewport.scrollTop, oldPosition, "status alone must not scroll toward pixels that are not ready");
  const next = { ...first, image: "data:image/png;base64,next", revision: 2, top: 148, height: 1536 };
  await h.update({ width: 1180, height: 1684, viewportTop: 404, viewportHeight: 1280, revision: 2, detailPreview: next });
  closeTo(h.viewport.scrollTop, 1536 * 200 / 1180 - 100, "the old PNG must not consume the newest movement direction");
});

test("a delayed upward PNG follows the new top rather than the old image anchor", async t => {
  const h = panel(t);
  await h.ready();
  const first = { image: "data:image/png;base64,first", revision: 1, left: 0, top: 0,
    width: 1180, height: 1280, displayScale: 2 };
  await h.update({ width: 1180, height: 1280, viewportTop: 0, viewportHeight: 1280, detailPreview: first });
  await h.update({ width: 1180, height: 1684, contentOrigin: -404, viewportTop: 0, viewportHeight: 1280, revision: 2, detailPreview: first });
  const next = { ...first, image: "data:image/png;base64,next", revision: 2, top: -404, height: 1536 };
  await h.update({ width: 1180, height: 1684, contentOrigin: -404, viewportTop: 0, viewportHeight: 1280, revision: 2, detailPreview: next });
  assert.equal(h.viewport.scrollTop, 0);
});

test("leaving manual inspection restores following when the source frame has not changed", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,first", revision: 1, left: 0, top: 0,
    width: 1180, height: 1280, displayScale: 2 };
  await h.update({ width: 1180, height: 1280, viewportTop: 0, viewportHeight: 1280, detailPreview: detail });
  const automaticTop = h.viewport.scrollTop;
  assert.ok(automaticTop > 10);
  h.node("kiri-scroll-capture__preview").props.onWheel();
  h.viewport.scrollTop = 10;
  h.node("kiri-scroll-capture__preview").props.onPointerLeave();
  h.render();
  assert.equal(h.viewport.scrollTop, automaticTop);
});

test("same-revision revisits retain their direction across delayed crops and reversal", async t => {
  const h = panel(t);
  await h.ready();
  const first = { image: "data:image/png;base64,first", revision: 5, left: 0, top: 0,
    width: 1180, height: 1280, displayScale: 2 };
  const status = { width: 1180, height: 5000, viewportHeight: 1280, revision: 5 };
  await h.update({ ...status, viewportTop: 0, detailPreview: first });
  await h.update({ ...status, viewportTop: 404, detailPreview: first });
  const middle = { ...first, image: "data:image/png;base64,middle", top: 148, height: 1536 };
  await h.update({ ...status, viewportTop: 404, detailPreview: middle });
  closeTo(h.viewport.scrollTop, 1536 * 200 / 1180 - 100);
  await h.update({ ...status, viewportTop: 0, detailPreview: middle });
  await h.update({ ...status, viewportTop: 0, detailPreview: first });
  assert.equal(h.viewport.scrollTop, 0, "upward revisits work with an unchanged saved document revision");
});

test("narrow captures stay at their source display size instead of enlarging", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,narrow", revision: 1, left: 0, top: 0,
    width: 160, height: 800, displayScale: 2 };
  await h.update({ width: 160, height: 800, viewportTop: 0, viewportHeight: 800, detailPreview: detail });
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 80, aspectRatio: "160 / 800" });
  assert.equal(h.viewport.scrollTop, 150, "the image height stays 400 CSS pixels, not 1000");
  h.resize({ clientWidth: 300 });
  assert.equal(h.viewport.scrollTop, 150, "extra panel width must not enlarge the narrow capture");
});

test("resizing the preview preserves manual document position and recalculates following", async t => {
  const h = panel(t);
  await h.ready();
  const detail = { image: "data:image/png;base64,first", revision: 1, left: 0, top: 0,
    width: 1200, height: 1536, displayScale: 2 };
  await h.update({ width: 1200, height: 1536, viewportTop: 0, viewportHeight: 1536, detailPreview: detail });
  h.node("kiri-scroll-capture__preview").props.onWheel();
  h.viewport.scrollTop = 40;
  h.resize({ clientWidth: 300 });
  closeTo(h.viewport.scrollTop, 60, "manual inspection stays on the same image pixels");
  h.render();
  closeTo(h.viewport.scrollTop, 60, "repeated renders must not apply the width change twice");
  h.node("kiri-scroll-capture__preview").props.onBlur();
  h.render();
  closeTo(h.viewport.scrollTop, (1536 * 300 / 1200 - 100) / 2);
});

const previewFrame = (name, changes = {}) => ({
  image: `data:image/png;base64,${name}`, revision: 5, left: 0, top: 0,
  width: 1180, height: 1280, displayScale: 2, ...changes,
});
const previewStatus = (detailPreview, viewportTop = detailPreview.top) => ({
  width: detailPreview.width, height: 5000, viewportHeight: 1280,
  viewportTop, detailPreview, revision: detailPreview.revision,
});
async function showFirstPreview(h) {
  await h.ready();
  const first = previewFrame("first");
  await h.update(previewStatus(first));
  h.images.at(-1).resolve();
  await h.ready();
  return first;
}

test("loaded but undecoded PNGs keep the old pixels, geometry and position until one atomic switch", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  const oldPosition = h.viewport.scrollTop;
  const next = previewFrame("next", { top: 148, height: 1536, revision: 6 });
  await h.update(previewStatus(next, 404));
  const pending = h.images.at(-1);
  pending.load();
  await h.ready();
  assert.equal(visibleImage(h).props.src, first.image);
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 590, aspectRatio: "1180 / 1280" });
  assert.equal(h.viewport.scrollTop, oldPosition);
  assert.ok(!nodes(h.render()).includes("Preparing preview…"));
  assert.deepEqual(nodes(h.render()).filter(node => node?.type === "img").map(node => node.props.key), [0, 1]);
  pending.resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, next.image);
  assert.deepEqual(h.node("kiri-scroll-capture__image").props.style, { maxWidth: 590, aspectRatio: "1180 / 1536" });
  closeTo(h.viewport.scrollTop, 1536 * 200 / 1180 - 100);
});

test("fast downward then upward frames cannot publish an obsolete decode or consume the reversal", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  const down = previewFrame("down", { top: 148, height: 1536 });
  await h.update(previewStatus(down, 404));
  const oldDecode = h.images.at(-1);
  oldDecode.load();
  const up = previewFrame("up", { top: -404, height: 1536 });
  await h.update(previewStatus(up, -404));
  const latest = h.images.at(-1);
  latest.load();
  oldDecode.resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, first.image);
  latest.resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, up.image);
  assert.equal(h.viewport.scrollTop, 0);
  assert.equal(h.imageElements.size, 2, "only the same two image surfaces are used");
});

test("returning to the displayed frame cancels a pending decode without replacing its image", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  const activeSlot = visibleImage(h).props["data-preview-slot"];
  await h.update(previewStatus(previewFrame("down", { top: 148, height: 1536 }), 404));
  const obsolete = h.images.at(-1);
  obsolete.load();
  await h.update(previewStatus(first, 0));
  obsolete.resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, first.image);
  assert.equal(visibleImage(h).props["data-preview-slot"], activeSlot);
  const loaded = h.images.length;
  for (let revision = 6; revision < 10; revision++) {
    await h.update(previewStatus({ ...first, revision }));
    assert.equal(visibleImage(h).props["data-preview-slot"], activeSlot);
  }
  assert.equal(h.images.length, loaded, "identical pixels and crop do not decode again as revision/status changes");
});

test("hover inspection retains pixels while decoding and leaving resumes the latest direction without another poll", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  h.node("kiri-scroll-capture__preview").props.onPointerEnter();
  h.viewport.scrollTop = 10;
  const next = previewFrame("next", { top: 148, height: 1536 });
  await h.update(previewStatus(next, 404));
  h.images.at(-1).resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, first.image);
  assert.equal(h.viewport.scrollTop, 10);
  const requests = h.requests.length;
  h.node("kiri-scroll-capture__preview").props.onPointerLeave();
  h.render();
  assert.equal(visibleImage(h).props.src, next.image);
  closeTo(h.viewport.scrollTop, 1536 * 200 / 1180 - 100);
  assert.equal(h.requests.length, requests);
});

test("leaving inspection before decode completes holds the old frame until it is ready", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  h.node("kiri-scroll-capture__preview").props.onPointerEnter();
  h.viewport.scrollTop = 10;
  const next = previewFrame("next", { top: -404, height: 1536 });
  await h.update(previewStatus(next, -404));
  h.images.at(-1).load();
  h.node("kiri-scroll-capture__preview").props.onPointerLeave();
  h.render();
  assert.equal(visibleImage(h).props.src, first.image);
  assert.equal(h.viewport.scrollTop, 10);
  h.images.at(-1).resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, next.image);
  assert.equal(h.viewport.scrollTop, 0);
});

test("hover inspection keeps the latest reversal even when an intermediate image already decoded", async t => {
  const h = panel(t, { deferredImages: true });
  const first = await showFirstPreview(h);
  h.node("kiri-scroll-capture__preview").props.onPointerEnter();
  h.viewport.scrollTop = 10;
  await h.update(previewStatus(previewFrame("down", { top: 148, height: 1536 }), 404));
  h.images.at(-1).resolve();
  await h.ready();
  const up = previewFrame("up", { top: -404, height: 1536 });
  await h.update(previewStatus(up, -404));
  h.images.at(-1).resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, first.image);
  assert.equal(h.viewport.scrollTop, 10);
  h.node("kiri-scroll-capture__preview").props.onPointerLeave();
  h.render();
  assert.equal(visibleImage(h).props.src, up.image);
  assert.equal(h.viewport.scrollTop, 0);
});

test("load and decode failures retain the last good frame and the next valid image recovers", async t => {
  for (const failure of ["error", "reject"]) {
    const h = panel(t, { deferredImages: true });
    const first = await showFirstPreview(h);
    const oldPosition = h.viewport.scrollTop;
    const broken = previewFrame("broken", { top: 148, height: 1536 });
    await h.update(previewStatus(broken, 404));
    h.images.at(-1)[failure]();
    await h.ready();
    assert.equal(visibleImage(h).props.src, first.image);
    assert.equal(h.viewport.scrollTop, oldPosition);
    const count = h.images.length;
    await h.update(previewStatus({ ...broken }, 404));
    assert.equal(h.images.length, count, "polling the same broken image must not loop or clear the display");
    const next = previewFrame("recovered", { top: 328, height: 1536 });
    await h.update(previewStatus(next, 584));
    h.images.at(-1).resolve();
    await h.ready();
    assert.equal(visibleImage(h).props.src, next.image);
    closeTo(h.viewport.scrollTop, 1536 * 200 / 1180 - 100);
  }
});

test("a first image error keeps the placeholder and an old-session decode cannot fill a new session", async t => {
  const h = panel(t, { deferredImages: true });
  await h.ready();
  await h.update(previewStatus(previewFrame("broken")));
  h.images.at(-1).error();
  await h.ready();
  assert.equal(visibleImage(h), undefined);
  assert.ok(nodes(h.render()).includes("Preparing preview…"));
  await h.update(previewStatus(previewFrame("pending")));
  const oldDecode = h.images.at(-1);
  oldDecode.load();
  h.component.render({ sessionId: "scroll-2" });
  oldDecode.resolve();
  await h.ready();
  assert.equal(visibleImage(h), undefined);
  await h.update({ ...previewStatus(previewFrame("new-session")), sessionId: "scroll-2" });
  h.images.at(-1).resolve();
  await h.ready();
  assert.equal(visibleImage(h).props.src, previewFrame("new-session").image);
});


const dragEvent = (h, x, y, extra = {}) => ({
  pointerId: 1, button: 0, isPrimary: true, screenX: x, screenY: y,
  clientX: -999, clientY: -999, currentTarget: h.dragTarget,
  target: { closest: () => null }, preventDefault() {}, ...extra,
});
const movePoint = move => ({ sessionId: move.sessionId, x: move.x, y: move.y });
const titleBar = h => h.node("kiri-scroll-capture__header");

test("only the title or compact status drags, using screen deltas at the native scale", async t => {
  for (const compact of [false, true]) {
    const h = panel(t, { compact }); await h.ready();
    const surface = compact ? h.node("kiri-scroll-capture__status") : titleBar(h);
    assert.equal(h.node("kiri-scroll-capture__cancel").props.onPointerDown, undefined);
    assert.equal(h.node("kiri-primary-button kiri-scroll-capture__done").props.onPointerDown, undefined);
    if (!compact) {
      assert.equal(h.node("kiri-scroll-capture__status").props.onPointerDown, undefined);
      h.node("kiri-scroll-capture__preview").props.onPointerDown();
      assert.equal(h.nativeReads.length, 0, "preview inspection does not read a drag origin");
    }
    surface.props.onPointerDown(dragEvent(h, 100, 100));
    assert.ok(h.captured.has(1));
    assert.equal((compact ? h.node("kiri-scroll-capture__status") : titleBar(h)).props["data-dragging"], true);
    await h.ready();
    surface.props.onPointerMove(dragEvent(h, 150, 125));
    await h.ready();
    assert.deepEqual(movePoint(h.positions[0]), { sessionId: "scroll-1", x: -300, y: 150 });
    surface.props.onPointerUp(dragEvent(h, 160, 140));
    await h.ready();
    assert.deepEqual(movePoint(h.positions.at(-1)), { sessionId: "scroll-1", x: -280, y: 180 });
    assert.equal(h.captured.size, 0);
    assert.equal((compact ? h.node("kiri-scroll-capture__status") : titleBar(h)).props["data-dragging"], undefined);
  }
});

test("a short released drag waits for both origin and scale and survives normal lostcapture", async t => {
  const origin = deferred(), scale = deferred();
  const h = panel(t, { outerPosition: () => origin.promise, scaleFactor: () => scale.promise });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100));
  bar.props.onPointerUp(dragEvent(h, 160, 150));
  bar.props.onLostPointerCapture(dragEvent(h, 160, 150));
  await h.ready(); assert.equal(h.positions.length, 0);
  origin.resolve({ x: 100, y: 200 }); await h.ready();
  assert.equal(h.positions.length, 0, "scale may arrive after the origin and pointerup");
  scale.resolve(1.5); await h.ready();
  assert.deepEqual(movePoint(h.positions[0]), { sessionId: "scroll-1", x: 190, y: 275 });
});

test("native drag writes are single-flight and coalesce to the final pointerup", async t => {
  const h = panel(t, { deferredMoves: true }); await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 125, 125)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 150, 150));
  bar.props.onPointerMove(dragEvent(h, 175, 175));
  bar.props.onPointerUp(dragEvent(h, 200, 180)); await h.ready();
  assert.equal(h.positions.length, 1);
  h.positions[0].resolve(); await h.ready();
  assert.equal(h.positions.length, 2);
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -200, y: 260 });
  h.positions[1].resolve(); await h.ready();
  assert.equal(h.positions.length, 2);
});

test("a new gesture discards a superseded pending origin", async t => {
  const origin = deferred(); let reads = 0;
  const h = panel(t, { outerPosition: () => ++reads === 1 ? origin.promise : Promise.resolve({ x: 10, y: 20 }) });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 200, 200));
  bar.props.onPointerDown(dragEvent(h, 300, 300, { pointerId: 2 }));
  bar.props.onPointerUp(dragEvent(h, 330, 320, { pointerId: 2 }));
  origin.resolve({ x: -400, y: 100 }); await h.ready(); await h.ready();
  assert.equal(h.positions.length, 1);
  assert.deepEqual(movePoint(h.positions[0]), { sessionId: "scroll-1", x: 70, y: 60 });
});

test("a superseding gesture reads its origin after the prior native move settles", async t => {
  const h = panel(t, { deferredMoves: true }); await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 125, 125)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 250, 250));
  bar.props.onPointerDown(dragEvent(h, 300, 300, { pointerId: 2 }));
  bar.props.onPointerUp(dragEvent(h, 330, 320, { pointerId: 2 })); await h.ready();
  assert.equal(h.nativeReads.length, 2, "new origin cannot race the in-flight native placement");
  h.positions[0].resolve(); await h.ready(); await h.ready();
  assert.equal(h.positions.length, 2, "the old pending pointer point is discarded");
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -290, y: 190 });
  h.positions[1].resolve();
});

for (const end of ["onPointerCancel", "onLostPointerCapture"]) {
  test(`${end} cancels pending reads and queued writes without accepting another pointer`, async t => {
    const origin = deferred();
    const h = panel(t, { outerPosition: () => origin.promise }); await h.ready(); const bar = titleBar(h);
    bar.props.onPointerDown(dragEvent(h, 100, 100));
    bar.props.onPointerMove(dragEvent(h, 150, 150, { pointerId: 2 }));
    bar.props[end](dragEvent(h, 150, 150, { pointerId: 2 }));
    assert.ok(h.captured.has(1));
    bar.props.onPointerMove(dragEvent(h, 200, 200));
    bar.props[end](dragEvent(h, 200, 200));
    origin.resolve({ x: 0, y: 0 }); await h.ready();
    assert.equal(h.positions.length, 0);
    assert.equal(h.captured.size, 0);
    const live = panel(t, { deferredMoves: true }); await live.ready(); const liveBar = titleBar(live);
    liveBar.props.onPointerDown(dragEvent(live, 0, 0)); await live.ready();
    liveBar.props.onPointerMove(dragEvent(live, 10, 10)); await live.ready();
    liveBar.props.onPointerMove(dragEvent(live, 50, 50));
    liveBar.props[end](dragEvent(live, 50, 50));
    live.positions[0].resolve(); await live.ready();
    assert.equal(live.positions.length, 1);
  });
}

test("unmount cancels queued dragging and disposes a late scale listener", async t => {
  const subscription = deferred();
  const h = panel(t, { deferredMoves: true, scaleSubscription: subscription.promise });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 10, 10)); await h.ready();
  bar.props.onPointerUp(dragEvent(h, 50, 50));
  h.component.unmount(); h.positions[0].resolve(); subscription.resolve(); await settleRequests();
  assert.equal(h.positions.length, 1);
  assert.equal(h.captured.size, 0);
  assert.equal(h.scaleDisposals(), 1);
});

test("changing display scale discards old-scale movement and the next gesture uses the new scale", async t => {
  const h = panel(t, { deferredMoves: true }); await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 125, 125)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 200, 200));
  h.scale(1); h.positions[0].resolve(); await h.ready();
  assert.equal(h.positions.length, 1);
  assert.equal(h.captured.size, 0);
  bar.props.onPointerDown(dragEvent(h, 300, 300));
  bar.props.onPointerUp(dragEvent(h, 320, 330)); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -330, y: 180 });
  h.positions[1].resolve();
});

test("failed native reads or moves release dragging and do not poison the next gesture", async t => {
  let originReads = 0;
  const h = panel(t, { deferredMoves: true,
    outerPosition: () => ++originReads === 1 ? Promise.reject(new Error("unavailable")) : Promise.resolve({ x: 0, y: 0 }) });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); bar.props.onPointerUp(dragEvent(h, 10, 10));
  await h.ready(); assert.equal(h.positions.length, 0); assert.equal(h.captured.size, 0);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 10, 10)); await h.ready();
  h.positions[0].reject(new Error("closed")); await h.ready();
  assert.equal(h.captured.size, 0);
  bar.props.onPointerDown(dragEvent(h, 20, 20)); bar.props.onPointerUp(dragEvent(h, 40, 50));
  await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: 40, y: 60 });
  h.positions[1].resolve();
});

test("secondary presses, buttons and clicks do not reposition the panel", async t => {
  const h = panel(t); await h.ready(); const bar = titleBar(h);
  for (const extra of [{ button: 2 }, { isPrimary: false }, { target: { closest: () => ({}) } }]) {
    bar.props.onPointerDown(dragEvent(h, 0, 0, extra));
    bar.props.onPointerMove(dragEvent(h, 50, 50));
    bar.props.onPointerUp(dragEvent(h, 50, 50));
  }
  await h.ready(); assert.equal(h.nativeReads.length, 0);
  bar.props.onPointerDown(dragEvent(h, 100, 100));
  bar.props.onPointerUp(dragEvent(h, 101, 101)); await h.ready();
  assert.equal(h.positions.length, 0);
  assert.equal(h.captured.size, 0);
});


test("successive short drags start at the accepted clamped position while native position reads lag", async t => {
  const h = panel(t, { deferredMoves: true, nativePositionLags: true });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 100, 100));
  bar.props.onPointerUp(dragEvent(h, 200, 200)); await h.ready();
  h.positions[0].resolve({ x: -250, y: 250 }); await h.ready();
  bar.props.onPointerDown(dragEvent(h, 300, 300));
  bar.props.onPointerUp(dragEvent(h, 325, 310)); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -200, y: 270 },
    "use the backend-clamped point, neither the requested point nor the stale OS position");
  h.positions[1].resolve({ x: -200, y: 270 }); await h.ready();
  bar.props.onPointerDown(dragEvent(h, 400, 400));
  bar.props.onPointerUp(dragEvent(h, 410, 425)); await h.ready();
  assert.deepEqual(movePoint(h.positions[2]), { sessionId: "scroll-1", x: -180, y: 320 });
  h.positions[2].resolve();
});

test("a cancelled in-flight move still supplies its committed origin to the next gesture", async t => {
  const h = panel(t, { deferredMoves: true, nativePositionLags: true });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerCancel(dragEvent(h, 100, 100));
  bar.props.onPointerDown(dragEvent(h, 200, 200));
  bar.props.onPointerUp(dragEvent(h, 210, 220));
  h.positions[0].resolve({ x: -250, y: 250 }); await h.ready(); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -230, y: 290 });
  h.positions[1].resolve();
});

test("a superseded in-flight move still supplies its accepted origin despite stale native reads", async t => {
  const h = panel(t, { deferredMoves: true, nativePositionLags: true });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 100, 100)); await h.ready();
  bar.props.onPointerDown(dragEvent(h, 200, 200, { pointerId: 2 }));
  bar.props.onPointerUp(dragEvent(h, 210, 220, { pointerId: 2 }));
  h.positions[0].resolve({ x: -250, y: 250 }); await h.ready(); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -230, y: 290 });
  h.positions[1].resolve();
});

test("a display scale change invalidates committed positions including late old-scale writes", async t => {
  const h = panel(t, { deferredMoves: true, nativePositionLags: true });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 100, 100)); await h.ready();
  h.scale(1);
  h.positions[0].resolve({ x: -200, y: 300 }); await h.ready();
  bar.props.onPointerDown(dragEvent(h, 200, 200));
  bar.props.onPointerUp(dragEvent(h, 210, 220)); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-1", x: -390, y: 120 },
    "a scale change forces a fresh native origin rather than restoring the old pending commit");
  h.positions[1].resolve({ x: -390, y: 120 }); await h.ready();
  h.scale(2);
  bar.props.onPointerDown(dragEvent(h, 300, 300));
  bar.props.onPointerUp(dragEvent(h, 310, 320)); await h.ready();
  assert.deepEqual(movePoint(h.positions[2]), { sessionId: "scroll-1", x: -380, y: 140 });
  h.positions[2].resolve();
});

test("changing sessions isolates a late committed point from the next session", async t => {
  const h = panel(t, { deferredMoves: true, nativePositionLags: true });
  await h.ready(); const bar = titleBar(h);
  bar.props.onPointerDown(dragEvent(h, 0, 0)); await h.ready();
  bar.props.onPointerMove(dragEvent(h, 100, 100)); await h.ready();
  h.component.render({ sessionId: "scroll-2", compact: false });
  const next = titleBar(h);
  next.props.onPointerDown(dragEvent(h, 200, 200));
  next.props.onPointerUp(dragEvent(h, 210, 220));
  h.positions[0].resolve({ x: -200, y: 300 }); await h.ready(); await h.ready();
  assert.deepEqual(movePoint(h.positions[1]), { sessionId: "scroll-2", x: -380, y: 140 });
  h.positions[1].resolve();
});
