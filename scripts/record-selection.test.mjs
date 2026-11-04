import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests, testAsset } from "./helpers/library-render-harness.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const button = (tree, text) => nodes(tree).find(node => node?.type === "button" && nodes(node).includes(text));
const boxes = tree => nodes(tree).filter(node => node?.type === "input" && node.props.type === "checkbox");
const search = tree => nodes(tree).find(node => node?.props?.type === "search");
for (const [name, path, list] of [["TextHistory", "ocr/TextHistory", "listOcrRecords"], ["QrFavorites", "qr/QrResults", "listQrFavorites"]]) {
  const source = 'import React from "react";\n' + readFileSync(new URL(`../src/${path}.tsx`, import.meta.url), "utf8");
  const records = ["one", "two", "three"].map(id => ({ ...testAsset, id, ocrText: id, qrText: id }));
  test(`${name}: filtered all, individual selection, atomic deletion, failure retry and duplicate guard`, async () => {
    let items = records, pending = deferred(); const calls = [];
    const harness = createLibraryHarness({ [list]: async query => items.filter(item => item.id.includes(query)),
      batchMoveToTrash: ids => { calls.push(ids); return pending.promise; } }, source);
    const component = harness.mount(name); component.render(); await pause(5);
    search(component.render()).props.onChange({ target: { value: "t" } });
    let tree = component.render();
    assert.equal(button(tree, "Select records").props.disabled, true);
    await pause(170);
    button(component.render(), "Select records").props.onClick();
    button(component.render(), "Select All").props.onClick();
    tree = component.render();
    const preview = nodes(tree).find(node => node?.type?.name === (name === "TextHistory" ? "TextReader" : "QrDetails"));
    assert.ok(preview, "batch selection retains the current reading preview");
    assert.equal(preview.props[name === "TextHistory" ? "actionsDisabled" : "disabled"], true);
    assert.equal(boxes(tree).length, 2); assert.ok(boxes(tree).every(box => box.props.checked));
    button(tree, "Deselect All").props.onClick();
    tree = component.render(); assert.ok(boxes(tree).every(box => !box.props.checked));
    boxes(tree)[0].props.onChange(); tree = component.render();
    const remove = button(tree, "Move to Trash (1)"); remove.props.onClick(); remove.props.onClick();
    tree = component.render(); assert.equal(calls.length, 1); assert.equal(search(tree).props.disabled, true);
    assert.ok(boxes(tree).every(box => box.props.disabled));
    pending.reject(new Error("offline")); await settleRequests(); tree = component.render();
    assert.equal(boxes(tree)[0].props.checked, true);
    assert.ok(nodes(tree).includes("Couldn't move these records to Trash. Try again."));
    pending = deferred(); button(tree, "Move to Trash (1)").props.onClick();
    items = records.filter(item => item.id !== "two"); pending.resolve(); await settleRequests();
    tree = component.render(); assert.ok(button(tree, "Select records")); assert.ok(nodes(tree).includes("Moved to Trash"));
    assert.deepEqual(calls, [["two"], ["two"]]); component.unmount();
  });
  test(`${name}: query changes clear selection, refresh prunes records, and keyboard respects text inputs`, async () => {
    let items = records;
    const harness = createLibraryHarness({ [list]: async () => items }, source);
    const component = harness.mount(name); component.render(); await pause(5);
    button(component.render(), "Select records").props.onClick();
    const event = (key, editable = false) => ({ key, metaKey: true, target: { closest: () => editable }, preventDefault() {}, stopPropagation() {} });
    component.render().props.onKeyDown(event("a", true));
    assert.ok(boxes(component.render()).every(box => !box.props.checked));
    component.render().props.onKeyDown(event("a"));
    assert.ok(boxes(component.render()).every(box => box.props.checked));
    items = records.slice(1); harness.emit("libraryChanged"); component.render(); await pause(5);
    assert.ok(button(component.render(), "Move to Trash (2)"));
    search(component.render()).props.onChange({ target: { value: "new" } });
    assert.equal(boxes(component.render()).length, 0);
    await pause(170); assert.ok(button(component.render(), "Select records"));
    button(component.render(), "Select records").props.onClick();
    component.render().props.onKeyDown(event("Escape"));
    assert.equal(boxes(component.render()).length, 0); component.unmount();
  });
  test(`${name}: shortcuts work with document focus and keep native text/IME behavior`, async () => {
    const harness = createLibraryHarness({ [list]: async () => records }, source);
    const component = harness.mount(name); component.render(); await pause(5);
    button(component.render(), "Select records").props.onClick(); component.render();
    const key = (key, extra = {}) => harness.window.dispatchEvent({ type: "keydown", key,
      ctrlKey: true, target: { closest: () => false }, preventDefault() {}, stopPropagation() {}, ...extra });
    key("a", { target: { closest: () => true } });
    assert.ok(boxes(component.render()).every(box => !box.props.checked));
    key("a", { isComposing: true });
    assert.ok(boxes(component.render()).every(box => !box.props.checked));
    key("a"); assert.ok(boxes(component.render()).every(box => box.props.checked));
    key("Escape"); assert.equal(boxes(component.render()).length, 0);
    component.unmount();
  });
  if (name === "TextHistory") test("OCR editing prevents entering batch selection", async () => {
    const harness = createLibraryHarness({ [list]: async () => records }, source);
    const component = harness.mount(name); component.render(); await pause(5);
    const reader = nodes(component.render()).find(node => node?.type?.name === "TextReader");
    button(reader.props.actions, "Edit Text").props.onClick();
    assert.equal(button(component.render(), "Select records").props.disabled, true); component.unmount();
  });
}
