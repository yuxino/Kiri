import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {RecordingAnnotationPublisher, recordingInkMarks} from "../src/windows/recording-annotation-publisher.js";
import {createLibraryHarness, deferred, nodes, settleRequests} from "./helpers/library-render-harness.mjs";

const frame = number => ({marks: [{kind: "pen", id: number, points: [{x: number, y: 0}], color: "cherry", width: 3}],
  canUndo: true, canRedo: false, hasMarks: true});
function harness() {
  const timers = new Map(), sends = [], errors = [];
  let id = 0;
  const publisher = new RecordingAnnotationPublisher((revision, value) => {
    const job = deferred(); sends.push({revision, value, ...job}); return job.promise;
  }, failed => errors.push(failed), (callback, delay) => {
    assert.equal(delay, 34); timers.set(++id, callback); return id;
  }, id => timers.delete(id));
  return {publisher, sends, errors, timers,
    async tick() {for (const [id, callback] of [...timers]) {timers.delete(id); callback();} await settleRequests();}};
}

test("live publishing replaces queued drafts, serializes IPC and preserves the final frame", async () => {
  const h = harness();
  h.publisher.push(frame(1)); h.publisher.push(frame(2));
  await h.tick(); assert.equal(h.sends.length, 1); assert.deepEqual(h.sends[0].value, frame(2));
  h.publisher.push(frame(3)); h.publisher.push(frame(4)); await h.tick();
  assert.equal(h.sends.length, 1, "slow IPC cannot queue unbounded drawing updates");
  h.sends[0].resolve(); await settleRequests(); await h.tick();
  assert.deepEqual(h.sends[1].value, frame(4)); assert.equal(h.sends[1].revision, 2);
  h.sends[1].resolve(); await settleRequests(); h.publisher.push(frame(4)); await h.tick();
  assert.equal(h.sends.length, 2, "unchanged remote re-renders never echo ink");
  h.publisher.dispose();
});

test("failed publishing reports the failure and an explicit retry sends the same current frame", async () => {
  const h = harness(); h.publisher.push(frame(1)); await h.tick();
  h.sends[0].reject(new Error("unavailable")); await settleRequests();
  assert.deepEqual(h.errors, [true]); assert.equal(h.timers.size, 0, "errors do not spin");
  h.publisher.push(frame(1)); await h.tick(); assert.equal(h.sends.length, 2);
  h.sends[1].resolve(); await settleRequests(); assert.deepEqual(h.errors, [true, false]);
  h.publisher.dispose();
});

test("unmount cancels queued work and in-flight completion cannot publish again", async () => {
  const h = harness(); h.publisher.push(frame(1)); await h.tick(); h.publisher.push(frame(2));
  h.publisher.dispose(); h.sends[0].resolve(); await settleRequests(); await h.tick();
  assert.equal(h.sends.length, 1); assert.deepEqual(h.errors, []); assert.equal(h.timers.size, 0);
});

test("stop drains the pending 34ms frame immediately and waits for IPC", async () => {
  const h = harness(); h.publisher.push(frame(9));
  let complete = false;
  const drained = h.publisher.drain().then(revision => {complete = true; return revision;});
  await settleRequests();
  assert.equal(h.timers.size, 0, "stop bypasses the debounce timer");
  assert.equal(h.sends.length, 1); assert.deepEqual(h.sends[0].value, frame(9));
  assert.equal(complete, false, "a queued frame is not a native acknowledgement");
  h.sends[0].resolve(); assert.equal(await drained, 1);
  h.publisher.dispose();
});

test("stop drains the final frame after an already in-flight draft without a second timer", async () => {
  const h = harness(); h.publisher.push(frame(1)); await h.tick(); h.publisher.push(frame(2));
  const drained = h.publisher.drain(); await settleRequests(); assert.equal(h.sends.length, 1);
  h.sends[0].resolve(); await settleRequests();
  assert.equal(h.timers.size, 0); assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[1].value, frame(2)); h.sends[1].resolve();
  assert.equal(await drained, 2); h.publisher.dispose();
});

