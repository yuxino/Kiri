import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { AnnotationInteractionLock } from "../src/annotation/interaction-lock.js";
import { capturePanelLayout, captureToolbarPosition } from "../src/windows/toolbar-layout.js";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/PinWindow.tsx", import.meta.url), "utf8");

function pinWindow() {
  const requests = [];
  const sizes = [];
  let drags = 0, closes = 0;
  let pinned, reads = 0;
  const window = {
    // The Linux window manager can still be applying the builder's true state.
    isAlwaysOnTop: async () => { reads += 1; return false; },
    setAlwaysOnTop(value) { const result = deferred(); requests.push({value, ...result}); return result.promise; },
    startDragging: async () => { drags += 1; },
    close: async () => { closes += 1; },
    innerSize: async () => ({ width: 400, height: 200 }),
    scaleFactor: async () => 2,
    setSize(value) { const result = deferred(); sizes.push({ value, ...result }); return result.promise; },
  };
  const h = createLibraryHarness({}, source, {modules: {
    "@tauri-apps/api/window": {getCurrentWindow: () => window},
    "@tauri-apps/api/dpi": {PhysicalSize: class { constructor(width, height) { this.width = width; this.height = height; } }},
    "../lib/ipc": {mediaUrl: () => "image:test", onAssetContentChanged: async () => () => {},
      onPinOnTop: async callback => { pinned = callback; return () => { pinned = null; }; }},
    "./pin-window.css": {},
  }});
  const component = h.mount("PinWindow", {id: "test-image"});
  component.render();
  return {component, requests, sizes, drags: () => drags, closes: () => closes,
    keyboard: event => h.window.dispatchEvent({ type: "keydown", ...event }),
    reads: () => reads, pinned: () => pinned()};
}

const pinButton = component => nodes(component.render()).find(node => node?.type === "button");
const pinLabel = component => pinButton(component).props["aria-label"];

test("a fresh pin keeps its builder state despite a transient false native snapshot", async () => {
  const h = pinWindow();
  await settleRequests();
  assert.equal(pinLabel(h.component), "Unpin");
  assert.equal(h.reads(), 0);
  pinButton(h.component).props.onClick();
  assert.equal(h.requests[0].value, false, "the first click must actually unpin");
  h.requests[0].resolve();
  await settleRequests();
  assert.equal(pinLabel(h.component), "Pin on Top");
});

test("a reused pin event restores the button and the next click unpins", async () => {
  const h = pinWindow();
  await settleRequests();
  pinButton(h.component).props.onClick();
  h.requests[0].resolve();
  await settleRequests();
  assert.equal(pinLabel(h.component), "Pin on Top");
  h.pinned();
  assert.equal(pinLabel(h.component), "Unpin");
  pinButton(h.component).props.onClick();
  assert.equal(h.requests[1].value, false);
});

test("a library repin wins over the completion of an older pending unpin", async () => {
  const h = pinWindow();
  await settleRequests();
  pinButton(h.component).props.onClick();
  h.pinned();
  h.requests[0].resolve();
  await settleRequests();
  assert.equal(pinLabel(h.component), "Unpin");
  pinButton(h.component).props.onClick();
  assert.equal(h.requests[1].value, false);
});

test("failed native changes keep the pin state and rapid repeated clicks make one request", async () => {
  const h = pinWindow();
  await settleRequests();
  const click = pinButton(h.component).props.onClick;
  click(); click();
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error("unavailable"));
  await settleRequests();
  assert.equal(pinLabel(h.component), "Unpin");
  assert.ok(nodes(h.component.render()).some(node => node?.props?.role === "alert"));
});


test("a stale rejected toggle does not show an error after a successful library repin", async () => {
  const h = pinWindow();
  await settleRequests();
  pinButton(h.component).props.onClick();
  h.pinned();
  h.requests[0].reject(new Error("superseded"));
  await settleRequests();
  assert.equal(pinLabel(h.component), "Unpin");
  assert.ok(!nodes(h.component.render()).some(node => node?.props?.role === "alert"));
});

