import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const read = name => readFileSync(new URL(`../src/windows/${name}`, import.meta.url), "utf8");
function controlsSource(layout, panel) {
  return 'import React, { useRef } from "react";\n' + layout
    .replace(/^import .* from "react";\r?\n/m, "")
    .replace(/^import .* from "..\/lib\/ipc";\r?\n/m, "") + panel
    .replace(/^import .* from "\.\/useRecordingControlsLayout";\r?\n/m, "");
}
const source = controlsSource(read("useRecordingControlsLayout.ts"), read("ControlPanelWindow.tsx"));
const recording = { isRecording: true, isPaused: false, isStarting: false,
  isTransitioning: false, isFinalizing: false, elapsedLabel: "02:17" };

function controls(options = {}) {
  const layouts = [], positions = [], timers = new Map();
  const size = { width: 247.2, height: 52 };
  const attributes = new Map(), styles = new Map();
  const element = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    style: {
      setProperty: (name, value) => styles.set(name, value),
      removeProperty: name => styles.delete(name),
    },
    getBoundingClientRect() {
      let width = size.width;
      let height = size.height;
      if (attributes.has("data-compact")) width = 184;
      if (attributes.has("data-narrow")) width = 146;
      if (attributes.has("data-minimal")) width = 96;
      if (options.paletteWidth) {
        const paletteLimit = parseFloat(styles.get("--kiri-record-annotation-max-width"));
        const paletteWidth = Number.isFinite(paletteLimit) ? Math.min(options.paletteWidth, paletteLimit) : options.paletteWidth;
        width = Math.max(width, paletteWidth + 8);
        if (paletteWidth < options.paletteWidth) height += 32;
      }
      const limit = parseFloat(styles.get("--kiri-record-controls-max-width"));
      return { width: Number.isFinite(limit) ? Math.min(width, limit) : width, height };
    },
  };
  let sequence = 0, observe, scaleChanged, recordingChanged, languageChanged, shortcutsChanged;
  let shortcutReads = 0, shortcutDisposals = 0;
  let paused = 0, resumed = 0, stopped = 0;
  const native = {
    outerPosition: options.outerPosition ?? (async () => ({ x: -400, y: 100 })),
    scaleFactor: async () => 2,
    setPosition(value) {
      const result = deferred(); positions.push({ value, ...result }); return result.promise;
    },
    onScaleChanged: async callback => { scaleChanged = callback; return () => { scaleChanged = null; }; },
  };
  const h = createLibraryHarness({}, options.source ?? source, {
    search: "?window=control-panel&session=recording-1",
    strictEffects: options.strictEffects,
    document: { fonts: { ready: Promise.resolve() } },
    attachRef(node) {
      if (node.props.ref) node.props.ref.current = element;
    },
    globals: {
      ResizeObserver: class {
        constructor(callback) { observe = callback; }
        observe() {}
        disconnect() { observe = null; }
      },
      setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    modules: {
      "./useRecordingAnnotations": {useRecordingAnnotations: () => ({state: null, failed: false})},
      "./RecordingAnnotationControls": {RecordingAnnotationControls: "annotation-controls"},
      "@tauri-apps/api/window": { getCurrentWindow: () => native },
      "@tauri-apps/api/dpi": { PhysicalPosition: class {
        constructor(x, y) { this.x = x; this.y = y; }
      } },
      "../lib/ipc": {
        api: {
          getRecordingState: async () => recording,
          getShortcutSettings: async () => {
            shortcutReads++;
            return options.getShortcutSettings ? options.getShortcutSettings() : [];
          },
          positionRecordingControls(request) {
            const result = deferred();
            layouts.push({ request, ...result, resolve: (value = { maxWidth: options.maxWidth ?? 1000 }) => result.resolve(value) });
            return result.promise;
          },
          pauseRecording: async () => { paused++; },
          resumeRecording: async () => { resumed++; },
          stopRecording: async () => { stopped++; },
        },
        onRecordingState: async callback => {
          recordingChanged = callback; return () => { recordingChanged = null; };
        },
        onShortcutSettingsChanged: async callback => {
          shortcutsChanged = callback;
          if (options.shortcutSubscription) await options.shortcutSubscription;
          return () => {
            shortcutDisposals++;
            if (shortcutsChanged === callback) shortcutsChanged = null;
          };
        },
      },
      "lucide-react": { GripVertical: "grip" },
      "../i18n": { t: value => value, onLanguageChange(callback) {
        languageChanged = callback; return () => { languageChanged = null; };
      } },
    },
  });
  h.window.devicePixelRatio = 2.5;
  const component = h.mount("ControlPanelWindow", {});
  component.render();
  const flush = async () => {
    await settleRequests();
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    await settleRequests();
  };
  return { component, layouts, positions, window: h.window, size, flush, attributes,
    resize: () => observe(), scale: () => scaleChanged(), state: value => recordingChanged(value),
    language: () => languageChanged(),
    shortcuts: value => shortcutsChanged?.(value),
    shortcutListener: () => shortcutsChanged,
    shortcutStats: () => ({ reads: shortcutReads, disposals: shortcutDisposals }),
    calls: () => ({ paused, resumed, stopped }),
    async ready() { await flush(); layouts.at(-1).resolve(); await flush(); },
  };
}
const surface = h => nodes(h.component.render()).find(node => node?.props?.className === "kiri-record-controls");
const controlButton = (h, label) => nodes(h.component.render()).find(node => node?.props?.["aria-label"] === label);
const shortcut = (action, label, status = "enabled") => ({ action, scope: "recording", label, status,
  defaultLabel: label, isDefault: true });