test("failed or disposed final flush rejects instead of reporting painted ink", async () => {
  const h = harness(); h.publisher.push(frame(1));
  const drained = h.publisher.drain(); await settleRequests();
  const rejection = assert.rejects(drained, /final annotation frame/);
  h.sends[0].reject(new Error("closed")); await rejection;
  h.publisher.dispose(); await assert.rejects(h.publisher.drain(), /closed/);
});

test("draining an already failed publication cannot acknowledge its revision", async () => {
  const h = harness(); h.publisher.push(frame(1)); await h.tick();
  h.sends[0].reject(new Error("closed")); await settleRequests();
  await assert.rejects(h.publisher.drain(), /final annotation frame/);
  h.publisher.dispose();
});

test("recorded ink contains supported marks and positive stable draft identities", () => {
  const pen = frame(12).marks[0], draft = {...pen, id: -1};
  const marks = recordingInkMarks([pen, {kind: "mosaic", id: 2}, {kind: "text", id: 3, text: "   "}], draft);
  assert.equal(marks.length, 2); assert.equal(marks[0], pen);
  assert.equal(marks[1].id, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(draft.id, -1, "normalization never mutates editor identity");
});

const inputSource = 'import React from "react";\n' + readFileSync(new URL("../src/windows/RecordingAnnotationWindow.tsx", import.meta.url), "utf8") + "\nexport {RecordingInput, RecordingInk};";
const snapshot = {sessionId: "recording-1", supported: true, available: true, ready: true, error: null,
  tool: "pen", canUndo: false, canRedo: false, hasMarks: false, marks: [], revision: 5};
const appearance = {colorPreset: "cherry", penWidth: 3, shapeWidth: 3, textFontSize: 18, textBackgroundStyle: "transparent"};
function input(options = {}) {
  const updates = [], calls = [], preferences = [], selections = [], timers = new Map(), paints = new Map(), flushes = [];
  let action, styling, flushing, id = 0;
  const editing = {commits: true, cancelled: false};
  const canvas = {
    clearAnnotations: () => calls.push("clear"), cancelInteraction: () => {calls.push("cancel"); return editing.cancelled;},
    undo: () => calls.push("undo"), redo: () => calls.push("redo"),
    commitTextEditing: () => {calls.push("commit"); return editing.commits;}, clearSelection: () => calls.push("deselect"),
    updateSelectionAppearance: (patch, transient) => calls.push({patch, transient}),
    finishAppearanceAdjustment: () => calls.push("finish"), deleteSelection: () => calls.push("delete"),
    editSelectedText: () => calls.push("editText"),
  };
  const h = createLibraryHarness({}, inputSource, {
    globals: {HTMLElement: class {}},
    requestAnimationFrame: callback => {paints.set(++id, callback); return id;},
    cancelAnimationFrame: id => paints.delete(id),
    attachRef(node) {if (node.type === "annotation-canvas") node.props.ref.current = canvas;},
    modules: {
      "../annotation/AnnotationCanvas": {default: "annotation-canvas", __esModule: true},
      "../annotation/render": {drawMark() {}},
      "../annotation/useAnnotationAppearance": {useAnnotationAppearance: () => [appearance, value => preferences.push(value), options.appearanceReady !== false]},
      "./useRecordingAnnotations": {useRecordingAnnotations: () => ({state: snapshot, failed: false})},
      "./recording-annotation-publisher.js": {recordingInkMarks, RecordingAnnotationPublisher: class extends RecordingAnnotationPublisher {
        constructor(send, onError) {super(send, onError, callback => {timers.set(++id, callback); return id;}, id => timers.delete(id));}
      }},
      "../lib/ipc": {
        api: {
          recordingAnnotationsReady: async session => calls.push(`ready:${session}`),
          updateRecordingAnnotations: async (...args) => updates.push(args),
          setRecordingAnnotationTool: async (...args) => calls.push(args),
          recordingAnnotationsFlushed: async (...args) => flushes.push(args),
        },
        onRecordingAnnotationAction: async callback => {action = callback; return () => {action = null;};},
        onRecordingAnnotationAppearance: async callback => {styling = callback; return () => {styling = null;};},
        onRecordingAnnotationFlush: async callback => {flushing = callback; return () => {flushing = null;};},
        onRecordingAnnotationPresent: async () => () => {},
        emitRecordingAnnotationSelection: async (...args) => selections.push(args),
      },
    },
  });
  const props = {sessionId: snapshot.sessionId, state: {...snapshot, ...options.state}, size: {width: 640, height: 360}};
  const component = h.mount("RecordingInput", props); component.render();
  return {component, calls, updates, preferences, selections, flushes, editing, props, window: h.window,
    action: event => action?.(event), styling: event => styling?.(event),
    flush: event => flushing?.(event),
    canvasProps: () => nodes(component.render()).find(node => node.type === "annotation-canvas").props,
    async tick() {await settleRequests(); for (const [id, callback] of [...timers]) {timers.delete(id); callback();} await settleRequests();},
    async paint() {component.render(); for (const [id, callback] of [...paints]) {paints.delete(id); callback();} await settleRequests();},
  };
}

test("input subscribes before ready, publishes from the hydrated revision and does not echo remote ink", async () => {
  const h = input(); await h.tick();
  assert.deepEqual(h.calls, ["ready:recording-1"]);
  assert.equal(h.updates[0][1], 6);
  h.canvasProps().onLiveMarks(frame(12).marks, null); await h.tick();
  const count = h.updates.length;
  h.component.render({...h.props, state: {...snapshot, revision: 7, marks: frame(12).marks}}); await h.tick();
  assert.equal(h.updates.length, count, "the input owns history; its own relayed frame is not reloaded");
  h.action({sessionId: "old-recording", action: "clear"}); assert.equal(h.calls.includes("clear"), false);
  h.action({sessionId: "recording-1", action: "clear"}); assert.equal(h.calls.at(-1), "clear");
  h.action({sessionId: "recording-1", action: "editText"}); assert.equal(h.calls.at(-1), "editText");
  h.action({sessionId: "recording-1", action: "delete"}); assert.equal(h.calls.at(-1), "delete");
  h.component.unmount();
});

test("selection and explicit same-color styling cross the window boundary without duplicate history", async () => {
  const h = input(); await h.tick();
  h.canvasProps().onSelectionInfo(frame(12).marks[0], false); await settleRequests();
  assert.equal(h.selections.at(-1)[1].id, 12);
  h.styling({sessionId: "recording-1", patch: {colorPreset: "cherry"}, transient: false, finish: false});
  assert.deepEqual(h.calls.at(-1), {patch: {colorPreset: "cherry"}, transient: false});
  h.styling({sessionId: "recording-1", patch: {penWidth: 8}, transient: true, finish: false});
  h.styling({sessionId: "recording-1", patch: {penWidth: 9}, transient: true, finish: false});
  h.styling({sessionId: "recording-1", patch: {}, transient: false, finish: true});
  assert.equal(h.calls.filter(call => call === "finish").length, 1);
  const count = h.calls.length;
  h.styling({sessionId: "old-recording", patch: {penWidth: 12}, transient: true, finish: true});
  assert.equal(h.calls.length, count);
  h.component.unmount();
});

test("desktop mode hides chrome, commits finished text and retains an active IME draft", async () => {
  for (const commits of [true, false]) {
    const h = input(); await h.tick(); h.editing.commits = commits;
    const tree = h.component.render({...h.props, state: {...snapshot, tool: "desktop"}});
    assert.equal(tree.props["data-active"], undefined);
    assert.equal(h.calls.includes("cancel"), commits);
    assert.deepEqual(h.selections.at(-1), ["recording-1", null, false]);
    h.component.unmount();
  }
});

test("early surface creation waits for native availability before its first publication", async () => {
  const h = input({state: {available: false}}); await h.tick(); assert.equal(h.updates.length, 0);
  h.component.render({...h.props, state: {...snapshot, available: true}}); await h.tick();
  assert.equal(h.updates.length, 1); h.component.unmount();
});

test("stop request commits then flushes the last rendered frame and ignores older sessions", async () => {
  const h = input(); await h.tick(); const before = h.updates.length;
  h.flush({sessionId: "old-recording", requestId: "old-stop"});
  assert.equal(h.calls.includes("commit"), false);
  h.canvasProps().onLiveMarks(frame(25).marks, null);
  const interactionLock = h.canvasProps().interactionLock;
  assert.equal(interactionLock.locked, false);
  h.flush({sessionId: "recording-1", requestId: "stop-1"});
  assert.equal(h.calls.includes("commit"), true);
  assert.equal(interactionLock.locked, true, "pointer interaction is frozen before React rerenders");
  assert.equal(h.canvasProps().interactionDisabled, true);
  const callCount = h.calls.length;
  h.action({sessionId: "recording-1", action: "delete"});
  h.styling({sessionId: "recording-1", patch: {penWidth: 8}, transient: false, finish: true});
  assert.equal(h.calls.length, callCount, "late UI events cannot change a frozen frame");
  await h.paint(); await h.paint();
  assert.equal(h.updates.length, before + 1, "stop sends without ticking the pending 34ms publisher timer");
  assert.deepEqual(h.updates.at(-1)[2], frame(25).marks);
  assert.deepEqual(h.flushes, [["recording-1", "stop-1", h.updates.at(-1)[1]]]);
  h.flush({sessionId: "recording-1", requestId: "duplicate-stop"}); await h.paint();
  assert.equal(h.flushes.length, 1);
  h.component.unmount();
});

test("ink acknowledges only after the requested revision arrives and crosses a browser paint", async () => {
  const frames = new Map(), presented = [], rendered = [];
  let id = 0, present;
  const context = {setTransform() {}, clearRect() {}, save() {}, restore() {}};
  const canvas = {width: 0, height: 0, getContext: () => context};
  const h = createLibraryHarness({}, inputSource, {
    requestAnimationFrame: callback => {frames.set(++id, callback); return id;},
    cancelAnimationFrame: id => frames.delete(id),
    attachRef(node) {if (node.type === "canvas") node.props.ref.current = canvas;},
    modules: {
      "../annotation/AnnotationCanvas": {default: "annotation-canvas", __esModule: true},
      "../annotation/render": {drawMark: mark => rendered.push(mark.id)},
      "../annotation/useAnnotationAppearance": {}, "./useRecordingAnnotations": {},
      "./recording-annotation-publisher.js": {recordingInkMarks, RecordingAnnotationPublisher},
      "../lib/ipc": {
        onRecordingAnnotationPresent: async callback => {present = callback; return () => {};},
        api: {recordingAnnotationsReady: async () => {},
          recordingAnnotationsPresented: async (...args) => presented.push(args)},
      },
    },
  });
  const props = {sessionId: snapshot.sessionId, state: snapshot, size: {width: 640, height: 360}};
  const component = h.mount("RecordingInk", props); component.render(); await settleRequests(); component.render();
  present({sessionId: "old-recording", requestId: "old-stop", revision: 5}); component.render();
  assert.equal(frames.size, 0);
  present({sessionId: snapshot.sessionId, requestId: "stop-1", revision: 6}); component.render();
  assert.equal(frames.size, 0, "the target ink snapshot has not arrived yet");
  component.render({...props, state: {...snapshot, revision: 6, marks: frame(42).marks}});
  assert.deepEqual(rendered, [42]); assert.equal(presented.length, 0);
  for (const [id, callback] of [...frames]) {frames.delete(id); callback();}
  assert.equal(presented.length, 0, "drawing in the layout effect precedes actual browser paint");
  for (const [id, callback] of [...frames]) {frames.delete(id); callback();}
  await settleRequests(); assert.deepEqual(presented, [[snapshot.sessionId, "stop-1", 6]]);
  canvas.getContext = () => null;
  present({sessionId: snapshot.sessionId, requestId: "stop-2", revision: 7});
  component.render({...props, state: {...snapshot, revision: 7, marks: frame(43).marks}});
  assert.equal(frames.size, 0, "a missing drawing context is not a painted acknowledgement");
  assert.equal(presented.length, 1);
  component.unmount();
});
