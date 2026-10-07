import assert from "node:assert/strict";
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
