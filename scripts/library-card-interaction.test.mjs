import assert from "node:assert/strict";
import test from "node:test";
import {
  createLibraryHarness,
  deferred,
  nodes,
  settleRequests,
  testAsset,
} from "./helpers/library-render-harness.mjs";

test("a failed confirmation window shows an error without dispatching deletion", async () => {
  const opened = deferred();
  let deleted = false;
  const harness = createLibraryHarness({
    showConfirmDialog: () => opened.promise,
    emptyTrash: async () => { deleted = true; },
  });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type?.name === "SegmentedPicker").props.onChange(3);
  library.render(); await settleRequests();
  nodes(library.render()).find(node => node?.type === "button" && node.props.title === "Empty Trash").props.onClick();
  opened.reject(new Error("WebView creation failed"));
  await settleRequests();
  assert.ok(nodes(library.render()).includes("Couldn't complete this action"));
  assert.equal(deleted, false);
  library.unmount();
});

import {
  getAvailableShortcutLabel,
  getLibraryBandRect,
  getLibraryCardInteraction,
  getLibraryCardPrimaryAction,
  getLibraryContentPoint,
  getLibraryMenuPosition,
  getMenuFocusIndex,
} from "../src/windows/library-card-interaction.js";

test("an ordinary card click opens without showing card actions", () => {
  assert.deepEqual(
    getLibraryCardInteraction({
      selectionActive: false,
      selected: false,
      menuOpen: false,
      editingTitle: false,
      highlighted: false,
    }),
    { opensOnClick: true, showsActions: false },
  );
});

test("pointer hover or keyboard focus reveals quick actions without changing direct-open behavior", () => {
  assert.deepEqual(
    getLibraryCardInteraction({
      selectionActive: false,
      selected: false,
      menuOpen: false,
      editingTitle: false,
      highlighted: true,
    }),
    { opensOnClick: true, showsActions: true },
  );
});

test("rubber-band selection shows actions and prevents accidental opening", () => {
  assert.deepEqual(
    getLibraryCardInteraction({
      selectionActive: true,
      selected: true,
      menuOpen: false,
      editingTitle: false,
      highlighted: false,
    }),
    { opensOnClick: false, showsActions: true },
  );
  assert.deepEqual(
    getLibraryCardInteraction({
      selectionActive: true,
      selected: false,
      menuOpen: false,
      editingTitle: false,
      highlighted: false,
    }),
    { opensOnClick: false, showsActions: false },
  );
});

test("a context menu can reveal its card actions without entering selection", () => {
  assert.deepEqual(
    getLibraryCardInteraction({
      selectionActive: false,
      selected: false,
      menuOpen: true,
      editingTitle: false,
      highlighted: false,
    }),
    { opensOnClick: false, showsActions: true },
  );
});

test("image quick action edits while media quick actions view", () => {
  assert.deepEqual(getLibraryCardPrimaryAction("image"), {
    icon: "pencil.tip",
    title: "Edit",
    opensEditor: true,
  });
  assert.deepEqual(getLibraryCardPrimaryAction("video"), {
    icon: "eye",
    title: "View",
    opensEditor: false,
  });
  assert.deepEqual(getLibraryCardPrimaryAction("gif"), {
    icon: "eye",
    title: "View",
    opensEditor: false,
  });
});

test("card menus support native arrow and edge keyboard navigation", () => {
  assert.equal(getMenuFocusIndex("ArrowDown", 0, 4), 1);
  assert.equal(getMenuFocusIndex("ArrowDown", 3, 4), 0);
  assert.equal(getMenuFocusIndex("ArrowUp", 0, 4), 3);
  assert.equal(getMenuFocusIndex("Home", 2, 4), 0);
  assert.equal(getMenuFocusIndex("End", 1, 4), 3);
  assert.equal(getMenuFocusIndex("ArrowDown", -1, 4), 0);
  assert.equal(getMenuFocusIndex("ArrowUp", -1, 4), 3);
  assert.equal(getMenuFocusIndex("ArrowDown", 0, 0), -1);
});

