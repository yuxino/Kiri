import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { AnnotationInteractionLock } from "../src/annotation/interaction-lock.js";
import { capturePanelLayout, captureToolOptionsLayout, captureToolbarPosition } from "../src/windows/toolbar-layout.js";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/PinWindow.tsx", import.meta.url), "utf8");

function pinWindow(options = {}) {
  const requests = [];
  const sizes = [];
  const positions = [];
  let drags = 0, closes = 0;
  let pinned, changed, reads = 0;
  let resize, focused = null, rootTree, menuTree;
  const containerListeners = new Map(), densityListeners = new Set(), buttonElements = new Map();
  class PinElement {
    constructor(tag = "div") { this.tag = tag; this.props = {}; }
    closest(selector) { return selector.split(",").some(value => value.trim() === this.tag) ? this : null; }
    contains(target) { return target === this || (this === menu && [...buttonElements.values()].some(button => button.props.role === "menuitemradio" && button === target)); }
    focus() { focused = this; }
    getAttribute(name) { return this.props[name] == null ? null : String(this.props[name]); }
    getClientRects() { return this.props.className?.includes("pin-window__zoom-step") && (container.clientWidth <= 180 || container.clientHeight <= 100) ? [] : [{}]; }
  }
  const root = new PinElement(), menu = new PinElement(), viewButton = new PinElement("button");
  const container = Object.assign(new PinElement(), {
    clientWidth: options.containerWidth ?? 400, clientHeight: options.containerHeight ?? 200,
    rectWidth: options.containerWidth ?? 400, rectHeight: options.containerHeight ?? 200,
    clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
    addEventListener(name, callback) { containerListeners.set(name, callback); },
    removeEventListener(name, callback) { if (containerListeners.get(name) === callback) containerListeners.delete(name); },
    getBoundingClientRect() { return {left: 0, top: 0, width: this.rectWidth, height: this.rectHeight}; },
    setPointerCapture() {},
  });
  const buttonElement = node => {
    if (node.props.className?.includes("pin-window__zoom-value")) { viewButton.props = node.props; return viewButton; }
    const key = node.props.role === "menuitemradio" ? nodes(node).find(value => typeof value === "string")
      : ["Pin on Top", "Unpin"].includes(node.props["aria-label"]) ? "pin-toggle" : node.props["aria-label"];
    if (!buttonElements.has(key)) buttonElements.set(key, new PinElement("button"));
    const element = buttonElements.get(key); element.props = node.props;
    return element;
  };
  root.querySelectorAll = () => nodes(rootTree).filter(node => node?.type === "button" && node.props.role !== "menuitemradio" && !node.props.disabled).map(buttonElement);
  menu.querySelectorAll = () => nodes(menuTree).filter(node => node?.props?.role === "menuitemradio").map(buttonElement);
  const window = {
    // The Linux window manager can still be applying the builder's true state.
    isAlwaysOnTop: async () => { reads += 1; return false; },
    setAlwaysOnTop(value) { const result = deferred(); requests.push({value, ...result}); return result.promise; },
    startDragging: async () => { drags += 1; },
    close: async () => { closes += 1; },
    innerSize: options.innerSize ?? (async () => ({ width: 400, height: 200 })),
    scaleFactor: options.scaleFactor ?? (async () => options.scale ?? 2),
    outerPosition: options.outerPosition ?? (async () => ({ x: -400, y: 100 })),
    setSize(value) { const result = deferred(); sizes.push({ value, ...result }); return result.promise; },
    setPosition(value) { const result = deferred(); positions.push({ value, ...result }); return result.promise; },
  };
  const h = createLibraryHarness({}, source, {navigator: { userAgent: options.userAgent ?? "Windows" }, modules: {
    "@tauri-apps/api/window": {getCurrentWindow: () => window},
    "@tauri-apps/api/dpi": {PhysicalSize: class { constructor(width, height) { this.width = width; this.height = height; } },
      PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } }},
    "../lib/ipc": {mediaUrl: () => "image:test", onAssetContentChanged: async callback => { changed = callback; return () => { changed = null; }; },
      onPinOnTop: async callback => { pinned = callback; return () => { pinned = null; }; }},
    "./pin-window.css": {},
    "lucide-react": {Minus: "icon", Plus: "icon"},
  }, globals: {
    Element: PinElement,
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
  }, attachRef(node) {
    if (!node.props?.ref) return;
    if (node.props.className === "pin-window") { rootTree = node; node.props.ref.current = root; }
    if (node.props.className === "pin-window__menu") { menuTree = node; node.props.ref.current = menu; }
    if (node.props.className?.includes("pin-window__zoom-value")) { viewButton.props = node.props; node.props.ref.current = viewButton; }
    if (node.props.className === "pin-window__viewport") node.props.ref.current = container;
  }});
  h.window.devicePixelRatio = options.contentScale ?? 2;
  h.window.matchMedia = () => ({
    addEventListener: (name, callback) => densityListeners.add(callback),
    removeEventListener: (name, callback) => densityListeners.delete(callback),
  });
  const component = h.mount("PinWindow", {id: "test-image"});
  component.render();
  return {component, requests, sizes, positions, drags: () => drags, closes: () => closes,
    keyboard: extra => { const event = {type: "keydown", defaultPrevented: false, repeat: false, target: null,
      preventDefault() { this.defaultPrevented = true; }, ...extra}; h.window.dispatchEvent(event); return event; },
    reads: () => reads, pinned: () => pinned(), changed: id => changed(id),
    window: h.window, container, root, menu, viewButton, element: tag => new PinElement(tag), focused: () => focused,
    resize(width, height) { container.clientWidth = container.rectWidth = width; container.clientHeight = container.rectHeight = height; resize(); component.render(); },
    density(dpr) { h.window.devicePixelRatio = dpr; [...densityListeners].forEach(callback => callback()); component.render(); },
    wheel(deltaY, extra = {}) { const event = {deltaY, deltaMode: 0, clientX: container.clientWidth / 2, clientY: container.clientHeight / 2,
      defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...extra}; containerListeners.get("wheel")(event); component.render(); return event; },
    pinch(type, scale) { const event = {type, scale, clientX: container.clientWidth / 2, clientY: container.clientHeight / 2,
      defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}}; containerListeners.get(type)(event); component.render(); return event; },
  };
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
  const h = pinWindow({ userAgent: "Linux" });
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

