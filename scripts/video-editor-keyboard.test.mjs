import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";
import { createVideoPlayerHarness } from "./helpers/video-player-harness.mjs";
import * as composition from "../src/annotation/text-composition.js";

const capabilities = Object.fromEntries([
  "videoEditing", "videoSpeedEditing", "videoEffectsEditing", "videoAnnotationsEditing", "videoExportPresets",
].map(key => [key, true]));

// Represent the focused element and its owning controls; no DOM or native media
// is needed to execute the production window handlers in their event phases.
class FocusTarget {
  constructor(...selectors) { this.selectors = selectors; }
  closest(selectors) {
    return selectors.split(",").some(selector => this.selectors.includes(selector)) ? this : null;
  }
}
function keyEvent(key, target = new FocusTarget(), flags = {}) {
  return { type: "keydown", key, code: key === " " ? "Space" : key,
    target, defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
    stopImmediatePropagation() { this.cancelBubble = true; }, ...flags };
}
function playerFixture(t) {
  const component = createVideoPlayerHarness(capabilities);
  t.after(() => component.unmount());
  const media = nodes(component.openEditor()).find(node => node?.type === "video").props.ref.current;
  let plays = 0;
  media.paused = true;
  media.play = () => { plays++; return Promise.resolve(); };
  return { ...component, get plays() { return plays; } };
}
function annotationFixture(t) {
  const calls = { edit: 0, undo: 0, delete: 0, activate: 0 };
  const canvas = { finishAppearanceAdjustment() {}, commitTextEditing() {},
    editSelectedText() { calls.edit++; }, undo() { calls.undo++; },
    deleteSelection() { calls.delete++; }, clearSelection() {} };
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/VideoAnnotationsEditor.tsx", import.meta.url), "utf8");
  const h = createLibraryHarness({}, source, {
    globals: { HTMLElement: FocusTarget },
    attachRef(node) { if (node.type === "annotation-canvas") node.props.ref.current = canvas; },
    modules: {
      "./VideoEffectSlider": { VideoEffectSlider: "effect-slider" },
      "../components/ChoiceSelect": { ChoiceSelect: "choice-select" },
      "../annotation/AnnotationCanvas": "annotation-canvas",
      "../annotation/text-composition.js": composition,
      "../annotation/model": { COLOR_HEX: { white: "#fff" }, COLOR_LABELS: { white: "White" }, COLOR_PRESETS: ["white"] },
      "../annotation/useAnnotationAppearance": { useAnnotationAppearance: () => [{
        penWidth: 2, shapeWidth: 2, textFontSize: 20, mosaicBrushDiameter: 20,
      }, () => {}] },
    },
  });
  const component = h.mount("VideoAnnotationsEditor", {
    active: true, sourceSize: { width: 100, height: 100 }, viewSize: { width: 100, height: 100 },
    marks: [], revision: 0, disabled: false, onActivate() { calls.activate++; }, onChange() {}, onClose() {},
  });
  t.after(() => component.unmount());
  nodes(component.render()).find(node => node?.type === "annotation-canvas").props.onSelectionInfo({
    id: 1, kind: "text", fontSize: 20, text: "Example", color: "white",
  }, false);
  component.render();
  return { window: h.window, calls };
}

const activators = ["button", "[role=button]", "a[href]", "summary"];
const controls = ["input", "textarea", "select", "[contenteditable]", "[role=listbox]", "[role=menu]", "[role=dialog]", "dialog"];

test("Space on a focused editor action preserves activation instead of playing", t => {
  const f = playerFixture(t);
  for (const selector of activators) {
    const event = keyEvent(" ", new FocusTarget(selector));
    f.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, selector);
  }
  assert.equal(f.plays, 0);
  const canvasEvent = keyEvent(" ");
  f.window.dispatchEvent(canvasEvent);
  assert.equal(canvasEvent.defaultPrevented, true);
  assert.equal(f.plays, 1, "Space still plays from the editor canvas");
});

test("Enter reaches focused actions before the annotation capture listener", t => {
  const f = annotationFixture(t);
  for (const selector of activators) {
    const event = keyEvent("Enter", new FocusTarget(selector));
    f.window.dispatchThroughTarget(event, event => event.stopPropagation());
    assert.equal(event.defaultPrevented, false, selector);
  }
  assert.equal(f.calls.edit, 0);
  const canvasEvent = keyEvent("Enter");
  f.window.dispatchEvent(canvasEvent);
  assert.equal(canvasEvent.defaultPrevented, true);
  assert.equal(f.calls.edit, 1, "Enter still edits selected canvas text");
});