test("borderless references drag only from the image and retain accessible close controls", async () => {
  const h = pinWindow();
  const tree = nodes(h.component.render());
  const image = tree.find(node => node?.type === "main");
  image.props.onPointerDown({ button: 2 });
  assert.equal(h.drags(), 0);
  image.props.onPointerDown({ button: 0 });
  assert.equal(h.drags(), 1);
  let stopped = 0;
  tree.find(node => node?.props?.className === "pin-window__actions").props.onPointerDown({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 1, "the action buttons must not start dragging");
  assert.equal(tree.find(node => node?.type === "img").props.draggable, false);
  tree.find(node => node?.props?.["aria-label"] === "Close").props.onClick();
  assert.equal(h.closes(), 1);
  h.keyboard({ key: "Escape", preventDefault() {} });
  assert.equal(h.closes(), 2);
});

test("borderless corner resize preserves aspect and coalesces pending Retina updates", async () => {
  const h = pinWindow();
  const grip = nodes(h.component.render()).find(node => node?.props?.className === "pin-window__resize");
  grip.props.onPointerDown({ button: 0, pointerId: 1, screenX: 100, screenY: 100,
    stopPropagation() {}, currentTarget: { setPointerCapture() {} } });
  grip.props.onPointerMove({ pointerId: 1, screenX: 150, screenY: 125 });
  await settleRequests();
  assert.deepEqual({ ...h.sizes[0].value }, { width: 500, height: 250 });
  grip.props.onPointerMove({ pointerId: 1, screenX: 175, screenY: 135 });
  grip.props.onPointerUp({ pointerId: 1, screenX: 200, screenY: 150 });
  assert.equal(h.sizes.length, 1, "window resize requests stay serial");
  h.sizes[0].resolve();
  await settleRequests();
  assert.equal(h.sizes.length, 2);
  assert.deepEqual({ ...h.sizes[1].value }, { width: 600, height: 300 });
  h.sizes[1].resolve();
  await settleRequests();
});

const overlaySource = readFileSync(new URL("../src/windows/OverlayWindow.tsx", import.meta.url), "utf8");

function captureCompletion() {
  const tree = ts.createSourceFile("overlay.tsx", overlaySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const walk = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "complete") {
      callback = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  assert.ok(callback);
  const output = ts.transpileModule(`const complete = ${callback};`, {}).outputText;
  const exported = deferred(), confirmed = deferred(), calls = [];
  const result = { png: new Uint8Array([1, 2, 3]), document: { marks: [{ kind: "text" }] } };
  const selection = { x: 10, y: 20, width: 100, height: 80 };
  const context = {
    completionLock: new AnnotationInteractionLock(), modeSelectorDragRef: { current: null },
    setModeSelectorDragging: () => {}, setCompleting: () => {}, selection,
    canvasRef: { current: { exportResult: () => { calls.push("export"); return exported.promise; } } },
    api: { confirmCapture: (...args) => { calls.push(args); return confirmed.promise; } },
    getCurrentWindow: () => ({ close: async () => { calls.push("close"); } }),
    reportFrontend: message => calls.push(message),
  };
  const complete = new Function(...Object.keys(context), `${output}; return complete;`)(...Object.values(context));
  return { complete, exported, confirmed, calls, result, selection, lock: context.completionLock };
}

test("direct pin exports annotations once and waits for confirmation before closing", async () => {
  const h = captureCompletion();
  const pending = h.complete(true);
  await h.complete();
  assert.deepEqual(h.calls, ["export"], "Done cannot race a pending pin export");
  h.exported.resolve(h.result);
  await settleRequests();
  assert.deepEqual(h.calls[1], [h.result.png, { selection: h.selection, document: h.result.document }, true]);
  await h.complete(true);
  assert.equal(h.calls.length, 2, "a second pin cannot race native confirmation");
  assert.equal(h.lock.locked, true);
  h.confirmed.resolve();
  await pending;
  assert.equal(h.calls[2], "close");
  assert.equal(h.lock.locked, false);
});

test("failed pin confirmation keeps the overlay open and releases completion for retry", async () => {
  const h = captureCompletion();
  const pending = h.complete(true);
  h.exported.resolve(h.result);
  await settleRequests();
  h.confirmed.reject(new Error("save failed"));
  await pending;
  assert.ok(!h.calls.includes("close"));
  assert.equal(h.lock.locked, false);
  assert.match(h.calls.at(-1), /save failed/);
});

test("normal completion retains its non-pinning action", async () => {
  const h = captureCompletion();
  const pending = h.complete();
  h.exported.resolve(h.result);
  h.confirmed.resolve();
  await pending;
  assert.equal(h.calls[1][2], false);
  assert.equal(h.calls[2], "close");
});

test("the toolbar exposes direct pin, disables it while completing, and isolates keyboard activation", () => {
  const toolbar = overlaySource.slice(overlaySource.indexOf("const TOOLS:"));
  const harness = createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
    import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}; ${toolbar}; export {ToolButton};`);
  let pins = 0, saves = 0;
  const props = { selection:{x:100,y:100,width:140,height:160}, bounds:{x:0,y:0,width:800,height:600},
    tool:"select", appearance:{}, canSetSize:true, disabled:false,
    onPin:()=>pins++, onDone:()=>saves++ };
  const component = harness.mount("Toolbar", props);
  const pin = nodes(component.render()).find(node => node?.props?.icon === "pin");
  assert.ok(pin);
  pin.props.onClick();
  assert.equal(pins, 1);
  assert.equal(saves, 0);
  const button = harness.mount("ToolButton", pin.props).render();
  let stopped = 0;
  button.props.onKeyDown({ key:"Enter", stopPropagation:()=>stopped++ });
  assert.equal(stopped, 1, "Enter on Pin must not bubble into normal screenshot completion");
  const busy = nodes(component.render({ ...props, disabled:true }));
  assert.equal(busy.find(node => node?.props?.icon === "pin").props.disabled, true);
  assert.equal(busy.find(node => node?.props?.icon === "checkmark").props.disabled, true);
  component.unmount();
});
