import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createLibraryHarness, deferred, nodes, settleRequests, testAsset } from "./helpers/library-render-harness.mjs";
import * as viewerState from "../src/windows/viewer-state.js";
import { installVideoProjectShortcuts } from "../src/windows/video-project-shortcuts.js";
import { createVideoProjectSaveQueue } from "../src/windows/video-project-save.js";

const readSource = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const viewerSource = readSource("../src/windows/ViewerWindow.tsx");
const guardSource = readSource("../src/windows/VideoCloseGuard.tsx");
const playerSource = readSource("../src/windows/VideoTrimPlayer.tsx");
const projectHookSource = readSource("../src/windows/useVideoProject.ts");
const projectModule = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(
  readSource("../src/windows/video-project.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText).toString("base64")}`);
const closeRegistrationStart = playerSource.indexOf("  const flushProject=useCallback");
assert.notEqual(closeRegistrationStart, -1);
const closeRegistrationEnd = playerSource.indexOf("\n\n  useEffect", closeRegistrationStart);
assert.ok(closeRegistrationEnd > closeRegistrationStart);
const closeRegistrationSource = playerSource.slice(closeRegistrationStart, closeRegistrationEnd);
assert.match(closeRegistrationSource, /onClosePreparationChange/);
// Use production Viewer, Guard and the player's close-registration hook slice.
// The media/codec body is omitted; rendered player presence owns registration.
const source = 'import React from "react";\n' + viewerSource +
  '\nimport {installVideoProjectShortcuts} from "./video-project-shortcuts.js";\n' +
  '\nimport {createVideoProjectSaveQueue} from "./video-project-save.js";\n' +
  '\nimport {hasVideoEdits} from "./video-project";\n' +
  projectHookSource.replace(/^import\s[\s\S]*?;\s*/gm, "") +
  guardSource.replace(/^import\s[\s\S]*?;\s*/gm, "") +
  '\nexport function PlayerCloseRegistration(props) {\n' +
  'const savedProject=useVideoProject({id:props.id,enabled:props.useRealProject,duration:3,getProject:props.getProject,restore:async()=>{}});\n' +
  'useEffect(()=>{if(savedProject.ready)savedProject.schedule();},[savedProject.ready,savedProject.schedule,props.snapshot]);\n' +
  'const exporting=props.busy,project=props.useRealProject?savedProject:{flush:props.flush,validateSource:props.validateSource};\n' +
  'const saving=useRef(props.busy);saving.current=props.busy;\n' +
  'const commitAnnotation=useRef(null),textDraft=useRef(null),stickerImport=useRef(null);\n' +
  closeRegistrationSource + '\nreturn flushProject;\n}\n';
const playerType = "test-video-player";
const guardType = "test-video-close-guard";
const closeEvent = "tauri://close-requested";

/** Model the Rust close veto and registry; execute the installed JS SDK itself. */
function nativeWindowModel() {
  let nextCallback = 0, nextEvent = 0, destroyed = false;
  const callbacks = new Map(), registrations = new Map(), pendingUnlistens = [];
  const calls = { close: 0, destroy: 0, veto: 0, listen: 0, unlisten: 0 };
  let delayUnlisten = false;
  const metadata = { currentWindow: { label: `viewer-${testAsset.id}` } };
  const matchingListeners = () => [...registrations.entries()].filter(([, entry]) =>
    entry.event === closeEvent && entry.target.label === metadata.currentWindow.label);
  const destroy = () => { if (!destroyed) { destroyed = true; calls.destroy++; } };
  return {
    calls,
    get listenerCount() { return matchingListeners().length; },
    get pendingUnlistenCount() { return pendingUnlistens.length; },
    delayUnlisten() { delayUnlisten = true; },
    finishUnlistens() { pendingUnlistens.splice(0).forEach(finish => finish()); },
    internals: {
      metadata,
      transformCallback(callback) { const id = ++nextCallback; callbacks.set(id, callback); return id; },
      async invoke(command, args) {
        if (command === "plugin:event|listen") {
          calls.listen++;
          const id = ++nextEvent;
          registrations.set(id, args);
          return id;
        }
        if (command === "plugin:event|unlisten") {
          calls.unlisten++;
          const remove = () => registrations.delete(args.eventId);
          if (!delayUnlisten) { remove(); return; }
          return new Promise(resolve => pendingUnlistens.push(() => { remove(); resolve(); }));
        }
        if (command === "plugin:window|destroy") { destroy(); return; }
        if (command === "plugin:window|close") {
          calls.close++;
          const listeners = matchingListeners();
          if (!listeners.length) { destroy(); return; }
          calls.veto++;
          for (const [id, entry] of listeners) {
            await callbacks.get(entry.handler)?.({ event: closeEvent, id, payload: null });
          }
          return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    },
    eventInternals: {
      // Tauri event._unlisten removes the JS callback before awaiting the Rust
      // unlisten IPC. Rust may still veto close while that IPC is outstanding.
      unregisterListener(_event, id) { callbacks.delete(registrations.get(id)?.handler); },
    },
  };
}

async function fixture(t, options = {}) {
  const previousWindow = globalThis.window;
  const native = nativeWindowModel();
  let availability = "ready", prepareCalls = 0;
  const asset = { ...testAsset, kind: options.kind ?? "video", filename: options.filename ?? "fixture.mp4",
    duration: options.kind === "image" ? null : 3 };
  let nextAssetLoad = null;
  let playerMounts = 0;
  let snapshot = { schemaVersion: 1, sourceSize: { width: 1920, height: 1080 }, sourceDuration: 3,
    edit: { segments: [{ start: 0, end: 3 }], effects: [], annotations: [], stickers: [] }, preset: "original", playhead: 0 };
  let savedProject = null, savedRevision = "base";
  const writes = [];
  const getProject = () => snapshot;
  let guard = null, playerRegistration = null, playerKey = null, tree, player;
  const playerFlushes = new Set();
  const guardOptions = { busy: false, prepareClose: async () => true, validateSource: async () => true, ...options };
  const flush = async () => { prepareCalls++; return guardOptions.prepareClose(); };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const h = createLibraryHarness({
    getAsset: async () => { const pending = nextAssetLoad; nextAssetLoad = null; return pending ?? asset; },
    getAssetAvailability: async () => ({ status: availability }),
    restoreMissingAsset: async () => true,
    platformCapabilities: async () => ({ videoEditing: true }),
    loadVideoProject: async () => options.sourceChanged?.()
      ? { state: "invalid", reason: "sourceChanged", revision: "changed", project: savedProject }
      : { state: savedProject ? "valid" : "none", revision: savedRevision, project: savedProject },
    saveVideoProject: (id, revision, project) => {
      const request = deferred(); writes.push({ id, revision, project, ...request });
      return request.promise.then(result => { savedRevision = result.revision; savedProject = project; return result; });
    },
  }, source, {
    modules: {
      "@tauri-apps/api/window": { getCurrentWindow },
      "./VideoTrimPlayer": { VideoTrimPlayer: playerType },
      "./VideoCloseGuard": { VideoCloseGuard: guardType },
      "./viewer-state.js": viewerState,
      "./video-project-shortcuts.js": { installVideoProjectShortcuts },
      "./video-project-save.js": { createVideoProjectSaveQueue },
      "./video-project": projectModule,
    },
    attachRef(node) { if (node.type === "dialog") node.props.ref.current = dialog; },
  });
  Object.assign(h.window, { __TAURI_INTERNALS__: native.internals, __TAURI_EVENT_PLUGIN_INTERNALS__: native.eventInternals });
  globalThis.window = h.window;
  const viewer = h.mount("ViewerWindow", { id: testAsset.id });
  function render() {
    // Reconcile child effects, then reflect their registration in Viewer props.
    for (let pass = 0; pass < 2; pass++) {
      tree = viewer.render();
      player = nodes(tree).find(node => node.type === playerType);
      if (!player || (playerRegistration && player.props.key !== playerKey)) {
        playerRegistration?.unmount(); playerRegistration = null;
      }
      if (player && !playerRegistration) {
        playerMounts++;
        playerKey = player.props.key;
        playerRegistration = h.mount("PlayerCloseRegistration", {});
      }
      if (playerRegistration) playerFlushes.add(playerRegistration.render({
        busy: guardOptions.busy, flush, validateSource: guardOptions.validateSource, onClosePreparationChange: player.props.onClosePreparationChange,
        id: testAsset.id, useRealProject: options.useRealProject ?? false, getProject, snapshot,
      }));
      const guardNode = nodes(tree).find(node => node.type === guardType);
      assert.ok(guardNode, "Viewer renders its persistent close guard in every content state");
      guard ??= h.mount("VideoCloseGuard", {});
      guard.render(guardNode.props);
    }
    return tree;
  }
  async function settle() { await settleRequests(); render(); await settleRequests(); render(); }
  function assertPersistentGuard() {
    assert.equal(native.listenerCount, 1);
    assert.equal(native.calls.listen, 1, "the window keeps its original close listener");
    assert.equal(native.calls.unlisten, 0, "media state never unregisters that listener");
    assert.equal(native.pendingUnlistenCount, 0);
  }
  function delayNextLoad() {
    const load = deferred(); nextAssetLoad = load.promise;
    t.after(() => load.resolve(asset));
    return async () => { load.resolve(asset); await settle(); assert.ok(player); assertPersistentGuard(); };
  }
  async function beginRestore() {
    availability = "ready";
    const finish = delayNextLoad();
    const message = nodes(tree).find(node => node.props?.title === "File missing");
    const restoreButton = nodes(message?.props.actions).find(node => node.props?.children?.includes("Restore File…"));
    assert.ok(restoreButton, "missing viewer exposes restore");
    restoreButton.props.onClick(); await settle();
    assert.ok(player?.props.suspended, "loading keeps the existing save queue mounted");
    assert.ok(nodes(tree).some(node => node.props?.title === "Loading…"));
    assertPersistentGuard();
    return finish;
  }
  t.after(async () => {
    viewer.unmount(); playerRegistration?.unmount(); guard?.unmount();
    await settleRequests(); native.finishUnlistens(); await settleRequests();
    globalThis.window = previousWindow;
  });
  render(); await settle();
  if (asset.kind === "video") assert.ok(player, "fixture starts with a ready video");
  else assert.ok(nodes(tree).some(node => node.type === "img"), "fixture starts with a ready image/GIF");
  assert.equal(native.listenerCount, 1, "production guard registers through the real SDK");
  return {
    native, guardOptions, dialog,
    get prepareCalls() { return prepareCalls; },
    get playerFlushCount() { return playerFlushes.size; },
    get playerMounts() { return playerMounts; },
    get mediaRevision() { return player?.props.mediaRevision; },
    get suspended() { return player?.props.suspended; },
    writes,
    edit() { snapshot = { ...snapshot, edit: { ...snapshot.edit, segments: [{ start: 1, end: 2 }] } }; render(); },
    contentChanged() { h.emit("assetContentChanged", testAsset.id); render(); },
    retry() {
      const message = nodes(tree).find(node => node.props?.title === "Couldn't play this video.");
      const button = nodes(message?.props.actions).find(node => node.props?.children?.includes("Retry"));
      assert.ok(button); button.props.onClick();
    },
    settle,
    beginRestore,
    async mediaFailure(status) {
      availability = status;
      player.props.onError();
      await settle();
      assert.ok(player?.props.suspended, "the failed player keeps its close preparation and pending edits");
      assert.equal(native.calls.listen, 1, "media failure does not replace the Viewer close listener");
      assert.equal(native.calls.unlisten, 0, "the Viewer guard survives player cleanup");
      assert.ok(nodes(tree).some(node => node.props?.title ===
        (status === "missing" ? "File missing" : status === "libraryUnavailable" ? "Library unavailable" :
          status === "unreadable" ? "Can't read this file" : "Couldn't play this video.")));
    },
    async restore() {
      const finish = await beginRestore(); await finish();
      assert.ok(player, "restoring the file registers the new player");
    },
    async close(action) {
      if (action === "native") {
        await getCurrentWindow().close();
      } else if (action === "X") {
        if (player) player.props.onClose();
        else {
          const button = nodes(tree).find(node => node.type === "button" && node.props["aria-label"] === "Close · Esc");
          assert.ok(button, "unavailable viewer exposes its close button");
          button.props.onClick();
        }
      } else {
        const event = { type: "keydown", key: action === "Escape" ? "Escape" : "w",
          metaKey: action === "Cmd+W", ctrlKey: action === "Ctrl+W", altKey: false, shiftKey: false,
          repeat: false, isComposing: false, defaultPrevented: false, cancelBubble: false,
          target: { closest: () => null },
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; },
        };
        h.window.dispatchThroughTarget(event, () => {});
        assert.equal(event.defaultPrevented, true);
      }
      await settle();
    },
  };
}

for (const action of ["X", "Escape", "Cmd+W", "Ctrl+W"]) {
  test(`missing video ${action} closes without detaching its native guard`, async t => {
    const f = await fixture(t);
    f.native.delayUnlisten();
    await f.mediaFailure("missing");
    assert.equal(f.native.pendingUnlistenCount, 0);
    assert.equal(f.native.listenerCount, 1, "the Viewer listener remains registered");
    await f.close(action);
    assert.equal(f.native.calls.destroy, 1, "the Viewer guard permits close after pending edits save");
    assert.equal(f.prepareCalls, 1, "unavailable media still flushes its retained player");
  });
}

for (const status of ["ready", "missing", "unreadable", "libraryUnavailable"]) {
  test(`${status} media failure retains a pending edit until its real autosave queue flushes`, async t => {
    const f = await fixture(t, { useRealProject: true });
    f.edit();
    assert.equal(f.writes.length, 0, "the edit is still inside the debounce interval");
    await f.mediaFailure(status);
    await f.close("native");
    assert.equal(f.writes.length, 1, "failure must not dispose the pending project");
    assert.deepEqual(f.writes[0].project.edit.segments, [{ start: 1, end: 2 }]);
    assert.equal(f.native.calls.destroy, 0, "close waits for the write acknowledgement");
    f.writes[0].resolve({ state: "valid", revision: "saved" }); await f.settle();
    assert.equal(f.native.calls.destroy, 1);
    assert.equal(f.playerMounts, 1);
  });
}

test("failed autosave after media failure retains the draft and requires a successful retry", async t => {
  const f = await fixture(t, { useRealProject: true });
  f.edit(); await f.mediaFailure("ready"); await f.close("X");
  f.writes[0].reject(new Error("VIDEO_PROJECT_IO")); await f.settle();
  assert.equal(f.native.calls.destroy, 0); assert.equal(f.dialog.open, true);
  await f.close("native");
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].revision, "base", "failure does not advance the saved revision");
  assert.deepEqual(f.writes[1].project.edit.segments, [{ start: 1, end: 2 }]);
  f.writes[1].resolve({ state: "valid", revision: "retried" }); await f.settle();
  assert.equal(f.native.calls.destroy, 1);
});

test("same-source decoder retry waits for autosave and preserves the mounted editor", async t => {
  const f = await fixture(t, { useRealProject: true });
  f.edit(); await f.mediaFailure("ready");
  const revision = f.mediaRevision;
  f.retry(); await f.settle();
  assert.equal(f.writes.length, 1);
  assert.equal(f.suspended, true); assert.equal(f.mediaRevision, revision);
  f.writes[0].resolve({ state: "valid", revision: "saved" }); await f.settle();
  assert.equal(f.suspended, false); assert.equal(f.mediaRevision, revision + 1);
  assert.equal(f.playerMounts, 1, "decoder recovery does not replace the project owner");
  await f.close("native");
  assert.equal(f.writes.length, 1, "close still recognizes the acknowledged draft");
  assert.equal(f.native.calls.destroy, 1);
});

test("a changed video source cannot silently reload the old project", async t => {
  let changed = false;
  const f = await fixture(t, { useRealProject: true, sourceChanged: () => changed });
  changed = true; f.contentChanged();
  const revision = f.mediaRevision;
  f.retry(); await f.settle();
  assert.equal(f.suspended, true); assert.equal(f.mediaRevision, revision);
  assert.equal(f.playerMounts, 1); assert.equal(f.writes.length, 0);
  await f.close("native");
  assert.equal(f.native.calls.destroy, 1, "an unchanged draft can still close without overwriting the source");
});

for (const [filename, action] of [
  ["fixture.png", "X"], ["fixture.png", "native"],
  ["fixture.gif", "X"], ["fixture.gif", "Escape"],
]) {
  test(`ready ${filename} ${action} closes without video preparation or a dialog`, async t => {
    // These would block a registered video, but images/GIFs register neither.
    const f = await fixture(t, { kind: "image", filename, busy: true, prepareClose: async () => false });
    await f.close(action);
    assert.equal(f.native.calls.destroy, 1); assert.equal(f.prepareCalls, 0);
    assert.equal(f.dialog.open, false);
  });
}

for (const status of ["unreadable", "libraryUnavailable", "ready"]) {
  test(`${status} playback failure remains closable with the persistent native listener`, async t => {
    const f = await fixture(t);
    f.native.delayUnlisten(); await f.mediaFailure(status); await f.close("X");
    assert.equal(f.native.calls.destroy, 1);
    assert.equal(f.prepareCalls, 1);
  });
}

test("missing video native title-bar close cannot be stranded by player cleanup", async t => {
  const f = await fixture(t);
  f.native.delayUnlisten(); await f.mediaFailure("missing"); await f.close("native");
  assert.equal(f.native.calls.destroy, 1);
});

test("restoring video's loading state keeps the native guard and flushes before close", async t => {
  const f = await fixture(t);
  await f.mediaFailure("missing");
  const finishRestore = await f.beginRestore();
  await f.close("native");
  assert.equal(f.native.calls.destroy, 1); assert.equal(f.prepareCalls, 2);
  await finishRestore();
});

test("failed and restored video keeps one native close listener", async t => {
  const f = await fixture(t);
  f.native.delayUnlisten(); await f.mediaFailure("missing");
  await f.restore(); await f.settle();
  assert.equal(f.native.listenerCount, 1);
  assert.equal(f.native.calls.listen, 1); assert.equal(f.native.calls.unlisten, 0);
  await f.close("X");
  assert.equal(f.native.calls.destroy, 1);
});

test("ready video close waits for saving and closes only after it succeeds", async t => {
  const save = deferred();
  const f = await fixture(t, { prepareClose: () => save.promise });
  await f.close("X");
  assert.equal(f.prepareCalls, 1); assert.equal(f.native.calls.destroy, 0);
  await f.close("Escape");
  assert.equal(f.prepareCalls, 1, "repeated requests do not start a second save");
  save.resolve(true); await f.settle();
  assert.equal(f.native.calls.destroy, 1);
});

for (const action of ["X", "native"]) {
  test(`ready video ${action} save failure keeps its close confirmation`, async t => {
    const f = await fixture(t, { prepareClose: async () => false });
    await f.close(action);
    assert.equal(f.prepareCalls, 1); assert.equal(f.native.calls.destroy, 0);
    assert.equal(f.dialog.open, true);
  });

  test(`ready video export blocks ${action} close without attempting autosave`, async t => {
    const f = await fixture(t, { busy: true });
    await f.close(action);
    assert.equal(f.prepareCalls, 0); assert.equal(f.native.calls.destroy, 0);
    assert.equal(f.dialog.open, true);
  });
}

test("player flush stays stable across parent renders and busy registration changes", async t => {
  const f = await fixture(t);
  await f.settle(); f.guardOptions.busy = true; await f.settle();
  f.guardOptions.busy = false; await f.settle();
  assert.equal(f.playerFlushCount, 1);
  assert.equal(f.native.calls.listen, 1);
  assert.equal(f.native.calls.unlisten, 0);
});

test("player failure retains its export block before native close", async t => {
  const f = await fixture(t, { busy: true, prepareClose: async () => false });
  await f.mediaFailure("missing"); await f.close("native");
  assert.equal(f.native.calls.destroy, 0); assert.equal(f.prepareCalls, 0);
  assert.equal(f.dialog.open, true);
});

for (const action of ["X", "Escape", "Cmd+W", "Ctrl+W"]) {
  test(`restored ready video ${action} uses its current save guard`, async t => {
    const f = await fixture(t);
    await f.mediaFailure("missing"); await f.restore();
    f.guardOptions.prepareClose = async () => false;
    await f.close(action);
    assert.equal(f.prepareCalls, 2, "restoration must retain the same save guard");
    assert.equal(f.native.calls.destroy, 0); assert.equal(f.dialog.open, true);
  });
}
