import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isBasicVideoEditing, unsupportedVideoProjectFeatures, videoEditingCapabilities } from "../src/windows/video-capabilities.js";
import { createLibraryHarness, nodes, settleRequests } from "./helpers/library-render-harness.mjs";
import { createVideoPlayerHarness } from "./helpers/video-player-harness.mjs";

const none = {
  videoEditing: false,
  videoSpeedEditing: false,
  videoEffectsEditing: false,
  videoAnnotationsEditing: false,
  videoExportPresets: false,
};
const basic = { ...none, videoEditing: true, videoExportPresets: true };
const full = Object.fromEntries(Object.keys(none).map(key => [key, true]));
const project = (edit = {}, preset = "original") => ({
  schemaVersion: 1,
  sourceSize: { width: 1920, height: 1080 },
  sourceDuration: 10,
  edit: { segments: [{ start: 0, end: 10 }], effects: [], annotations: [], stickers: [], ...edit },
  preset,
  playhead: 0,
});

test("decoder retry reuses the video element and preserves edits, undo history and playhead", t => {
  let failures = 0;
  const component = createVideoPlayerHarness(full, { onError: () => failures++ });
  t.after(() => component.unmount());
  let tree = component.openEditor();
  const start = nodes(tree).find(node => node?.props?.className === "kiri-video-trim-handle kiri-video-trim-handle--start");
  start.props.onKeyDown({ key: "ArrowRight", shiftKey: false, preventDefault() {} });
  tree = component.render();
  const video = nodes(tree).find(node => node?.type === "video");
  const player = video.props.ref.current;
  player.currentTime = 1.25; video.props.onTimeUpdate(); component.render();
  const edit = component.projectOptions().getProject().edit;
  assert.deepEqual(edit.segments, [{ start: .1, end: 10 }]);
  component.updateProps({ suspended: true });
  const retried = component.updateProps({ suspended: false, mediaRevision: 1 });
  const decoder = nodes(retried).find(node => node?.type === "video");
  assert.equal(decoder.props.ref.current, player);
  assert.equal(player.loads, 1); assert.equal(decoder.props.autoPlay, false);
  decoder.props.onLoadedMetadata({ currentTarget: player });
  tree = component.render();
  assert.equal(player.currentTime, 1.25);
  assert.deepEqual(component.projectOptions().getProject().edit, edit);
  const undo = nodes(tree).find(node => node?.props?.["aria-label"] === "Undo");
  assert.equal(undo.props.disabled, false);
  undo.props.onClick(); component.render();
  assert.deepEqual(component.projectOptions().getProject().edit.segments, [{ start: 0, end: 10 }]);
  assert.equal(failures, 0);
  decoder.props.onLoadedMetadata({ currentTarget: { ...player, duration: 12 } });
  assert.equal(failures, 1, "changed metadata cannot reinitialize the old draft");
  assert.equal(component.projectOptions().getProject().sourceDuration, 10);
});

test("a recovered video moved to Trash cannot keep an editable UI after its save queue disables", t => {
  const component = createVideoPlayerHarness(full);
  t.after(() => component.unmount());
  component.openEditor();
  const before = component.projectOptions().getProject().edit;
  const tree = component.updateProps({ editable: false });
  assert.equal(nodes(tree).some(node => node?.type === "export-panel"), false);
  assert.equal(nodes(tree).some(node => node?.props?.["aria-label"] === "Reset edit"), false);
  component.window.dispatchEvent({ type: "keydown", key: "s", target: { closest: () => null }, preventDefault() {} });
  component.render();
  assert.deepEqual(component.projectOptions().getProject().edit, before);
  assert.equal(component.projectOptions().enabled, false);
});

test("read-only preview does not pause ordinary autoplay when editing is unavailable", t => {
  const component = createVideoPlayerHarness(none);
  t.after(() => component.unmount());
  const video = nodes(component.render()).find(node => node?.type === "video");
  assert.equal(video.props.autoPlay, true);
  assert.equal(video.props.ref.current.pauses, 0);
});