test("card menu placement uses its actual height and stays near the trigger", () => {
  assert.deepEqual(getLibraryMenuPosition({
    x: 400, y: 150, width: 196, height: 370, viewportWidth: 1200, viewportHeight: 800,
  }), { left: 400, top: 154 });
  assert.deepEqual(getLibraryMenuPosition({
    x: 1120, y: 720, width: 196, height: 370, viewportWidth: 1200, viewportHeight: 800,
  }), { left: 924, top: 346 });
  assert.deepEqual(getLibraryMenuPosition({
    x: 400, y: 300, width: 196, height: 500, viewportWidth: 1200, viewportHeight: 600,
  }), { left: 400, top: 90 });
});

test("rubber-band pointer coordinates do not count container padding twice", () => {
  assert.deepEqual(
    getLibraryContentPoint({
      clientX: 922,
      clientY: 460,
      rectLeft: 100,
      rectTop: 40,
      clientLeft: 1,
      clientTop: 1,
      scrollLeft: 0,
      scrollTop: 320,
    }),
    { x: 821, y: 739 },
  );
});

test("rubber-band geometry is normalized in either drag direction", () => {
  assert.deepEqual(getLibraryBandRect({ x0: 821, y0: 739, x1: 220, y1: 410 }), {
    x: 220,
    y: 410,
    w: 601,
    h: 329,
  });
});

test("empty library advertises only an available global shortcut", () => {
  assert.equal(
    getAvailableShortcutLabel({ label: "⇧⌘A", status: "enabled" }),
    "⇧⌘A",
  );
  assert.equal(
    getAvailableShortcutLabel({ label: "⇧⌘A", status: "occupied" }),
    null,
  );
  assert.equal(getAvailableShortcutLabel(null), null);
});

function cardProps(overrides = {}) {
  return {
    asset: testAsset,
    thumbnailRevision: 0,
    menuOpen: false,
    menu: null,
    selected: false,
    selectionActive: false,
    onMenu() {},
    onOpen() {},
    registerRef() {},
    onAvailability() {},
    async onRestoreMissing() {},
    onCopy() {},
    ...overrides,
  };
}

function preview(tree) {
  return nodes(tree).find((node) => node?.type === "img" || node?.type === "video");
}

for (const kind of ["image", "video", "gif"]) {
  test(`${kind} preview failure clears when updated content arrives without resetting card editing`, async () => {
    const harness = createLibraryHarness();
    const props = cardProps({ asset: { ...testAsset, kind } });
    const card = harness.mount("AssetCard", props);
    preview(card.render()).props.onError();
    await settleRequests();
    assert.ok(nodes(card.render()).includes("Preview unavailable"));

    harness.window.dispatchEvent({ type: `kiri-rename:${testAsset.id}` });
    assert.ok(nodes(card.render()).some((node) => node?.type === "input"));
    const updated = card.render({ ...props, thumbnailRevision: 1, availability: "ready" });
    assert.ok(preview(updated), "updated content must remount the preview");
    assert.ok(!nodes(updated).includes("Preview unavailable"));
    assert.ok(nodes(updated).some((node) => node?.type === "input"), "rename state must survive");
    card.unmount();
  });
}

for (const result of ["missing", "rejected"]) {
  test(`an old ${result} availability response cannot overwrite updated content`, async () => {
    const request = deferred();
    const reports = [];
    const harness = createLibraryHarness({ getAssetAvailability: () => request.promise });
    const props = cardProps({ onAvailability: (status) => reports.push(status) });
    const card = harness.mount("AssetCard", props);
    preview(card.render()).props.onError();
    card.render({ ...props, thumbnailRevision: 1, availability: "ready" });
    if (result === "rejected") request.reject(new Error("old request failed"));
    else request.resolve({ status: result });
    await settleRequests();
    assert.deepEqual(reports, []);
    assert.ok(preview(card.render()));
    card.unmount();
  });
}