const pointer = (x, y, button = false) => ({ pointerId: 1, button: 0, screenX: x, screenY: y,
  target: { closest: () => button }, preventDefault() {}, currentTarget: { setPointerCapture() {} } });

for (const [name, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`real recording controls mount and act with ${name} source line endings`, async () => {
    const normalized = file => read(file).replace(/\r?\n/g, lineEnding);
    const h = controls({ source: controlsSource(
      normalized("useRecordingControlsLayout.ts"), normalized("ControlPanelWindow.tsx"),
    ) });
    await h.ready();
    assert.ok(h.attributes.has("data-layout-ready"));
    assert.equal(h.layouts[0].request.sessionId, "recording-1");
    const pause = nodes(h.component.render()).find(node => node?.props?.["aria-label"] === "Pause Recording");
    pause.props.onClick();
    assert.equal(h.calls().paused, 1);
    h.component.unmount();
  });
}

test("natural content size includes padding, accessibility scale, and coalesces identical measurements", async () => {
  const h = controls();
  await h.ready();
  assert.deepEqual(h.layouts[0].request, { sessionId: "recording-1", width: 248, height: 52,
    contentScale: 2.5, preservePosition: false });
  h.resize(); h.resize(); await h.flush();
  assert.equal(h.layouts.length, 1);
  h.size.width = 312; h.resize(); await h.flush();
  assert.equal(h.layouts[1].request.width, 312);
  h.layouts[1].resolve(); await h.flush();
  h.window.devicePixelRatio = Number.NaN; h.scale(); await h.flush();
  assert.equal(h.layouts[2].request.contentScale, 1);
  h.component.unmount();
});

test("narrow expanded annotations request their full measured height", async () => {
  const h = controls({paletteWidth: 390, maxWidth: 320});
  h.size.height = 268;
  await h.ready();
  assert.equal(h.layouts.at(-1).request.width, 320);
  assert.equal(h.layouts.at(-1).request.height, 300, "wrapped tools and text options are not capped at the old 240px height");
  assert.equal(h.attributes.has("data-minimal"), false, "the annotation rows do not hide the timer");
  h.component.unmount();
});

