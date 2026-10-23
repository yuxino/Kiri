import assert from "node:assert/strict";
import test from "node:test";
import { createVideoPlayerHarness } from "./helpers/video-player-harness.mjs";
import { deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const capabilities = Object.fromEntries([
  "videoEditing", "videoSpeedEditing", "videoEffectsEditing", "videoAnnotationsEditing", "videoExportPresets",
].map(key => [key, true]));
const sticker = () => ({ dataUrl: "data:image/png;base64,AA==", image: { naturalWidth: 100, naturalHeight: 100 } });
const hasText = (node, text) => nodes(node).includes(text);

function fixture(t, { flush = async () => true } = {}) {
  const imports = [], exports = [], saved = [];
  let close, getProject, projectOptions;
  const component = createVideoPlayerHarness(capabilities, {
    api: { exportVideoCopy: async (...args) => { exports.push(args); return "exported-video"; } },
    onClosePreparationChange: value => { if (value) close = value; },
    modules: {
      "@tauri-apps/api/window": { getCurrentWindow: () => ({
        isMaximized: async () => true, listen: async () => () => {},
      }) },
      "./video-stickers": {
        importVideoSticker: () => { const pending = deferred(); imports.push(pending); return pending.promise; },
        rasterizeVideoStickers: () => [],
      },
      "./video-annotation-render": { rasterizeVideoAnnotations: () => [] },
      "./useVideoProject": { useVideoProject: options => {
        getProject = options.getProject; projectOptions = options;
        return { ready: true, state: { status: "idle", error: null }, schedule() {},
          flush: async () => { saved.push(getProject()); return flush(); }, retry() {} };
      } },
    },
  });
  let tree = component.openEditor();
  const render = () => { tree = component.render(); return tree; };
  const annotation = () => nodes(tree).find(node => node?.type === "annotations-editor");
  const input = () => nodes(annotation().props.extraTools).find(node => node?.type === "input");
  const choose = () => input().props.onChange({ target: { files: [{}], value: "chosen-file" } });
  const panel = () => nodes(tree).find(node => node?.type === "export-panel");
  t.after(() => component.unmount());
  return { ...component, imports, exports, saved, render, choose, panel, get close() { return close; }, getProject: () => getProject(), restore: project => projectOptions.restore(project, () => true),
    async settle() { await settleRequests(); render(); await new Promise(resolve => setTimeout(resolve, 0)); render(); },
  };
}

test("a pending sticker selection is single-flight, including events before React rerenders", async t => {
  const f = fixture(t);
  f.choose(); f.choose();
  assert.equal(f.imports.length, 1);
  f.imports[0].resolve(sticker()); await f.settle();
  assert.equal(f.getProject().edit.stickers.length, 1);
});

test("pending sticker decoding blocks export and document controls without claiming an export started", async t => {
  const f = fixture(t);
  f.choose(); f.render();
  assert.equal(f.panel().props.valid, false);
  assert.equal(f.panel().props.busy, false);
  const status = nodes(f.render()).find(node => node?.props?.className === "kiri-video-project-status");
  assert.ok(hasText(status, "Loading…"));
  const reset = nodes(f.render()).find(node => node?.props?.["aria-label"] === "Reset edit");
  const leave = nodes(f.render()).find(node => node?.type === "button" && hasText(node, "Close editor"));
  assert.equal(reset.props.disabled, true);
  assert.equal(leave.props.disabled, true);
  f.panel().props.onSave(); await f.settle();
  assert.equal(f.exports.length, 0, "a stale export handler also respects pending decoding");
  f.imports[0].resolve(sticker()); await f.settle();
  assert.equal(f.panel().props.valid, true);
});

test("normal close waits for the selected sticker and flushes its completed document", async t => {
  const f = fixture(t);
  f.choose(); f.render();
  assert.equal(f.close.busy, false, "close preparation waits for import instead of showing an export dialog");
  let closed = false;
  const closing = f.close.prepareClose().then(result => { closed = result; });
  await settleRequests();
  assert.equal(closed, false);
  assert.equal(f.saved.length, 0);
  f.imports[0].resolve(sticker()); await closing;
  assert.equal(closed, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].edit.stickers.length, 1);
});

test("failed sticker decoding unlocks editing and permits retry", async t => {
  const f = fixture(t);
  f.choose(); f.imports[0].reject(new Error("decode failed")); await f.settle();
  assert.equal(f.panel().props.valid, true);
  assert.equal(f.getProject().edit.stickers.length, 0);
  f.choose(); assert.equal(f.imports.length, 2);
  f.imports[1].resolve(sticker()); await f.settle();
  assert.equal(f.getProject().edit.stickers.length, 1);
});

test("unmount discards the result of a pending sticker decode", async t => {
  const f = fixture(t);
  f.choose(); f.unmount();
  f.imports[0].resolve(sticker()); await settleRequests();
  assert.equal(f.getProject().edit.stickers.length, 0);
});


test("replacing the document while decoding discards the old sticker result", async t => {
  const f = fixture(t);
  f.choose();
  const replacement = { ...f.getProject(), edit: { ...f.getProject().edit, segments: [{ start: 2, end: 6 }] }, playhead: 2 };
  await f.restore(replacement);
  f.imports[0].resolve(sticker()); await f.settle();
  assert.deepEqual(f.getProject().edit, replacement.edit);
  assert.equal(f.panel().props.valid, true);
});


test("close continues with the unchanged document after sticker decoding fails", async t => {
  const f = fixture(t);
  f.choose(); f.render();
  const closing = f.close.prepareClose();
  f.imports[0].reject(new Error("decode failed"));
  assert.equal(await closing, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].edit.stickers.length, 0);
  assert.deepEqual(f.saved[0].edit.segments, [{ start: 0, end: 10 }]);
});

test("a failed decode from a replaced document does not show a stale sticker error", async t => {
  const f = fixture(t);
  f.choose();
  await f.restore({ ...f.getProject(), edit: { ...f.getProject().edit, segments: [{ start: 1, end: 5 }] } });
  f.imports[0].reject(new Error("decode failed")); await f.settle();
  assert.equal(nodes(f.render()).some(node => node?.props?.className === "kiri-video-sticker-error"), false);
});


test("close includes a sticker selected while the preceding project save is pending", async t => {
  const write = deferred();
  const f = fixture(t, { flush: () => write.promise });
  let closed = false;
  const closing = f.close.prepareClose().then(result => { closed = result; });
  await settleRequests();
  assert.equal(f.saved.length, 1);
  f.choose(); f.render();
  write.resolve(true); await settleRequests();
  assert.equal(closed, false, "a save result cannot close over a newly selected sticker");
  assert.equal(f.saved.length, 1, "the final save waits for decoding");
  f.imports[0].resolve(sticker()); await closing;
  assert.equal(closed, true);
  assert.equal(f.saved.length, 2);
  assert.equal(f.saved[1].edit.stickers.length, 1);
});