test("only the newest availability request can publish a result", async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const requests = [oldRequest, newRequest];
  const reports = [];
  const harness = createLibraryHarness({ getAssetAvailability: () => requests.shift().promise });
  const card = harness.mount("AssetCard", cardProps({ onAvailability: (status) => reports.push(status) }));
  const onError = preview(card.render()).props.onError;
  onError();
  onError();
  newRequest.resolve({ status: "missing" });
  await settleRequests();
  oldRequest.resolve({ status: "ready" });
  await settleRequests();
  assert.deepEqual(reports, ["missing"]);
  assert.ok(!nodes(card.render()).includes("Preview unavailable"));
  card.unmount();
});

test("removed cards cannot publish a pending availability result", async () => {
  const request = deferred();
  const reports = [];
  const harness = createLibraryHarness({ getAssetAvailability: () => request.promise });
  const card = harness.mount("AssetCard", cardProps({ onAvailability: (status) => reports.push(status) }));
  preview(card.render()).props.onError();
  card.unmount();
  request.resolve({ status: "missing" });
  await settleRequests();
  assert.deepEqual(reports, []);
});

test("content events reject old card reports even before the next render", async () => {
  const harness = createLibraryHarness();
  const library = harness.mount("LibraryWindow", {});
  library.render();
  await settleRequests();
  const card = nodes(library.render()).find((node) => node?.type?.name === "AssetCard");
  assert.ok(card);
  harness.emit("assetContentChanged", testAsset.id);
  card.props.onAvailability("missing");
  const updated = nodes(library.render()).find((node) => node?.type?.name === "AssetCard");
  assert.equal(updated.props.thumbnailRevision, 1);
  assert.equal(updated.props.availability, "ready");
  library.unmount();
});

test("a detached preview error cannot start a check for the new revision", async () => {
  let requests = 0;
  const harness = createLibraryHarness({
    getAssetAvailability: async () => { requests++; return { status: "missing" }; },
  });
  const props = cardProps();
  const card = harness.mount("AssetCard", props);
  const oldError = preview(card.render()).props.onError;
  card.render({ ...props, thumbnailRevision: 1, availability: "ready" });
  oldError();
  await settleRequests();
  assert.equal(requests, 0);
  assert.ok(preview(card.render()));
  card.unmount();
});

for (const outcome of ["ready", "rejected"]) {
  test(`preview retry settles its busy state when the check is ${outcome}`, async () => {
    const retry = deferred();
    let calls = 0;
    const harness = createLibraryHarness({
      getAssetAvailability: () => ++calls === 1 ? Promise.resolve({ status: "ready" }) : retry.promise,
    });
    const card = harness.mount("AssetCard", cardProps());
    const firstKey = preview(card.render()).props.key;
    preview(card.render()).props.onError();
    await settleRequests();
    const retryButton = (tree) => nodes(tree).find((node) =>
      node?.type === "button" && nodes(node).includes("Retry"));
    retryButton(card.render()).props.onClick({ stopPropagation() {} });
    assert.equal(retryButton(card.render()).props.disabled, true);
    if (outcome === "ready") retry.resolve({ status: "ready" });
    else retry.reject(new Error("availability unavailable"));
    await settleRequests();
    const tree = card.render();
    if (outcome === "ready") {
      const retriedPreview = preview(tree);
      assert.ok(retriedPreview);
      assert.notEqual(retriedPreview.props.key, firstKey);
    } else {
      assert.ok(nodes(tree).includes("Preview unavailable"));
      assert.equal(retryButton(tree).props.disabled, false);
    }
    card.unmount();
  });
}

test("media drops import local paths once while an import is pending", async () => {
  const pending = deferred();
  const calls = [];
  const harness = createLibraryHarness({ importMedia: (paths) => { calls.push(paths); return pending.promise; } });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests(); library.render(); await settleRequests();
  harness.emit("mediaDrop", { payload: { type: "enter", paths: ["/fixture/photo.png"] } });
  assert.equal(calls.length, 0);
  harness.emit("mediaDrop", { payload: { type: "drop", paths: ["/fixture/photo.png"] } });
  harness.emit("mediaDrop", { payload: { type: "drop", paths: ["/fixture/other.png"] } });
  assert.deepEqual(calls, [["/fixture/photo.png"]]);
  pending.resolve({ ids: ["imported"], failed: 0 }); await settleRequests();
  const status = nodes(library.render()).find(node => node?.props?.className === "library-toast");
  assert.ok(status);
  library.unmount();
});