test("drag waits for an in-flight layout and clamps only after the final physical move", async () => {
  const h = controls(); await h.flush();
  const bar = surface(h);
  bar.props.onPointerDown(pointer(100, 100));
  bar.props.onPointerMove(pointer(150, 125));
  await h.flush();
  assert.equal(h.positions.length, 0, "origin and moves wait behind native placement");
  h.layouts[0].resolve(); await h.flush();
  assert.deepEqual({ ...h.positions[0].value }, { x: -300, y: 150 });
  bar.props.onPointerMove(pointer(175, 140));
  bar.props.onPointerUp(pointer(200, 150));
  h.size.width = 290; h.resize(); await h.flush();
  assert.equal(h.positions.length, 1);
  assert.equal(h.layouts.length, 1, "measurements cannot race an active drag");
  h.positions[0].resolve(); await h.flush();
  assert.deepEqual({ ...h.positions[1].value }, { x: -200, y: 200 });
  h.positions[1].resolve(); await h.flush();
  assert.equal(h.layouts.at(-1).request.preservePosition, true);
  assert.equal(h.layouts.at(-1).request.width, 290);
  h.component.unmount();
});

test("pointer release before the native origin arrives still applies the final drag point", async () => {
  const origin = deferred();
  const h = controls({ outerPosition: () => origin.promise }); await h.ready();
  const bar = surface(h);
  bar.props.onPointerDown(pointer(100, 100));
  bar.props.onPointerMove(pointer(130, 125));
  bar.props.onPointerUp(pointer(160, 150));
  await h.flush(); assert.equal(h.positions.length, 0);
  origin.resolve({ x: 100, y: 200 }); await h.flush();
  assert.deepEqual({ ...h.positions[0].value }, { x: 220, y: 300 });
  h.positions[0].resolve(); await h.flush();
  assert.equal(h.layouts.at(-1).request.preservePosition, true);
  h.component.unmount();
});

test("display scale change cancels stale scaled pointer updates before clamping", async () => {
  const h = controls(); await h.ready();
  const bar = surface(h);
  bar.props.onPointerDown(pointer(100, 100));
  bar.props.onPointerMove(pointer(125, 125)); await h.flush();
  bar.props.onPointerMove(pointer(200, 200));
  h.window.devicePixelRatio = 1; h.scale(); await h.flush();
  assert.equal(h.layouts.length, 1);
  h.positions[0].resolve(); await h.flush();
  assert.equal(h.positions.length, 1, "the queued old-scale pointer position is discarded");
  assert.equal(h.layouts.at(-1).request.contentScale, 1);
  assert.equal(h.layouts.at(-1).request.preservePosition, true);
  h.component.unmount();
});

test("button presses do not drag and a fresh recording never reuses another recording's position", async () => {
  const h = controls(); await h.ready();
  const bar = surface(h);
  bar.props.onPointerDown(pointer(100, 100, true));
  bar.props.onPointerMove(pointer(200, 200));
  bar.props.onPointerUp(pointer(200, 200)); await h.flush();
  assert.equal(h.positions.length, 0);
  h.component.unmount();
  const next = controls(); await next.ready();
  assert.equal(next.layouts[0].request.preservePosition, false);
  next.component.unmount();
});

test("unmount cancels queued drag writes and follow-up placement", async () => {
  const h = controls(); await h.ready();
  const bar = surface(h);
  bar.props.onPointerDown(pointer(100, 100));
  bar.props.onPointerMove(pointer(125, 125)); await h.flush();
  bar.props.onPointerUp(pointer(200, 200));
  h.component.unmount(); h.positions[0].resolve(); await h.flush();
  assert.equal(h.positions.length, 1);
  assert.equal(h.layouts.length, 1);
});

test("paused controls preserve elapsed time and expose Resume and explicit Stop", async () => {
  const h = controls(); await h.ready();
  h.state({ ...recording, isRecording: false, isPaused: true });
  const tree = nodes(h.component.render());
  assert.deepEqual(tree.find(node => node?.props?.role === "timer").props.children, ["02:17"]);
  const resume = tree.find(node => node?.props?.["aria-label"] === "Resume Recording");
  assert.equal(resume.props["aria-pressed"], true);
  resume.props.onClick();
  assert.equal(h.calls().resumed, 1);
  assert.ok(tree.includes("Stop Recording"));
  h.component.unmount();
});