test("editing fields, menus and dialogs retain their own keys", t => {
  const player = playerFixture(t), annotation = annotationFixture(t);
  const before = player.projectOptions().getProject();
  for (const selector of controls) for (const key of [" ", "Enter", "Delete", "p"]) {
    for (const owner of [player, annotation]) {
      const event = keyEvent(key, new FocusTarget(selector));
      owner.window.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, `${selector}: ${key}`);
    }
  }
  assert.equal(player.plays, 0);
  assert.deepEqual(player.projectOptions().getProject(), before);
  assert.deepEqual(annotation.calls, { edit: 0, undo: 0, delete: 0, activate: 0 });
});

test("handled events and IME confirmation never activate editor shortcuts", t => {
  const player = playerFixture(t), annotation = annotationFixture(t);
  const before = player.projectOptions().getProject();
  for (const flags of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    for (const key of [" ", "Enter", "Delete", "p"]) {
      player.window.dispatchEvent(keyEvent(key, new FocusTarget(), flags));
      annotation.window.dispatchEvent(keyEvent(key, new FocusTarget(), flags));
    }
  }
  assert.equal(player.plays, 0);
  assert.deepEqual(player.projectOptions().getProject(), before);
  assert.deepEqual(annotation.calls, { edit: 0, undo: 0, delete: 0, activate: 0 });
});

test("focused buttons keep document undo shortcuts", t => {
  const f = annotationFixture(t);
  const event = keyEvent("z", new FocusTarget("button"), { metaKey: true });
  f.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.calls.undo, 1);
});

function playbackFixture(t) {
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/VideoPlaybackControls.tsx", import.meta.url), "utf8");
  const calls = { play: 0, pause: 0 };
  const media = { duration: 60, currentTime: 10, paused: true, volume: 1, muted: false, playbackRate: 1,
    addEventListener() {}, removeEventListener() {},
    play() { calls.play++; return Promise.resolve(); }, pause() { calls.pause++; } };
  const h = createLibraryHarness({}, source, {
    modules: {
      "./video-trim.js": { videoTimeLabel: String },
      "../annotation/text-composition.js": composition,
      "@tauri-apps/api/window": { getCurrentWindow: () => ({
        isFullscreen: async () => false, onResized: async () => () => {},
      }) },
    },
    globals: { localStorage: { getItem: () => null } },
  });
  const component = h.mount("VideoPlaybackControls", { video: { current: media } });
  component.render(); t.after(() => component.unmount());
  return { window: h.window, media, calls };
}

test("preview playback ignores handled, composing and modified shortcut keys", t => {
  const f = playbackFixture(t);
  for (const flags of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 },
    { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
    for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
      const event = keyEvent(key, new FocusTarget(), flags);
      f.window.dispatchEvent(event);
      assert.equal(event.defaultPrevented, !!flags.defaultPrevented);
    }
  }
  assert.deepEqual(f.calls, { play: 0, pause: 0 });
  assert.equal(f.media.currentTime, 10);
});

test("preview fields, focused actions, menus and dialogs keep their own keys", t => {
  const f = playbackFixture(t);
  for (const selector of [...activators, ...controls]) for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
    const event = keyEvent(key, new FocusTarget(selector));
    f.window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `${selector}: ${key}`);
  }
  assert.deepEqual(f.calls, { play: 0, pause: 0 });
  assert.equal(f.media.currentTime, 10);
});

test("plain preview shortcuts still toggle playback and seek within the video", t => {
  const f = playbackFixture(t);
  const key = value => { const event = keyEvent(value); f.window.dispatchEvent(event); assert.equal(event.defaultPrevented, true); };
  key(" "); assert.equal(f.calls.play, 1);
  f.media.paused = false; key(" "); assert.equal(f.calls.pause, 1);
  key("ArrowRight"); assert.equal(f.media.currentTime, 15);
  key("ArrowLeft"); assert.equal(f.media.currentTime, 10);
  f.media.currentTime = 58; key("ArrowRight"); assert.equal(f.media.currentTime, 60);
  f.media.currentTime = 2; key("ArrowLeft"); assert.equal(f.media.currentTime, 0);
});