test("decoder recovery restarts a failed filmstrip without recreating the editor", async t => {
  const decoders = [];
  const source = readFileSync(new URL("../src/windows/useVideoThumbnails.ts", import.meta.url), "utf8") +
    '\nexport function Thumbnails(props){return useVideoThumbnails("media:video",10,true,props.revision);}\n';
  const harness = createLibraryHarness({}, source, { document: { createElement() {
    const listeners = new Map();
    const decoder = { currentTime: 0, addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name), pause() {}, removeAttribute() {}, load() {},
      fail: () => listeners.get("error")?.() };
    decoders.push(decoder); return decoder;
  } } });
  harness.window.setTimeout = setTimeout;
  const hook = harness.mount("Thumbnails", { revision: 0 });
  t.after(() => hook.unmount());
  hook.render(); decoders[0].fail(); await settleRequests();
  assert.equal(hook.render().failed, true);
  assert.equal(decoders.length, 1);
  assert.equal(hook.render({ revision: 1 }).failed, false);
  assert.equal(decoders.length, 2);
});

test("capability lookup failures and missing flags fail closed", () => {
  for (const value of [undefined, null, {}]) {
    assert.deepEqual(videoEditingCapabilities(value), none);
    assert.equal(isBasicVideoEditing(value), false);
    assert.deepEqual(unsupportedVideoProjectFeatures(project(), value), ["editing"]);
  }
  assert.deepEqual(videoEditingCapabilities({ videoEditing: true }), { ...none, videoEditing: true });
});

test("flags require explicit boolean true and cannot override a missing renderer", () => {
  for (const value of ["true", "false", 1, 0, null]) {
    assert.deepEqual(videoEditingCapabilities(Object.fromEntries(Object.keys(none).map(key => [key, value]))), none);
  }
  assert.deepEqual(videoEditingCapabilities({ ...full, videoEditing: false }), none);
  assert.deepEqual(videoEditingCapabilities(full), full);
});

test("Linux basic editing permits precise cuts, removed middle ranges and reordered clips", () => {
  for (const segments of [
    [{ start: .123, end: 9.876 }],
    [{ start: .123, end: 2.456 }, { start: 5.678, end: 9.876 }],
    [{ start: 5.678, end: 9.876, speed: 1 }, { start: .123, end: 2.456 }],
  ]) assert.deepEqual(unsupportedVideoProjectFeatures(project({ segments }), basic), []);
  assert.equal(isBasicVideoEditing(basic), true);
  assert.equal(isBasicVideoEditing(full), false);
});

test("only editing speed is restricted; absent speed and explicit original speed are safe", () => {
  for (const speed of [.25, .5, 1.25, 2, 4, 1.0000001, NaN]) {
    assert.deepEqual(unsupportedVideoProjectFeatures(project({ segments: [{ start: 0, end: 10, speed }] }), basic), ["speed"]);
  }
  assert.deepEqual(unsupportedVideoProjectFeatures(project({ segments: [{ start: 0, end: 10, speed: 1 }] }), basic), []);
});

test("every effect type, including privacy masks, blocks basic export", () => {
  for (const kind of ["zoom", "mask", "spotlight", "frame", "fade"]) {
    const draft = project({ effects: [{ id: "private", kind, start: 0, end: 10 }] });
    assert.deepEqual(unsupportedVideoProjectFeatures(draft, basic), ["effects"]);
    assert.deepEqual(unsupportedVideoProjectFeatures(draft, { ...basic, videoEffectsEditing: true }), []);
  }
});