test("ordinary typing and modified keys never pause or stop through the floating panel", async () => {
  const h = controls(); await h.ready(); h.component.render();
  let prevented = 0;
  for (const state of [recording, { ...recording, isRecording: false, isPaused: true },
    { ...recording, isRecording: false, isStarting: true }]) {
    h.state(state); h.component.render();
    for (const key of [" ", "Enter", "Escape"]) {
      for (const extra of [{}, { repeat: true }, { isComposing: true },
        { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
        h.window.dispatchEvent({ type: "keydown", key, code: key === " " ? "Space" : key,
          ...extra, preventDefault() { prevented++; } });
      }
    }
  }
  assert.equal(prevented, 0, "native focused-button keyboard activation remains available");
  assert.deepEqual(h.calls(), { paused: 0, resumed: 0, stopped: 0 });
  const cancel = nodes(h.component.render()).find(node => node?.props?.["aria-label"] === "Cancel");
  cancel.props.onClick();
  assert.equal(h.calls().stopped, 1, "startup still has an explicit accessible Cancel button");
  h.component.unmount();
});

test("recording tooltips show actual enabled bindings and follow pause, edits, and availability", async () => {
  const h = controls({ getShortcutSettings: async () => [
    shortcut("recordingPauseResume", "⇧⌥⌘P"), shortcut("recordingStop", "⇧⌥⌘S"),
  ] });
  await h.ready();
  assert.equal(controlButton(h, "Pause Recording").props.title, "Pause Recording · ⇧⌥⌘P");
  assert.equal(controlButton(h, "Stop and Save Recording").props.title, "Stop and Save Recording · ⇧⌥⌘S");
  h.state({ ...recording, isRecording: false, isPaused: true });
  h.shortcuts([shortcut("recordingPauseResume", "Ctrl+Alt+7"), shortcut("recordingStop", "Shift+Ctrl+S")]);
  assert.equal(controlButton(h, "Resume Recording").props.title, "Resume Recording · Ctrl+Alt+7");
  assert.equal(controlButton(h, "Stop and Save Recording").props.title, "Stop and Save Recording · Shift+Ctrl+S");
  for (const status of ["disabled", "occupied", "inactive", "systemManaged"]) {
    h.shortcuts([shortcut("recordingPauseResume", "P", status), shortcut("recordingStop", "S", status)]);
    assert.equal(controlButton(h, "Resume Recording").props.title, "Resume Recording");
    assert.equal(controlButton(h, "Stop and Save Recording").props.title, "Stop and Save Recording");
  }
  h.shortcuts([shortcut("recordingPauseResume", "⇧⌥⌘P"), shortcut("recordingStop", "⇧⌥⌘S")]);
  h.state({ ...recording, isRecording: false, isStarting: true });
  assert.equal(controlButton(h, "Pause Recording").props.title, "Preparing recording");
  assert.equal(controlButton(h, "Cancel").props.title, "Cancel");
  assert.equal(h.shortcutStats().reads, 1);
  assert.equal(h.layouts.length, 1, "tooltip changes do not change the native control dimensions");
  h.component.unmount(); await h.flush();
  assert.equal(h.shortcutStats().disposals, 1);
});

test("a shortcut event wins over a late initial snapshot", async () => {
  const snapshot = deferred();
  const h = controls({ getShortcutSettings: () => snapshot.promise });
  await h.ready();
  h.shortcuts([shortcut("recordingPauseResume", "Alt+8"), shortcut("recordingStop", null, "disabled")]);
  snapshot.resolve([shortcut("recordingPauseResume", "⇧⌥⌘P"), shortcut("recordingStop", "⇧⌥⌘S")]);
  await h.flush();
  assert.equal(controlButton(h, "Pause Recording").props.title, "Pause Recording · Alt+8");
  assert.equal(controlButton(h, "Stop and Save Recording").props.title, "Stop and Save Recording");
  h.component.unmount(); await h.flush();
});

test("unmount during shortcut subscription disposes it without starting a snapshot request", async () => {
  const subscription = deferred();
  const h = controls({ shortcutSubscription: subscription.promise });
  await h.ready();
  const lateEvent = h.shortcutListener();
  h.component.unmount();
  lateEvent([shortcut("recordingPauseResume", "Alt+9")]);
  subscription.resolve(); await h.flush();
  assert.deepEqual(h.shortcutStats(), { reads: 0, disposals: 1 });
});


test("a narrow work area uses compact controls and a larger monitor restores the natural label width", async () => {
  const h = controls({ maxWidth: 200 });
  await h.ready();
  assert.equal(h.layouts[0].request.width, 248, "first measurement is not limited by the initial native window");
  assert.equal(h.layouts[1].request.width, 184);
  assert.ok(h.attributes.has("data-compact"));
  assert.ok(h.attributes.has("data-layout-ready"));
  h.layouts[1].resolve(); await h.flush();
  h.resize(); await h.flush();
  assert.equal(h.layouts.length, 2, "compact measurement does not oscillate with native resizing");
  h.scale(); await h.flush();
  h.layouts.at(-1).resolve({ maxWidth: 1000 }); await h.flush();
  assert.equal(h.layouts.at(-1).request.width, 248);
  assert.equal(h.attributes.has("data-compact"), false, "mode is not locked to its own small viewport");
  h.component.unmount();
});

test("extreme scaling keeps both recording actions reachable at a 96 CSS pixel limit", async () => {
  const h = controls({ maxWidth: 96 });
  await h.ready();
  assert.equal(h.layouts.at(-1).request.width, 96);
  assert.ok(h.attributes.has("data-minimal"));
  const buttons = nodes(h.component.render()).filter(node => node?.type === "button");
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map(node => node.props["aria-label"]), ["Pause Recording", "Stop and Save Recording"]);
  buttons[1].props.onClick();
  assert.equal(h.calls().stopped, 1);
  h.component.unmount();
});


test("shorter translated labels leave compact mode even without a parent resize", async () => {
  const h = controls({ maxWidth: 220 }); await h.ready();
  h.layouts.at(-1).resolve(); await h.flush();
  assert.ok(h.attributes.has("data-compact"));
  h.size.width = 204; h.language(); await h.flush();
  assert.equal(h.attributes.has("data-compact"), false);
  assert.equal(h.layouts.at(-1).request.width, 204);
  h.component.unmount();
});

test("a wide annotation palette wraps before header compaction and preserves a fitting timer", async () => {
  const h = controls({maxWidth: 320, paletteWidth: 350});
  h.size.width = 390; // A long localized Stop label requires only compact mode.
  await h.ready();
  assert.equal(h.layouts[0].request.width, 390, "initial natural size ignores the startup WebView width");
  assert.equal(h.layouts.at(-1).request.width, 320);
  assert.equal(h.layouts.at(-1).request.height, 84, "palette wrapping is included in native height");
  assert.ok(h.attributes.has("data-compact"));
  assert.equal(h.attributes.has("data-narrow"), false, "palette width cannot hide a fitting grip");
  assert.equal(h.attributes.has("data-minimal"), false, "palette width cannot hide a fitting timer");
  h.layouts.at(-1).resolve(); await h.flush();
  const count = h.layouts.length; h.resize(); await h.flush();
  assert.equal(h.layouts.length, count, "wrapped content has a stable measured size");
  h.scale(); await h.flush(); h.layouts.at(-1).resolve({maxWidth: 1000}); await h.flush();
  assert.equal(h.layouts.at(-1).request.width, 390);
  assert.equal(h.layouts.at(-1).request.height, 52);
  assert.equal(h.attributes.has("data-compact"), false, "a larger display restores natural content");
  h.component.unmount();
});

test("a palette alone never compacts a header that already fits the monitor", async () => {
  const h = controls({maxWidth: 320, paletteWidth: 350}); await h.ready();
  assert.equal(h.layouts.at(-1).request.width, 320);
  for (const mode of ["compact", "narrow", "minimal"]) assert.equal(h.attributes.has(`data-${mode}`), false);
  h.component.unmount();
});