const moveEvent = (x, y, pointerId = 1) => ({ button: 0, pointerId, screenX: x, screenY: y,
  preventDefault() {}, currentTarget: { setPointerCapture() {} } });
const imageSurface = h => nodes(h.component.render()).find(node => node?.type === "main");

for (const userAgent of ["Macintosh", "Windows"]) {
test(`${userAgent} image dragging uses physical positions and coalesces movement`, async () => {
  const h = pinWindow({ userAgent });
  const image = imageSurface(h);
  image.props.onPointerDown(moveEvent(100, 100));
  image.props.onPointerMove(moveEvent(150, 125));
  await settleRequests();
  assert.equal(h.drags(), 0, "dragging must not depend on an asynchronous native mouse-down event");
  assert.deepEqual({ ...h.positions[0].value }, { x: -300, y: 150 });
  image.props.onPointerMove(moveEvent(170, 135));
  image.props.onPointerUp(moveEvent(200, 150));
  assert.equal(h.positions.length, 1, "native moves stay serial");
  h.positions[0].resolve();
  await settleRequests();
  assert.deepEqual({ ...h.positions[1].value }, { x: -200, y: 200 });
  h.positions[1].resolve();
  await settleRequests();
  image.props.onPointerMove(moveEvent(400, 400));
  assert.equal(h.positions.length, 2, "released pointers cannot move the window");
});

test(`a short ${userAgent} drag retains its last position while the native origin is loading`, async () => {
  const origin = deferred();
  const h = pinWindow({ userAgent, outerPosition: () => origin.promise });
  const image = imageSurface(h);
  image.props.onPointerDown(moveEvent(30, 40));
  image.props.onPointerMove(moveEvent(45, 50, 2));
  image.props.onPointerUp(moveEvent(60, 80));
  assert.equal(h.positions.length, 0);
  origin.resolve({ x: 20, y: 30 });
  await settleRequests();
  assert.deepEqual({ ...h.positions[0].value }, { x: 80, y: 110 });
  h.positions[0].resolve();
});

test(`cancelled and unmounted ${userAgent} drags cannot apply a late origin or pending movement`, async () => {
  for (const end of ["cancel", "unmount"]) {
    const origin = deferred();
    const h = pinWindow({ userAgent, outerPosition: () => origin.promise });
    const image = imageSurface(h);
    image.props.onPointerDown(moveEvent(100, 100));
    image.props.onPointerMove(moveEvent(200, 200));
    if (end === "cancel") image.props.onPointerCancel();
    else h.component.unmount();
    origin.resolve({ x: 20, y: 30 });
    await settleRequests();
    assert.equal(h.positions.length, 0, end);
  }
});

test(`a newer ${userAgent} drag invalidates an older delayed origin`, async () => {
  const origins = [deferred(), deferred()];
  let reads = 0;
  const h = pinWindow({ userAgent, outerPosition: () => origins[reads++].promise });
  const image = imageSurface(h);
  image.props.onPointerDown(moveEvent(10, 20));
  image.props.onPointerUp(moveEvent(200, 250));
  image.props.onPointerDown(moveEvent(300, 350));
  image.props.onPointerUp(moveEvent(320, 380));
  origins[1].resolve({ x: -400, y: 100 });
  await settleRequests();
  assert.deepEqual({ ...h.positions[0].value }, { x: -360, y: 160 });
  h.positions[0].resolve();
  origins[0].resolve({ x: -400, y: 100 });
  await settleRequests();
  assert.equal(h.positions.length, 1, "the old gesture must not jump the window back");
});
}

