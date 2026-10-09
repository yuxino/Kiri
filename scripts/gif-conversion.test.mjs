import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes, settleRequests, testAsset, deferred } from "./helpers/library-render-harness.mjs";

const id = testAsset.id;
const job = { id, isConverting: true, phase: "encoding", progress: 0.42, error: null };

test("GIF feedback shows measured progress, finalization and saving", async () => {
  const harness = createLibraryHarness();
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  harness.emit("gifConversionState", job);
  let tree = library.render();
  assert.ok(nodes(tree).includes("Creating GIF… 42%"));
  assert.equal(nodes(tree).find((node) => node?.type === "progress").props.value, 0.42);
  for (const [phase, label] of [["finalizing", "Finishing GIF…"], ["saving", "Saving GIF…"]]) {
    harness.emit("gifConversionState", { ...job, phase, progress: 1 });
    assert.ok(nodes(library.render()).includes(label));
  }
  harness.emit("gifConversionState", { ...job, phase: "complete", isConverting: false, progress: null });
  assert.ok(!nodes(library.render()).some((node) => node?.type === "progress"));
  library.unmount();
});

test("GIF failures retain their reason and a retry reports immediate command failures", async () => {
  const harness = createLibraryHarness({ convertToGif: async () => { throw new Error("Source video is missing"); } });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  const failure = { ...job, isConverting: false, phase: "failed", error: "Could not write GIF: disk is full" };
  harness.emit("gifConversionState", failure);
  let tree = library.render();
  assert.ok(nodes(tree).includes(failure.error));
  const retry = nodes(tree).find((node) => node?.type === "button" && nodes(node).includes("Retry"));
  retry.props.onClick(); await settleRequests();
  tree = library.render();
  assert.ok(nodes(tree).includes("Source video is missing"));
  // The same repeated backend error must appear again after dismissing it.
  nodes(tree).find((node) => node?.type === "button" && nodes(node).includes("Close")).props.onClick();
  harness.emit("gifConversionState", failure);
  assert.ok(nodes(library.render()).includes(failure.error));
  library.unmount();
});

test("opening the library restores an active GIF without overwriting newer events", async () => {
  for (const newerEvent of [false, true]) {
    const snapshot = deferred();
    const harness = createLibraryHarness({ getGifConversionStates: () => snapshot.promise });
    const library = harness.mount("LibraryWindow", {});
    library.render(); await settleRequests();
    if (newerEvent) harness.emit("gifConversionState", { ...job, isConverting: false, phase: "complete", progress: null });
    snapshot.resolve([job]); await settleRequests();
    const tree = library.render();
    assert.equal(nodes(tree).includes("Creating GIF… 42%"), !newerEvent);
    library.unmount();
  }
});

test("GIF checking and encoding can cancel while saving cannot", async () => {
  const calls = [];
  const harness = createLibraryHarness({ cancelGifConversion: async (id) => { calls.push(id); return true; } });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  for (const phase of ["checking", "encoding", "finalizing", "saving", "cancelling"]) {
    harness.emit("gifConversionState", { ...job, phase });
    const tree = library.render();
    const cancel = nodes(tree).find((node) => node?.type === "button" && nodes(node).includes(phase === "cancelling" ? "Cancelling…" : "Cancel"));
    assert.ok(cancel);
    assert.equal(cancel.props.disabled, phase === "saving" || phase === "cancelling");
    if (phase === "checking" || phase === "encoding") {
      cancel.props.onClick(); await settleRequests();
    }
    if (phase === "checking") assert.ok(nodes(tree).includes("Checking video… 42%"));
  }
  assert.deepEqual(calls, [id, id]);
  harness.emit("gifConversionState", { ...job, isConverting: false, phase: "cancelled", progress: null, error: null });
  const tree = library.render();
  assert.ok(!nodes(tree).some((node) => node?.type === "progress"));
  assert.ok(!nodes(tree).includes("Could not create GIF"));
  library.unmount();
});

test("multiple GIF jobs have one Cancel all action and skip saving jobs", async () => {
  const calls = [];
  const harness = createLibraryHarness({cancelGifConversion: async (id) => { calls.push(id); return true; }});
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  harness.emit("gifConversionState", job);
  harness.emit("gifConversionState", {...job, id:"second", phase:"saving"});
  const tree = library.render();
  const buttons = nodes(tree).filter((node) => node?.type === "button" && nodes(node).includes("Cancel all"));
  assert.equal(buttons.length, 1);
  buttons[0].props.onClick(); await settleRequests();
  assert.deepEqual(calls, [id]);
  library.unmount();
});


test("new completion cards restore Cancel without losing a newer progress event", async () => {
  for (const newerEvent of [false, true]) {
    const snapshot = deferred();
    const calls = [];
    const interactive = [];
    const source = 'import React from "react";\n' + readFileSync(new URL("../src/windows/ToastWindow.tsx", import.meta.url), "utf8");
    const harness = createLibraryHarness({
      getGifConversionStates: () => snapshot.promise,
      cancelGifConversion: async (id) => { calls.push(id); return true; },
    }, source, {
      search: `?mode=completion&phase=processing&assetId=${id}&kind=gif`,
      modules: {
        "@tauri-apps/api/dpi": { LogicalSize: class {} },
        "@tauri-apps/api/event": { listen: async () => () => {} },
        "@tauri-apps/api/window": { getCurrentWindow: () => ({
          hide: async () => {}, setSize: async () => {},
          setIgnoreCursorEvents: async (ignore) => interactive.push(!ignore),
        }) },
      },
    });
    const toast = harness.mount("ToastWindow", {});
    toast.render(); await settleRequests();
    if (newerEvent) harness.emit("gifConversionState", {...job, phase:"cancelling"});
    snapshot.resolve([{...job, progress:null}]); await settleRequests();
    const tree = toast.render();
    const cancel = nodes(tree).find((node) => node?.type === "button" && nodes(node).includes(newerEvent ? "Cancelling…" : "Cancel"));
    assert.ok(cancel);
    assert.equal(cancel.props.disabled, newerEvent);
    assert.ok(interactive.includes(true), "native processing card must accept pointer input");
    if (!newerEvent) { cancel.props.onClick(); await settleRequests(); assert.deepEqual(calls, [id]); }
    toast.unmount();
  }
});