test("annotations and stickers share an explicit capability", () => {
  const draft = project({ annotations: [{ id: "text" }], stickers: [{ id: "image", dataUrl: "data:image/png;base64,unchanged" }] });
  assert.deepEqual(unsupportedVideoProjectFeatures(draft, basic), ["annotations", "stickers"]);
  assert.deepEqual(unsupportedVideoProjectFeatures(draft, { ...basic, videoAnnotationsEditing: true }), []);
});

test("preset capability is independent and never silently downgrades a saved choice", () => {
  for (const preset of ["original", "share", "small"]) {
    assert.deepEqual(unsupportedVideoProjectFeatures(project({}, preset), basic), []);
    assert.deepEqual(unsupportedVideoProjectFeatures(project({}, preset), { ...basic, videoExportPresets: false }), preset === "original" ? [] : ["presets"]);
  }
});

test("all unsupported fields are reported while source, draft and capabilities stay unchanged", () => {
  const draft = project({
    segments: [{ start: 3, end: 5, speed: 2 }, { start: 0, end: 1 }],
    effects: [{ id: "mask", kind: "mask" }],
    annotations: [{ id: "annotation" }],
    stickers: [{ id: "sticker", dataUrl: "data:image/png;base64,keep-me" }],
  }, "share");
  const caps = { ...basic, videoExportPresets: false };
  const before = JSON.stringify({ draft, caps });
  assert.deepEqual(unsupportedVideoProjectFeatures(draft, caps), ["speed", "effects", "annotations", "stickers", "presets"]);
  assert.deepEqual(unsupportedVideoProjectFeatures(draft, full), []);
  assert.equal(JSON.stringify({ draft, caps }), before);
});

test("one supported operation never enables a different operation", () => {
  for (const [flag, edit, expected] of [
    ["videoEffectsEditing", { segments: [{ start: 0, end: 10, speed: 2 }] }, "speed"],
    ["videoSpeedEditing", { effects: [{ kind: "zoom" }] }, "effects"],
    ["videoExportPresets", { annotations: [{ id: "text" }] }, "annotations"],
    ["videoEffectsEditing", { stickers: [{ id: "image" }] }, "stickers"],
  ]) assert.deepEqual(unsupportedVideoProjectFeatures(project(edit), { ...basic, [flag]: true }), [expected]);
});

test("unsupported saved projects are refused before restore or autosave can change their data", () => {
  const source = readFileSync(new URL("../src/windows/VideoTrimPlayer.tsx", import.meta.url), "utf8");
  const restore = source.slice(source.indexOf("async function restoreProject"), source.indexOf("const project=useVideoProject"));
  const refusal = restore.indexOf('throw new Error("VIDEO_PROJECT_UNSUPPORTED_FEATURES")');
  assert.ok(refusal >= 0 && refusal < restore.indexOf("new Image()"));
  assert.ok(refusal < restore.indexOf("docRef.current=project.edit"));
  const hook = readFileSync(new URL("../src/windows/useVideoProject.ts", import.meta.url), "utf8");
  assert.ok(hook.indexOf("await latest.current.restore") < hook.indexOf("createVideoProjectSaveQueue({"));
  const save = source.slice(source.indexOf("async function saveCopy()"), source.indexOf("async function cancelExport()"));
  assert.ok(save.indexOf("unsupportedVideoProjectFeatures(projectSnapshot(),capabilities)") < save.indexOf("rasterizeVideoAnnotations"));
  assert.match(save, /project\.state\.status===\"blocked\"/);
});

test("UI independently gates editing tools without gating ordinary playback speed", () => {
  const source = readFileSync(new URL("../src/windows/VideoTrimPlayer.tsx", import.meta.url), "utf8");
  assert.match(source, /capabilities\.videoSpeedEditing&&<ChoiceSelect label=\{t\("Clip speed"\)\}/);
  assert.match(source, /editing&&capabilities\.videoAnnotationsEditing&&<div className="kiri-video-annotation-editor"/);
  assert.match(source, /capabilities\.videoEffectsEditing\?<VideoEffectsControls/);
  assert.match(source, /supportsPresets=\{capabilities\.videoExportPresets\}/);
  assert.match(source, /!editing&&!props\.suspended&&<VideoPlaybackControls video=\{video\}/);
  const settings = readFileSync(new URL("../src/windows/VideoExportSettings.tsx", import.meta.url), "utf8");
  assert.match(settings, /props\.supportsPresets&&<ChoiceSelect/);
});

test("basic-editing and unsupported-project notices are translated in all languages", () => {
  for (const locale of ["en", "zh-Hans", "ja"]) {
    const strings = JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url)));
    for (const key of [
      "Basic editing: trim, delete and reorder clips at original speed.",
      "This saved edit uses features unavailable on this platform. It has been kept unchanged; you can still watch the original video.",
    ]) assert.ok(strings[key], `${locale}: ${key}`);
  }
});