test("Windows drag waits for both native origin and display scale, independent of WebView content zoom", async () => {
  for (const scale of [1, 1.25, 2]) {
    const displayScale = deferred();
    const h = pinWindow({ userAgent: "Windows NT 10.0", contentScale: 2.5,
      scaleFactor: () => displayScale.promise });
    const image = imageSurface(h);
    image.props.onPointerDown(moveEvent(-20, 35));
    image.props.onPointerUp(moveEvent(15, 61));
    await settleRequests();
    assert.equal(h.positions.length, 0, "a partial native snapshot cannot move the window");
    displayScale.resolve(scale);
    await settleRequests();
    assert.deepEqual({ ...h.positions[0].value }, {
      x: Math.round(-400 + 35 * scale), y: Math.round(100 + 26 * scale),
    }, "screen-coordinate deltas use the native display scale exactly once");
    h.positions[0].resolve();
    h.component.unmount();
  }
});

test("right clicks never drag or expose the browser image menu; Linux retains native dragging", async () => {
  for (const userAgent of ["Macintosh", "Windows", "Linux"]) {
    const h = pinWindow({ userAgent });
    imageSurface(h).props.onPointerDown({ button: 2 });
    let prevented = 0;
    h.component.render().props.onContextMenu({ preventDefault: () => prevented++ });
    await settleRequests();
    assert.equal(prevented, 1, userAgent);
    assert.equal(h.positions.length, 0);
    assert.equal(h.drags(), 0);
    if (userAgent === "Linux") {
      imageSurface(h).props.onPointerDown({ button: 0 });
      assert.equal(h.drags(), 1);
    }
    h.component.unmount();
  }
});

test("saved image revisions refresh only their pin and recover an image load failure", async () => {
  const h = pinWindow();
  await settleRequests();
  const img = () => nodes(h.component.render()).find(node => node?.type === "img");
  assert.equal(img().props.src, "image:test?v=0");
  h.changed("another-image");
  assert.equal(img().props.src, "image:test?v=0");
  img().props.onError();
  assert.equal(img(), undefined);
  h.changed("test-image");
  assert.equal(img().props.src, "image:test?v=1");
});

const pinViewport = h => nodes(h.component.render()).find(node => node?.props?.className === "pin-window__viewport");
const pinImage = h => nodes(h.component.render()).find(node => node?.type === "img");
const pinControl = (h, label) => nodes(h.component.render()).find(node => node?.type === "button" && node.props["aria-label"] === label);
const viewControl = h => nodes(h.component.render()).find(node => node?.props?.className?.includes("pin-window__zoom-value"));
const viewMenu = h => nodes(h.component.render()).find(node => node?.props?.role === "menu");
const viewChoices = h => nodes(h.component.render()).filter(node => node?.props?.role === "menuitemradio");
const currentScale = (h, sourceWidth = 800) => pinImage(h).props.style.width / sourceWidth;

async function loadedPin(options = {}) {
  const h = pinWindow(options);
  pinImage(h).props.onLoad({currentTarget: {naturalWidth: options.imageWidth ?? 800, naturalHeight: options.imageHeight ?? 400}});
  h.component.render();
  await settleRequests();
  return h;
}