const savingVideo = {
  id: "saving-video", kind: "video", createdAt: new Date().toISOString(),
  duration: 125, pixelWidth: 1920, pixelHeight: 1080,
};
const saveCards = (tree) => nodes(tree).filter((node) => node?.type?.name === "RecordingSaveCard");

test("tag filtering merges case variants and toggles the same matching category", async () => {
  const harness = createLibraryHarness({ listAssets: async () => [
    { ...testAsset, id: "one", tags: ["QA"] },
    { ...testAsset, id: "two", tags: ["qa"] },
  ] });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  const filter = () => nodes(library.render()).find(node => node?.type?.name === "FilterBar");
  assert.deepEqual(filter().props.allTags, ["QA"]);
  filter().props.onToggleTag("QA");
  assert.equal(filter().props.tagFilter, "QA");
  filter().props.onToggleTag("qa");
  assert.equal(filter().props.tagFilter, null);
  library.unmount();
});

test("removing the last use of a selected tag clears its invisible filter", async () => {
  let assets = [{ ...testAsset, tags: ["Temporary"] }];
  const harness = createLibraryHarness({ listAssets: async () => assets });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  const filter = () => nodes(library.render()).find(node => node?.type?.name === "FilterBar");
  filter().props.onToggleTag("Temporary");
  assets = [{ ...testAsset, tags: [] }];
  harness.emit("libraryChanged"); await settleRequests();
  assert.equal(filter().props.tagFilter, null);
  assert.deepEqual(filter().props.allTags, []);
  assert.equal(nodes(library.render()).includes("No captures match this filter"), false);
  library.unmount();
});

test("a search with no matches keeps the selected tag visible and removable", async () => {
  const harness = createLibraryHarness({ listAssets: async (query) => query ? [] : [{ ...testAsset, tags: ["QA"] }] });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  const filter = () => nodes(library.render()).find(node => node?.type?.name === "FilterBar");
  filter().props.onToggleTag("QA");
  nodes(library.render()).find(node => node?.props?.placeholder === "Search captures").props.onChange({ target: { value: "missing" } });
  library.render(); await settleRequests();
  assert.equal(filter().props.tagFilter, "QA");
  assert.deepEqual(filter().props.allTags, ["QA"]);
  filter().props.onToggleTag("qa");
  assert.equal(filter().props.tagFilter, null);
  library.unmount();
});

test("opening the library restores saving cards and filters them by output kind", async () => {
  const savingGif = { ...savingVideo, id: "saving-gif", kind: "gif" };
  const harness = createLibraryHarness({ listAssets: async () => [], getRecordingSaveJobs: async () => [savingVideo, savingGif] });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  assert.deepEqual(saveCards(library.render()).map((node) => node.props.job.kind), ["video", "gif"]);
  const filter = () => nodes(library.render()).find((node) => node?.type?.name === "FilterBar");
  filter().props.onChangeKind("video");
  assert.deepEqual(saveCards(library.render()).map((node) => node.props.job.kind), ["video"]);
  filter().props.onChangeKind("image");
  assert.deepEqual(saveCards(library.render()), []);
  filter().props.onChangeKind("gif");
  assert.deepEqual(saveCards(library.render()).map((node) => node.props.job.kind), ["gif"]);
  filter().props.onToggleFavorites();
  assert.deepEqual(saveCards(library.render()), []);
  library.unmount();
});