test("basic editor renders trim/export controls while hiding unsupported tools", t => {
  const player = createVideoPlayerHarness(basic);
  t.after(() => player.unmount());
  assert.ok(nodes(player.render()).some(node => node?.type === "playback-controls"));
  const tree = nodes(player.openEditor());
  for (const type of ["effects-controls", "effects-overlay", "effect-tracks", "annotations-editor", "choice-select"])
    assert.equal(tree.some(node => node?.type === type), false, type);
  const panel = tree.find(node => node?.type === "export-panel");
  assert.equal(panel.props.valid, true);
  assert.equal(panel.props.supportsPresets, true);
  assert.ok(tree.some(node => node?.type === "time-input"));
  assert.ok(tree.includes("Split"));
  assert.ok(tree.includes("Delete segment"));
  assert.ok(tree.includes("Basic editing: trim, delete and reorder clips at original speed."));
});

test("full-capability editor keeps speed, effects and annotation tools", t => {
  const player = createVideoPlayerHarness(full);
  t.after(() => player.unmount());
  const tree = nodes(player.openEditor());
  for (const type of ["effects-controls", "annotations-editor", "choice-select", "effect-tracks"])
    assert.ok(tree.some(node => node?.type === type), type);
  assert.equal(tree.includes("Basic editing: trim, delete and reorder clips at original speed."), false);
});

test("Delete with no selected annotation never removes the underlying clip", t => {
  const player = createVideoPlayerHarness(full);
  t.after(() => player.unmount());
  const tree = nodes(player.openEditor());
  tree.find(node => node?.type === "annotations-editor").props.onActivate();
  player.render();
  const before = player.projectOptions().getProject();
  player.window.dispatchEvent({type: "keydown", key: "Delete", target: {closest: () => null}, preventDefault() {}});
  player.render();
  assert.deepEqual(player.projectOptions().getProject(), before);
});

test("composition and modified Delete retain the video document", t => {
  const player = createVideoPlayerHarness(full);
  t.after(() => player.unmount());
  player.openEditor();
  const before = player.projectOptions().getProject();
  for (const flags of [{isComposing: true}, {keyCode: 229}, {metaKey: true}, {ctrlKey: true}, {altKey: true}]) {
    player.window.dispatchEvent({type: "keydown", key: "Backspace", target: {closest: () => null},
      preventDefault() {}, ...flags});
    player.render();
    assert.deepEqual(player.projectOptions().getProject(), before);
  }
});

test("actual restore handler rejects unsupported saved content without replacing current state", async t => {
  const player = createVideoPlayerHarness(basic);
  t.after(() => player.unmount());
  const original = player.projectOptions().getProject();
  const unsupported = project({ effects: [{ id: "mask", kind: "mask", start: 0, end: 10 }] });
  await assert.rejects(player.projectOptions().restore(unsupported, () => true), /VIDEO_PROJECT_UNSUPPORTED_FEATURES/);
  assert.deepEqual(player.projectOptions().getProject(), original);
  assert.ok(nodes(player.render()).some(node => node?.type === "playback-controls"));
});