function imagePointer(h, extra = {}) {
  return {button: 0, pointerId: 1, screenX: 100, screenY: 100, clientX: 100, clientY: 100,
    currentTarget: h.container, target: h.element("img"), defaultPrevented: false, stopped: false,
    preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, ...extra};
}

test("a loaded long reference starts at its first row with a readable zero-padding width", async () => {
  const h = pinWindow({imageWidth: 1080, imageHeight: 10000, containerWidth: 640, containerHeight: 720});
  assert.equal(pinControl(h, "Zoom in").props.disabled, true);
  assert.equal(pinImage(h).props.style.visibility, "hidden");
  pinImage(h).props.onLoad({currentTarget: {naturalWidth: 1080, naturalHeight: 10000}});
  const style = pinImage(h).props.style;
  assert.equal(style.width, 640); assert.ok(style.height > 5900);
  assert.equal(style.left, 0); assert.equal(style.top, 0);
  assert.equal(h.container.scrollTop, 0); assert.equal(h.container.scrollLeft, 0);
  assert.equal(pinControl(h, "Zoom in").props.disabled, false);
  assert.equal(h.positions.length, 0); assert.equal(h.sizes.length, 0);
  h.component.unmount();
});

test("moderately stitched pins use reading width only while the frame overflows and keep the menu state consistent", async () => {
  const h = await loadedPin({imageWidth: 768, imageHeight: 840, containerWidth: 768, containerHeight: 360, contentScale: 1});
  assert.equal(pinImage(h).props.style.width, 768); assert.equal(pinImage(h).props.style.height, 840);
  assert.equal(pinImage(h).props.style.top, 0);
  viewControl(h).props.onClick(); h.component.render();
  assert.equal(viewChoices(h)[0].props["aria-checked"], true);
  h.keyboard({key: "Escape"}); h.component.render();
  h.resize(384, 420);
  assert.equal(pinImage(h).props.style.width, 384); assert.equal(pinImage(h).props.style.height, 420);
  viewControl(h).props.onClick(); h.component.render();
  assert.equal(viewChoices(h)[1].props["aria-checked"], true);
  h.component.unmount();
});

test("ordinary reference frame resizing still enlarges its fitted image, while actual size stays independent", async () => {
  const h = await loadedPin();
  assert.equal(pinImage(h).props.style.width, 400); assert.equal(pinImage(h).props.style.left, 0);
  h.resize(600, 300);
  assert.equal(pinImage(h).props.style.width, 600); assert.equal(pinImage(h).props.style.height, 300);
  h.keyboard({key: "1", ctrlKey: true}); h.component.render();
  assert.equal(pinImage(h).props.style.width, 400);
  h.resize(800, 400);
  assert.equal(pinImage(h).props.style.width, 400); assert.equal(pinImage(h).props.style.height, 200);
  assert.equal(pinImage(h).props.style.left, 200); assert.equal(pinImage(h).props.style.top, 100);
  assert.equal(h.sizes.length, 0, "view actions must never resize the native window");
  h.component.unmount();
});

test("ordinary wheel scroll is retained and modifier-wheel/pinch preserve the pointer's source location", async () => {
  const h = await loadedPin({imageWidth: 4000, imageHeight: 30000, containerWidth: 700, containerHeight: 600, contentScale: 1});
  h.keyboard({key: "1", ctrlKey: true}); h.component.render();
  h.container.scrollLeft = 800; h.container.scrollTop = 9000; pinViewport(h).props.onScroll();
  const before = {x: (800 + 350) / currentScale(h, 4000), y: (9000 + 300) / currentScale(h, 4000)};
  assert.equal(h.wheel(100).defaultPrevented, false);
  assert.equal(h.wheel(-16, {ctrlKey: true}).defaultPrevented, true);
  let scale = currentScale(h, 4000);
  assert.ok(Math.abs((h.container.scrollLeft + 350) / scale - before.x) < 1e-7);
  assert.ok(Math.abs((h.container.scrollTop + 300) / scale - before.y) < 1e-7);
  h.pinch("gesturestart", 1); h.pinch("gesturechange", 1.5);
  scale = currentScale(h, 4000);
  assert.ok(Math.abs((h.container.scrollTop + 300) / scale - before.y) < 1e-7);
  assert.equal(h.positions.length, 0); assert.equal(h.sizes.length, 0);
  h.component.unmount();
});