test("a saving card has status metadata but no asset actions or selectable identity", () => {
  const harness = createLibraryHarness();
  const card = harness.mount("RecordingSaveCard", { job: savingVideo });
  const tree = card.render();
  assert.ok(nodes(tree).includes("Saving Recording…"));
  assert.ok(nodes(tree).includes(" · 2:05"));
  assert.ok(nodes(tree).includes(1920));
  assert.equal(tree.props["aria-busy"], "true");
  assert.equal(tree.props["data-card"], undefined);
  assert.equal(nodes(tree).filter((node) => node?.type === "button").length, 0);
  card.unmount();
});

test("a stale initial save-job reply cannot resurrect a finished recording", async () => {
  const initial = deferred();
  const harness = createLibraryHarness({ listAssets: async () => [], getRecordingSaveJobs: () => initial.promise });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  harness.emit("recordingSaveJobs", [savingVideo]);
  assert.equal(saveCards(library.render()).length, 1);
  harness.emit("recordingSaveJobs", []);
  await settleRequests();
  initial.resolve([savingVideo]); await settleRequests();
  assert.equal(saveCards(library.render()).length, 0);
  library.unmount();
});

test("the initial job snapshot refreshes a completion missed while subscriptions were opening", async () => {
  const oldAssets = deferred();
  const jobSnapshot = deferred();
  let assetCalls = 0;
  const savedVideo = { ...testAsset, kind: "video", filename: "finished.mp4" };
  const harness = createLibraryHarness({
    listAssets: () => ++assetCalls === 1 ? oldAssets.promise : Promise.resolve([savedVideo]),
    getRecordingSaveJobs: () => jobSnapshot.promise,
  });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  assert.equal(assetCalls, 1);
  // Import completes before the window receives any library-change event;
  // only an empty initial save-job snapshot remains to reveal the transition.
  jobSnapshot.resolve([]); await settleRequests();
  assert.equal(assetCalls, 2);
  const cards = () => nodes(library.render()).filter((node) => node?.type?.name === "AssetCard");
  assert.equal(cards()[0].props.asset.filename, "finished.mp4");
  oldAssets.resolve([]); await settleRequests();
  assert.equal(cards()[0].props.asset.filename, "finished.mp4");
  library.unmount();
});

test("completion keeps its saving card until real assets have refreshed", async () => {
  let reply = Promise.resolve([]);
  const harness = createLibraryHarness({ listAssets: () => reply, getRecordingSaveJobs: async () => [savingVideo] });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  assert.equal(saveCards(library.render()).length, 1);
  const completed = deferred(); reply = completed.promise;
  harness.emit("recordingSaveJobs", []); await settleRequests();
  assert.equal(saveCards(library.render()).length, 1, "retain the placeholder while final list loads");
  completed.resolve([{ ...testAsset, kind: "video", filename: "recording.mp4" }]);
  await settleRequests();
  const tree = library.render();
  assert.equal(saveCards(tree).length, 0);
  assert.equal(nodes(tree).filter((node) => node?.type?.name === "AssetCard").length, 1);
  library.unmount();
});

test("failed finalization yields the existing recovery prompt instead of an endless saving card", async () => {
  let pending = [];
  const harness = createLibraryHarness({ listAssets: async () => [], listPendingRecordings: async () => pending, getRecordingSaveJobs: async () => [savingVideo] });
  const library = harness.mount("LibraryWindow", {});
  library.render(); await settleRequests();
  assert.equal(saveCards(library.render()).length, 1);
  pending = [{ id: savingVideo.id }];
  harness.emit("recordingSaveJobs", []); await settleRequests();
  const tree = library.render();
  assert.equal(saveCards(tree).length, 0);
  assert.ok(nodes(tree).includes("%d recording is waiting to save"));
  library.unmount();
});

for (const kind of ["video", "gif"]) {
  test(`${kind} card supports direct Copy and its focused Cmd/Ctrl+C without overriding text edits`, () => {
    let copies = 0;
    const harness = createLibraryHarness();
    const card = harness.mount("AssetCard", cardProps({ asset: { ...testAsset, kind }, onCopy: () => copies++ }));
    const tree = card.render();
    const copy = nodes(tree).find((node) => node?.type === "button" && node.props["aria-label"] === "Copy");
    copy.props.onClick({ stopPropagation() {} });
    const event = { key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      target: { closest: () => null }, preventDefault() {}, stopPropagation() {} };
    tree.props.onKeyDown(event);
    tree.props.onKeyDown({ ...event, target: { closest: () => ({ tagName: "INPUT" }) } });
    assert.equal(copies, 2);
    card.unmount();
  });
}

