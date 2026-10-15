import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";
import { isTextComposition } from "../src/annotation/text-composition.js";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ScrollCaptureWindow.tsx", import.meta.url), "utf8");
const sessionId = "dca5a811-1dd4-4ecb-bf63-82bb44bdf482";
const captured = { sessionId, phase: "capturing", width: 900, height: 1800, frames: 3,
  revision: 3, message: null, preview: "data:image/png;base64,AAAA" };

function panel(overrides = {}, options = {}) {
  const reads = [], finishes = [], cancellations = [], timers = new Map();
  let timerId = 0, closed = 0;
  const api = {
    scrollCaptureStatus(id) {
      assert.equal(id, sessionId);
      const request = deferred();
      reads.push(request);
      return request.promise;
    },
    async finishScrollCapture(...args) { finishes.push(args); },
    async cancelScrollCapture(...args) { cancellations.push(args); },
    ...overrides,
  };
  const harness = createLibraryHarness({}, source, {
    search: `?window=scroll-capture&sessionId=${sessionId}`,
    strictEffects: options.strictEffects,
    globals: {
      Element: class {},
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    modules: {
      "../lib/ipc": { api },
      "@tauri-apps/api/window": { getCurrentWindow: () => ({ close: async () => { closed++; } }) },
      "../annotation/text-composition.js": { isTextComposition },
      "./scroll-capture.css": {},
      "lucide-react": { Check: "check", ScrollText: "scroll", X: "x" },
    },
  });
  const component = harness.mount("ScrollCaptureWindow", {});
  let tree = component.render();
  const render = () => tree = component.render();
  return { reads, finishes, cancellations, timers, component, render,
    get closed() { return closed; },
    button(label) { return nodes(render()).find(node => node?.type === "button" && nodes(node).includes(label)); },
    key(key) {
      let prevented = false;
      harness.window.dispatchEvent({ type: "keydown", key, preventDefault() { prevented = true; } });
      return prevented;
    },
    async resolve(status = captured, index = reads.length - 1) { reads[index].resolve(status); await settleRequests(); render(); },
    tick() {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    },
  };
}

test("scroll preview polling is serial, session-bound and cleaned up on unmount", async () => {
  const p = panel();
  assert.equal(p.reads.length, 1);
  p.tick();
  assert.equal(p.reads.length, 1, "there is no timer while the first read is pending");
  await p.resolve();
  assert.equal(p.timers.size, 1);
  assert.ok(nodes(p.render()).some(node => node?.type === "img" && node.props.src === captured.preview));
  p.tick();
  assert.equal(p.reads.length, 2);
  await p.resolve({ ...captured, sessionId: "stale-session", height: 9999 });
  assert.ok(nodes(p.render()).includes("Could not update the preview."));
  assert.equal(p.timers.size, 0, "a failing read waits for an explicit retry");
  p.button("Retry").props.onClick(); p.render();
  assert.equal(p.reads.length, 3);
  await p.resolve();
  p.component.unmount();
  assert.equal(p.timers.size, 0);
});

test("unverified final content requires an explicit save-partial action", async () => {
  const p = panel();
  await p.resolve({ ...captured, phase: "needsOverlap" });
  p.button("Done").props.onClick();
  assert.equal(p.finishes.length, 0);
  assert.ok(nodes(p.render()).includes("The last section could not be joined. Save only the captured portion?"));
  p.key("Enter");
  assert.equal(p.finishes.length, 0, "Return never silently accepts truncation");
  p.button("Continue adjusting").props.onClick();
  assert.equal(p.finishes.length, 0);
  assert.equal(p.button("Save captured portion"), undefined);
  p.button("Done").props.onClick();
  p.button("Save captured portion").props.onClick();
  await settleRequests();
  assert.deepEqual(p.finishes, [[sessionId, true]]);
  assert.equal(p.closed, 1);
  p.component.unmount();
});

test("a pending preview cannot replace state after Cancel and duplicate actions are blocked", async () => {
  const cancellation = deferred();
  let calls = 0;
  const p = panel({ cancelScrollCapture(id) { assert.equal(id, sessionId); calls++; return cancellation.promise; } });
  assert.equal(p.key("Escape"), true);
  p.key("Escape");
  assert.equal(calls, 1);
  await p.resolve();
  assert.equal(nodes(p.render()).some(node => node?.type === "img"), false);
  assert.equal(p.closed, 0);
  cancellation.resolve();
  await settleRequests();
  assert.equal(p.closed, 1);
  p.component.unmount();
});

test("Finish waits for native save and errors keep the accepted preview available for retry", async () => {
  const save = deferred();
  let calls = 0;
  const p = panel({ finishScrollCapture(id, partial) {
    assert.equal(id, sessionId); assert.equal(partial, false); calls++; return save.promise;
  } });
  await p.resolve();
  p.key("Enter"); p.key("Enter");
  assert.equal(calls, 1);
  assert.equal(p.closed, 0);
  assert.equal(p.button("Done").props.disabled, true);
  save.reject(new Error("native save failed"));
  await settleRequests();
  assert.ok(nodes(p.render()).includes("Could not finish scrolling capture. Adjust the scroll position and try again."));
  assert.ok(nodes(p.render()).some(node => node?.type === "img"));
  assert.equal(p.button("Done").props.disabled, false);
  assert.equal(p.closed, 0);
  p.component.unmount();
});

test("failed captures with accepted pixels retain the explicit partial-save choice", async () => {
  const p = panel();
  await p.resolve({ ...captured, phase: "failed", message: "The screenshot reached its size limit." });
  assert.ok(nodes(p.render()).includes("The screenshot reached its size limit."));
  p.button("Done").props.onClick();
  assert.ok(p.button("Save captured portion"));
  assert.equal(p.finishes.length, 0);
  p.component.unmount();
});

test("a failed library save retries the complete cached screenshot without a partial-save prompt", async () => {
  const p = panel();
  await p.resolve({ ...captured, phase: "failed", message: "Could not save the screenshot. Try again." });
  assert.ok(nodes(p.render()).includes("Could not save the screenshot. Try again."));
  p.button("Done").props.onClick();
  await settleRequests();
  assert.equal(p.button("Save captured portion"), undefined);
  assert.deepEqual(p.finishes, [[sessionId, false]]);
  assert.equal(p.closed, 1);
  p.component.unmount();
});

test("a failed save of an explicitly accepted portion clears the old partial-confirmation state", async () => {
  const finishes = [];
  const p = panel({ async finishScrollCapture(...args) {
    finishes.push(args);
    if (finishes.length === 1) throw new Error("library unavailable");
  } });
  await p.resolve({ ...captured, phase: "needsOverlap" });
  p.button("Done").props.onClick();
  p.button("Save captured portion").props.onClick();
  await settleRequests();
  assert.equal(p.closed, 0);
  p.tick();
  await p.resolve({ ...captured, phase: "failed", message: "Could not save the screenshot. Try again." });
  assert.equal(p.button("Save captured portion"), undefined);
  assert.equal(nodes(p.render()).includes("Could not finish scrolling capture. Adjust the scroll position and try again."), false);
  assert.equal(p.button("Done").props.disabled, false);
  p.button("Done").props.onClick();
  await settleRequests();
  assert.deepEqual(finishes, [[sessionId, true], [sessionId, false]]);
  assert.equal(p.closed, 1);
  p.component.unmount();
});