test("Space and middle drags pan content without starting native window movement", async () => {
  for (const button of [0, 1]) {
    const h = await loadedPin({imageWidth: 2000, imageHeight: 10000});
    h.keyboard({key: "1", ctrlKey: true}); h.component.render();
    h.container.scrollLeft = 200; h.container.scrollTop = 800; pinViewport(h).props.onScroll();
    if (button === 0) { h.keyboard({key: " ", code: "Space"}); h.component.render(); }
    const down = imagePointer(h, {button, clientX: 150, clientY: 120});
    pinViewport(h).props.onPointerDownCapture(down);
    if (!down.stopped) imageSurface(h).props.onPointerDown(down);
    assert.equal(down.stopped, true);
    const move = imagePointer(h, {button, clientX: 110, clientY: 70});
    pinViewport(h).props.onPointerMoveCapture(move);
    if (!move.stopped) imageSurface(h).props.onPointerMove(move);
    assert.equal(h.container.scrollLeft, 240); assert.equal(h.container.scrollTop, 850);
    pinViewport(h).props.onPointerUpCapture(imagePointer(h, {button}));
    await settleRequests();
    assert.equal(h.positions.length, 0); assert.equal(h.drags(), 0);
    h.component.unmount();
  }
});

test("native scrollbars and touch scrolling never begin a reference-window drag", async () => {
  const h = await loadedPin({containerWidth: 400, containerHeight: 200});
  h.container.clientWidth = 388; h.container.clientHeight = 188;
  for (const point of [{clientX: 395, clientY: 80}, {clientX: 150, clientY: 195}]) {
    const event = imagePointer(h, point);
    pinViewport(h).props.onPointerDownCapture(event);
    imageSurface(h).props.onPointerDown(event);
  }
  imageSurface(h).props.onPointerDown(imagePointer(h, {pointerType: "touch"}));
  await settleRequests();
  assert.equal(h.positions.length, 0); assert.equal(h.drags(), 0);
  assert.equal(pinImage(h).props.style.visibility, "visible");
  h.component.unmount();
});

test("window movement and corner resize lock view zoom until the pointer finishes", async () => {
  const h = await loadedPin();
  const before = pinImage(h).props.style.width;
  const down = imagePointer(h);
  pinViewport(h).props.onPointerDownCapture(down); imageSurface(h).props.onPointerDown(down);
  assert.equal(h.wheel(-80, {ctrlKey: true}).defaultPrevented, true);
  pinControl(h, "Zoom in").props.onClick();
  assert.equal(pinImage(h).props.style.width, before);
  imageSurface(h).props.onPointerUp(imagePointer(h)); h.window.dispatchEvent({type: "pointerup"});
  const grip = () => nodes(h.component.render()).find(node => node?.props?.className === "pin-window__resize");
  grip().props.onPointerDown({...imagePointer(h), stopPropagation() {}});
  pinControl(h, "Zoom in").props.onClick(); h.pinch("gesturestart", 1); h.pinch("gesturechange", 2);
  assert.equal(pinImage(h).props.style.width, before);
  grip().props.onPointerUp(imagePointer(h)); h.window.dispatchEvent({type: "pointerup"});
  pinControl(h, "Zoom in").props.onClick();
  assert.equal(pinImage(h).props.style.width, before * 1.25);
  h.component.unmount();
});

test("density-only changes preserve the center of the currently read source image", async () => {
  const h = await loadedPin({imageWidth: 4000, imageHeight: 30000, contentScale: 1});
  h.keyboard({key: "1", ctrlKey: true}); h.component.render();
  h.container.scrollLeft = 800; h.container.scrollTop = 9000; pinViewport(h).props.onScroll();
  const center = {x: 1000, y: 9100};
  h.density(2);
  assert.equal(pinImage(h).props.style.width, 2000);
  assert.equal((h.container.scrollLeft + 200) / .5, center.x);
  assert.equal((h.container.scrollTop + 100) / .5, center.y);
  h.component.unmount();
});