test("library copy shortcut preserves selected text, IME, handled keys and single-copy repeats", () => {
  let copies = 0;
  const harness = createLibraryHarness();
  const card = harness.mount("AssetCard", cardProps({ asset: { ...testAsset, kind: "video" }, onCopy: () => copies++ }));
  const tree = card.render();
  const press = (overrides = {}) => {
    let prevented = false;
    tree.props.onKeyDown({ key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
      defaultPrevented: false, repeat: false, target: { closest: () => null },
      preventDefault: () => { prevented = true; }, stopPropagation() {}, ...overrides });
    return prevented;
  };
  harness.window.getSelection = () => ({ toString: () => "selected title" });
  assert.equal(press(), false, "selected titles use browser text copying");
  harness.window.getSelection = () => null;
  for (const overrides of [
    { isComposing: true }, { nativeEvent: { isComposing: true } },
    { keyCode: 229 }, { defaultPrevented: true },
    { target: { closest: () => ({ tagName: "INPUT" }) } },
  ]) assert.equal(press(overrides), false);
  assert.equal(copies, 0);
  assert.equal(press(), true);
  assert.equal(press({ repeat: true }), true);
  assert.equal(copies, 1, "holding Cmd/Ctrl+C cannot repeat file copying");
  card.unmount();
});

test("video and GIF context menus expose Copy and report a failed clipboard write", async () => {
  for (const kind of ["video", "gif"]) {
    const harness = createLibraryHarness({ listAssets: async () => [{ ...testAsset, kind }], copyAsset: async () => { throw new Error("clipboard unavailable"); } });
    const library = harness.mount("LibraryWindow", {});
    library.render(); await settleRequests();
    const card = nodes(library.render()).find((node) => node?.type?.name === "AssetCard");
    card.props.onMenu(10, 10);
    const openCard = nodes(library.render()).find((node) => node?.type?.name === "AssetCard");
    const copy = nodes(openCard.props.menu).find((node) => node?.props?.label === "Copy");
    assert.ok(copy);
    copy.props.onClick(); await settleRequests();
    assert.ok(nodes(library.render()).includes("Couldn't copy this capture."));
    library.unmount();
  }
});


test("media cards show current file size and omit unknown sizes", () => {
  const harness = createLibraryHarness();
  for (const kind of ["image", "video", "gif"]) {
    const card = harness.mount("AssetCard", cardProps());
    for (const [fileSize, label] of [
      [0, "0 B"], [999, "999 B"], [1000, "1 KB"], [12500, "12.5 KB"],
      [999950, "1 MB"], [1500000, "1.5 MB"], [2000000000, "2 GB"],
      [null, null], [undefined, null], [-1, null], [NaN, null], [Infinity, null],
    ]) {
      const tree = card.render(cardProps({ asset: { ...testAsset, kind, fileSize } }));
      const metadata = nodes(tree).find((node) => node?.type === "span" && node.props.title?.startsWith("20 × 20"));
      assert.ok(metadata);
      if (label) {
        assert.ok(nodes(metadata).includes(` · ${label}`));
        assert.ok(metadata.props.title.endsWith(`File Size: ${label}`));
      } else {
        assert.ok(!metadata.props.title.includes("File Size"));
      }
    }
    card.unmount();
  }
});