test("same-size content revisions retain reading position and ignore old image callbacks", async () => {
  const h = await loadedPin({imageWidth: 1200, imageHeight: 12000});
  h.keyboard({key: "1", ctrlKey: true}); h.component.render();
  h.container.scrollLeft = 50; h.container.scrollTop = 2800; pinViewport(h).props.onScroll();
  const old = pinImage(h), width = old.props.style.width;
  h.changed("test-image");
  old.props.onError(); old.props.onLoad({currentTarget: {naturalWidth: 10, naturalHeight: 10}});
  assert.equal(pinImage(h).props.src, "image:test?v=1");
  assert.equal(pinControl(h, "Zoom in").props.disabled, true);
  pinImage(h).props.onLoad({currentTarget: {naturalWidth: 1200, naturalHeight: 12000}});
  assert.equal(pinImage(h).props.style.width, width);
  assert.equal(h.container.scrollLeft, 50); assert.equal(h.container.scrollTop, 2800);
  h.changed("test-image");
  pinImage(h).props.onLoad({currentTarget: {naturalWidth: 800, naturalHeight: 400}});
  h.component.render();
  assert.equal(h.container.scrollLeft, 0); assert.equal(h.container.scrollTop, 0);
  assert.equal(pinImage(h).props.style.width, 400);
  h.component.unmount();
});

test("view menu supports keyboard choice, Escape without closing, and Tab back to toolbar controls", async () => {
  for (const size of [{containerWidth: 400, containerHeight: 200}, {containerWidth: 80, containerHeight: 60}]) {
    const h = await loadedPin(size);
    viewControl(h).props.onClick(); h.component.render();
    assert.equal(h.focused().props.children[0].props.children[0], "Fit image");
    const event = {key: "Home", target: h.focused(), preventDefault() {}, stopPropagation() {}};
    viewMenu(h).props.onKeyDown(event);
    assert.equal(h.focused().props.children[0].props.children[0], "Fit width");
    viewMenu(h).props.onKeyDown({...event, key: "End", target: h.focused()});
    assert.equal(h.focused().props.children[0].props.children[0], "Actual size");
    viewChoices(h)[2].props.onClick(); h.component.render();
    assert.equal(viewMenu(h), undefined); assert.equal(h.focused(), h.viewButton);
    viewControl(h).props.onClick(); h.component.render();
    h.keyboard({key: "Escape"}); h.component.render();
    assert.equal(viewMenu(h), undefined); assert.equal(h.closes(), 0);
    assert.equal(h.focused(), h.viewButton);
    viewControl(h).props.onClick(); h.component.render();
    viewMenu(h).props.onKeyDown({...event, key: "Tab", target: h.focused()}); h.component.render();
    assert.equal(viewMenu(h), undefined);
    assert.equal(h.focused().props["aria-label"], size.containerWidth === 80 ? "Unpin" : "Zoom in");
    h.component.unmount();
  }
});

test("view menu closes on an outside pointer or lost focus without taking image-drag input", async () => {
  const h = await loadedPin();
  viewControl(h).props.onClick(); h.component.render();
  h.window.dispatchEvent({type: "pointerdown", target: h.element("img")}); h.component.render();
  assert.equal(viewMenu(h), undefined);
  viewControl(h).props.onClick(); h.component.render();
  h.window.dispatchEvent({type: "blur"}); h.component.render();
  assert.equal(viewMenu(h), undefined); assert.equal(h.closes(), 0);
  h.component.unmount();
});

test("window-close keys ignore IME, handled keys and repeats; a held Escape cannot close after dismissing the menu", async () => {
  const h = await loadedPin();
  for (const extra of [{isComposing: true}, {keyCode: 229}, {defaultPrevented: true}, {repeat: true}]) {
    h.keyboard({key: "Escape", ...extra}); h.keyboard({key: "w", ctrlKey: true, ...extra});
  }
  h.keyboard({key: "w", ctrlKey: true, altKey: true});
  assert.equal(h.closes(), 0);
  viewControl(h).props.onClick(); h.component.render();
  h.keyboard({key: "Escape"}); h.component.render();
  assert.equal(viewMenu(h), undefined); assert.equal(h.closes(), 0);
  assert.equal(h.keyboard({key: "Escape", repeat: true}).defaultPrevented, true);
  assert.equal(h.closes(), 0);
  h.keyboard({key: "Escape"}); assert.equal(h.closes(), 1);
  h.component.unmount();
});