test("changing media tabs, favorites, tags, search and Trash resets the grid, while refresh keeps position", async () => {
  let resets = 0;
  const grid = {scrollTop:0,scrollLeft:0,scrollTo({top,left}) {this.scrollTop=top;this.scrollLeft=left;resets++;}};
  const assets = ["image","video","gif"].map((kind,index) => ({...testAsset,id:`asset-${index}`,kind,isFavorite:true,tags:["work"]}));
  const harness = createLibraryHarness({listAssets:async()=>assets},null,{
    attachRef(node) {if(node.props.onPointerDown && node.props.ref) node.props.ref.current=grid;},
  });
  const library = harness.mount("LibraryWindow",{});
  library.render();await settleRequests();library.render();await settleRequests();
  const change = (action) => {
    grid.scrollTop=900;grid.scrollLeft=15;
    action(library.render());library.render();
    assert.equal(grid.scrollTop,0);assert.equal(grid.scrollLeft,0);
  };
  const filter = tree => nodes(tree).find(node=>node?.type?.name==="FilterBar");
  for(const kind of ["image","video","gif","all"]) change(tree=>filter(tree).props.onChangeKind(kind));
  change(tree=>filter(tree).props.onToggleFavorites());
  change(tree=>filter(tree).props.onToggleFavorites());
  change(tree=>filter(tree).props.onToggleTag("work"));
  change(tree=>filter(tree).props.onToggleTag("work"));
  change(tree=>nodes(tree).find(node=>node?.type==="input"&&node.props.type==="search").props.onChange({target:{value:"asset"}}));
  await settleRequests();library.render();
  grid.scrollTop=450;
  const before = resets;
  harness.emit("libraryChanged");await settleRequests();library.render();
  assert.equal(grid.scrollTop,450);assert.equal(resets,before,"background changes must not jump to the top");
  change(tree=>nodes(tree).find(node=>node?.type?.name==="SegmentedPicker").props.onChange(3));
  library.unmount();
});

for (const [method,message] of [
  ["pasteClipboardImage","Clipboard image added to Library."],
  ["importMedia","Imported %d files."],
]) {
  test(`${method} success uses an automatically dismissed toast without shifting the header`, async (context) => {
    context.mock.timers.enable({apis:["setTimeout"]});
    const harness = createLibraryHarness({[method]:async()=>({id:"fixture",ids:["fixture"],failed:0})});
    const library = harness.mount("LibraryWindow",{});
    library.render();await settleRequests();library.render();await settleRequests();
    const label = method==="importMedia"?"Import media":"Paste Image";
    nodes(library.render()).find(node=>node?.type==="button"&&nodes(node).includes(label)).props.onClick();
    await settleRequests();
    const tree=library.render();
    const toast=nodes(tree).find(node=>node?.props?.className==="library-toast");
    assert.equal(toast.props.role,"status");assert.ok(nodes(toast).includes(message));
    assert.ok(!nodes(tree).some(node=>node?.props?.className==="library-import-status"));
    context.mock.timers.tick(3000);library.render();
    assert.ok(!nodes(library.render()).some(node=>node?.props?.className==="library-toast"));
    library.unmount();
  });
}

test("failed paste uses a readable error toast; a newer notice gets its own full lifetime", async (context) => {
  context.mock.timers.enable({apis:["setTimeout"]});
  const harness=createLibraryHarness({pasteClipboardImage:async()=>{throw new Error("clipboard unavailable");}});
  const library=harness.mount("LibraryWindow",{});
  library.render();await settleRequests();library.render();await settleRequests();
  nodes(library.render()).find(node=>node?.type==="button"&&nodes(node).includes("Paste Image")).props.onClick();
  await settleRequests();
  let toast=nodes(library.render()).find(node=>node?.props?.className==="library-toast");
  assert.equal(toast.props.role,"alert");
  assert.ok(nodes(toast).includes("Could not paste an image from the clipboard."));
  context.mock.timers.tick(2500);
  harness.emit("notice",{id:"new",title:"Copied",symbol:"checkmark"});library.render();
  context.mock.timers.tick(1500);library.render();
  assert.ok(nodes(library.render()).includes("Copied"));
  context.mock.timers.tick(1500);library.render();
  assert.ok(!nodes(library.render()).some(node=>node?.props?.className==="library-toast"));
  library.unmount();
});