test("blur and unexpected lost pointer capture cancel late window geometry and release zoom locks", async () => {
  for (const finish of ["blur", "lostpointercapture"]) {
    const origin = deferred();
    const h = await loadedPin({outerPosition: () => origin.promise});
    const down = imagePointer(h);
    pinViewport(h).props.onPointerDownCapture(down); imageSurface(h).props.onPointerDown(down);
    imageSurface(h).props.onPointerMove(imagePointer(h, {screenX: 170, screenY: 140}));
    if (finish === "blur") h.window.dispatchEvent({type: "blur"});
    else h.window.dispatchThroughTarget({type: finish, pointerId: 1}, event => imageSurface(h).props.onLostPointerCapture(event));
    origin.resolve({x: 20, y: 30}); await settleRequests();
    assert.equal(h.positions.length, 0, finish);
    const before = pinImage(h).props.style.width;
    pinControl(h, "Zoom in").props.onClick();
    assert.equal(pinImage(h).props.style.width, before * 1.25, finish);
    h.component.unmount();
  }
});

test("normal drag release keeps its final native movement after automatic pointer-capture loss", async () => {
  const origin = deferred();
  const h = await loadedPin({outerPosition: () => origin.promise});
  imageSurface(h).props.onPointerDown(imagePointer(h));
  imageSurface(h).props.onPointerUp(imagePointer(h, {screenX: 170, screenY: 140}));
  h.window.dispatchThroughTarget({type: "lostpointercapture", pointerId: 1}, event => imageSurface(h).props.onLostPointerCapture(event));
  origin.resolve({x: 20, y: 30}); await settleRequests();
  assert.deepEqual({...h.positions[0].value}, {x: 160, y: 110});
  h.positions[0].resolve();
  h.component.unmount();
});

test("cancelled reference resizing cannot apply a late native size or leave view controls locked", async () => {
  for (const finish of ["cancel", "blur", "lostpointercapture", "unmount"]) {
    const size = deferred();
    const h = await loadedPin({innerSize: () => size.promise});
    const grip = () => nodes(h.component.render()).find(node => node?.props?.className === "pin-window__resize");
    grip().props.onPointerDown(imagePointer(h));
    grip().props.onPointerMove(imagePointer(h, {screenX: 180, screenY: 140}));
    if (finish === "cancel") grip().props.onPointerCancel();
    else if (finish === "unmount") h.component.unmount();
    else if (finish === "blur") h.window.dispatchEvent({type: "blur"});
    else h.window.dispatchThroughTarget({type: finish, pointerId: 1}, event => grip().props.onLostPointerCapture(event));
    size.resolve({width: 400, height: 200}); await settleRequests();
    assert.equal(h.sizes.length, 0, finish);
    if (finish !== "unmount") {
      const before = pinImage(h).props.style.width;
      pinControl(h, "Zoom in").props.onClick();
      assert.equal(pinImage(h).props.style.width, before * 1.25, finish);
      h.component.unmount();
    }
  }
});

test("normal resize release retains its final ratio after automatic capture loss while size is pending", async () => {
  const size = deferred();
  const h = await loadedPin({innerSize: () => size.promise});
  const grip = () => nodes(h.component.render()).find(node => node?.props?.className === "pin-window__resize");
  grip().props.onPointerDown(imagePointer(h));
  grip().props.onPointerUp(imagePointer(h, {screenX: 150, screenY: 125}));
  h.window.dispatchThroughTarget({type: "lostpointercapture", pointerId: 1}, event => grip().props.onLostPointerCapture(event));
  size.resolve({width: 400, height: 200}); await settleRequests();
  assert.deepEqual({...h.sizes[0].value}, {width: 500, height: 250});
  h.sizes[0].resolve();
  h.component.unmount();
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
    import {AnnotationToolbarButton} from "../components/AnnotationToolbarButton";
    const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}, captureToolOptionsLayout=${captureToolOptionsLayout.toString()}; ${toolbar}; export {ToolButton};`);
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
  const button = nodes(harness.mount("ToolButton", pin.props).render()).find(node => node?.type === "button");
  let stopped = 0;
  button.props.onKeyDown({ key:"Enter", stopPropagation:()=>stopped++ });
  assert.equal(stopped, 1, "Enter on Pin must not bubble into normal screenshot completion");
  const busy = nodes(component.render({ ...props, disabled:true }));
  assert.equal(busy.find(node => node?.props?.icon === "pin").props.disabled, true);
  assert.equal(busy.find(node => node?.props?.icon === "checkmark").props.disabled, true);
  component.unmount();
});
