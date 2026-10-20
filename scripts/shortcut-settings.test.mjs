import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes } from "./helpers/library-render-harness.mjs";

const source = `import React from "react";\n${readFileSync(new URL("../src/settings/ShortcutsSettings.tsx", import.meta.url), "utf8")}\nexport { ShortcutReference };`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = () => ["capture", "record", "ocr", "library", "recordingPauseResume", "recordingStop"].map((action, index) => ({
  action, label: ["⇧⌘A", "⇧⌥⌘R", "⇧⌥⌘O", "⇧⌥⌘L", "⇧⌥⌘P", "⇧⌥⌘S"][index],
  defaultLabel: ["⇧⌘A", "⇧⌥⌘R", "⇧⌥⌘O", "⇧⌥⌘L", "⇧⌥⌘P", "⇧⌥⌘S"][index],
  scope: index < 4 ? "global" : "recording", status: index < 4 ? "enabled" : "inactive", isDefault: true,
}));
const text = (tree) => nodes(tree).filter((node) => typeof node === "string").join(" ");
const row = (tree, action) => nodes(tree).find((node) => node?.props?.["data-action"] === action);
const recorder = (tree, action = "capture") => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-recorder");
const resetButton = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-reset");
const clearButton = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-clear");
const retryButton = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-retry");
const cancelButton = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-cancel");
const applyButton = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-shortcut-apply");
const controls = (tree, action) => nodes(row(tree, action)).find((node) => node?.props?.className === "kiri-global-shortcut__controls");
const recordingInstruction = (tree) => nodes(tree).find((node) => node?.props?.id === "shortcut-recording-instruction");
function harness(overrides = {}, initial = snapshot(), environment = {}) {
  let recorded, changed, disposed = 0, settingsDisposed = 0;
  const calls = [];
  const editing = [];
  let runtime;
  const button = { focus() { runtime.document.activeElement = this; } };
  const api = {
    getShortcutSettings: async () => initial,
    setCaptureShortcutEditing: async (value) => { editing.push(value); },
    setActionShortcut: async (action, shortcut) => { calls.push([action, shortcut]); return initial; },
    resetActionShortcut: async (action) => { calls.push([action, "reset"]); return initial; },
    retryActionShortcut: async (action) => { calls.push([action, "retry"]); return initial; },
    ...overrides,
  };
  runtime = createLibraryHarness({}, source, { ...environment, document: { activeElement: button }, modules: {
    "../lib/ipc": {
      api,
      onShortcutRecorded: (handler) => { recorded = handler; return Promise.resolve(() => { disposed++; }); },
      onShortcutSettingsChanged: (handler) => { changed = handler; return Promise.resolve(() => { settingsDisposed++; }); },
    },
    "../i18n": { t: (key) => key, fmt: (key, ...args) => { let index = 0; return key.replace(/%@/g, () => args[index++]); } },
    "lucide-react": { Info: "info-icon", RotateCcw: "reset-icon", X: "clear-icon" },
    "./PortalShortcutsCard": { PortalShortcutsCard: "portal-shortcuts" },
  } });
  const page = runtime.mount("ShortcutsSettings");
  page.render();
  return { page, runtime, calls, editing, button, emit: (value) => recorded(value), change: (value) => changed(value), disposed: () => disposed, settingsDisposed: () => settingsDisposed };
}

async function begin(ui, action = "capture") {
  recorder(ui.page.render(), action).props.onClick({ currentTarget: ui.button });
  await tick();
  assert.equal(recorder(ui.page.render(), action).props["aria-pressed"], true);
}
function key(props = {}) {
  return { key: "q", code: "KeyQ", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false,
    nativeEvent: { isComposing: false }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
}

test("default bindings expose edit and clear directly without unnecessary reset controls or menus", async () => {
  const ui = harness(); await tick(); const tree = ui.page.render();
  for (const { action, label } of snapshot()) {
    const actionRow = row(tree, action);
    const title = nodes(actionRow).find((node) => node?.type === "strong");
    assert.ok(recorder(tree, action).props["aria-label"].endsWith(label));
    assert.equal(clearButton(tree, action).props["aria-label"], `Clear shortcut for ${text(title)}`);
    assert.equal(clearButton(tree, action).props.disabled, false);
    assert.equal(resetButton(tree, action), undefined);
    assert.equal(retryButton(tree, action), undefined);
    assert.equal(cancelButton(tree, action), undefined);
    assert.equal(nodes(actionRow).some((node) => node?.props?.role === "menu" || node?.props?.["aria-haspopup"]), false);
  }
  assert.equal(recordingInstruction(tree).props["aria-hidden"], true);
  assert.deepEqual(ui.editing, [false]);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});

test("recording ignores IME, repeat, and modifiers but saves a valid physical letter once", async () => {
  const ui = harness(); await tick(); await begin(ui, "ocr");
  const onKeyDown = recorder(ui.page.render(), "ocr").props.onKeyDown;
  for (const event of [key({ repeat: true, ctrlKey: true }), key({ nativeEvent: { isComposing: true }, ctrlKey: true }), key({ nativeEvent: { isComposing: false, keyCode: 229 }, ctrlKey: true }), key({ key: "Control", code: "ControlLeft" })]) onKeyDown(event);
  assert.deepEqual(ui.calls, []);
  onKeyDown(key({ shiftKey: true }));
  assert.ok(applyButton(ui.page.render(), "ocr"));
  assert.deepEqual(ui.calls, [], "Shift-only input is a pending candidate, not an invalid key or an implicit save");
  onKeyDown(key({ ctrlKey: true, shiftKey: true }));
  onKeyDown(key({ ctrlKey: true, shiftKey: true }));
  await tick();
  assert.deepEqual(ui.calls, [["ocr", "Control+Shift+KeyQ"]]);
  assert.equal(recorder(ui.page.render(), "ocr").props["aria-pressed"], false);
  ui.page.unmount(); await tick();
});

test("modified digits on non-US layouts record the physical key without inventing a Super modifier", async () => {
  // Shift+Digit1 may produce punctuation instead of a digit. Windows and X11
  // still need the physical digit and the actual Control/Alt/Shift modifiers.
  for (const symbol of ["!", "&"]) {
    const ui = harness(); await tick(); await begin(ui, "recordingStop");
    recorder(ui.page.render(), "recordingStop").props.onKeyDown(key({
      key: symbol, code: "Digit1", ctrlKey: true, altKey: true, shiftKey: true,
    }));
    await tick();
    assert.deepEqual(ui.calls, [["recordingStop", "Control+Alt+Shift+Digit1"]]);
    assert.equal(recorder(ui.page.render(), "recordingStop").props["aria-pressed"], false);
    assert.equal(ui.editing.at(-1), false);
    ui.page.unmount(); await tick();
  }
});

test("Tab cancels without swallowing focus navigation and Escape cancels without saving", async () => {
  const ui = harness(); await tick(); await begin(ui);
  const tab = key({ key: "Tab", code: "Tab" }); recorder(ui.page.render()).props.onKeyDown(tab);
  assert.equal(tab.prevented, false); assert.equal(recorder(ui.page.render()).props["aria-pressed"], false);
  await tick(); await begin(ui);
  const escape = key({ key: "Escape", code: "Escape" }); recorder(ui.page.render()).props.onKeyDown(escape);
  assert.equal(escape.prevented, true); await tick(); assert.deepEqual(ui.calls, []);
  assert.equal(ui.editing.at(-1), false); ui.page.unmount(); await tick();
});

test("a registered native chord targets the edited action and keeps a duplicate error beside its prior binding", async () => {
  const calls = [];
  const ui = harness({ setActionShortcut: async (action, shortcut) => { calls.push([action, shortcut]); throw "This shortcut is already assigned to another action."; } });
  await tick(); await begin(ui, "library");
  ui.emit({ action: "record", shortcut: "shift+alt+super+KeyR" });
  ui.emit({ action: "record", shortcut: "shift+alt+super+KeyR" });
  await tick(); const tree = ui.page.render();
  assert.deepEqual(calls, [["library", "shift+alt+super+KeyR"]]);
  assert.ok(text(row(tree, "library")).includes("This shortcut is already assigned to another action."));
  assert.ok(recorder(tree, "library").props["aria-label"].endsWith("⇧⌥⌘L"));
  assert.equal(recorder(tree, "record").props.disabled, false);
  ui.page.unmount(); await tick();
});

test("clearing a custom binding waits for native success and then removes the old key without implying it is retained", async () => {
  const states = snapshot().map((item) => item.action === "record" ? { ...item, label: "⌃Q", isDefault: false } : item);
  const save = deferred(); const calls = [];
  const ui = harness({ setActionShortcut: (action, shortcut) => { calls.push([action, shortcut]); return save.promise; } }, states);
  await tick(); const clear = clearButton(ui.page.render(), "record");
  clear.props.onClick(); clear.props.onClick(); await tick();
  assert.deepEqual(calls, [["record", null]]);
  assert.equal(recorder(ui.page.render(), "record").props.disabled, true);
  assert.equal(clearButton(ui.page.render(), "record").props.disabled, true);
  assert.ok(recorder(ui.page.render(), "record").props["aria-label"].endsWith("⌃Q"));
  save.resolve(states.map((item) => item.action === "record" ? { ...item, label: null, status: "disabled", isDefault: false } : item));
  await tick(); const tree = ui.page.render();
  assert.ok(recorder(tree, "record").props["aria-label"].endsWith("Not set"));
  assert.equal(text(recorder(tree, "record")), "Set shortcut");
  assert.equal(text(row(tree, "record")).includes("⌃Q"), false);
  assert.equal(clearButton(tree, "record"), undefined);
  assert.ok(resetButton(tree, "record").props.title.includes("⇧⌥⌘R"));
  resetButton(tree, "record").props.onClick(); await tick();
  assert.deepEqual(ui.calls, [["record", "reset"]], "restoring the default uses its explicit native operation");
  ui.page.unmount(); await tick();
});

test("a cleared binding can record a new key without restoring its former custom key", async () => {
  const states = snapshot().map((item) => item.action === "record" ? { ...item, label: null, status: "disabled", isDefault: false } : item);
  const ui = harness({}, states); await tick(); await begin(ui, "record");
  const tree = ui.page.render();
  assert.equal(text(recorder(tree, "record")), "Press shortcut…");
  assert.equal(resetButton(tree, "record").props.disabled, true, "default restoration cannot interrupt recording");
  assert.equal(clearButton(tree, "record"), undefined);
  assert.ok(cancelButton(tree, "record"));
  recorder(tree, "record").props.onKeyDown(key({ ctrlKey: true, altKey: true }));
  await tick();
  assert.deepEqual(ui.calls, [["record", "Control+Alt+KeyQ"]]);
  assert.equal(ui.editing.at(-1), false);
  ui.page.unmount(); await tick();
});

test("a failed clear keeps the native custom binding and reports the failure only in its row", async () => {
  const states = snapshot().map((item) => item.action === "capture" ? { ...item, label: "⌃Q", isDefault: false } : item);
  const ui = harness({ setActionShortcut: async () => { throw "Could not save the shortcuts."; } }, states);
  await tick(); clearButton(ui.page.render(), "capture").props.onClick(); await tick();
  const tree = ui.page.render();
  assert.ok(recorder(tree).props["aria-label"].endsWith("⌃Q"));
  assert.ok(clearButton(tree, "capture"));
  assert.equal(recorder(tree).props.disabled, false);
  for (const {action} of states) {
    const alerts = nodes(row(tree, action)).filter((node) => node?.props?.role === "alert");
    assert.equal(alerts.length, action === "capture" ? 1 : 0);
    if (alerts.length) assert.equal(text(alerts[0]), "Could not save the shortcuts.");
  }
  ui.page.unmount(); await tick();
});

test("leaving the page during delayed interception serializes release after acquisition", async () => {
  const gate = deferred(); const calls = [];
  const ui = harness({ setCaptureShortcutEditing: (value) => { calls.push(value); return value ? gate.promise : Promise.resolve(); } });
  await tick(); recorder(ui.page.render()).props.onClick({ currentTarget: ui.button }); await tick();
  assert.deepEqual(calls, [false, true]);
  ui.page.unmount(); await tick();
  assert.deepEqual(calls, [false, true], "release waits for the pending acquisition");
  gate.resolve(); await tick();
  assert.deepEqual(calls, [false, true, false]);
  assert.equal(ui.disposed(), 1);
  ui.emit({ action: "capture", shortcut: "shift+super+KeyA" });
  assert.deepEqual(ui.calls, []);
});

test("window blur cancels recording and native events no longer mutate settings", async () => {
  const ui = harness(); await tick(); await begin(ui, "record");
  ui.runtime.window.dispatchEvent({ type: "blur" });
  ui.emit({ action: "capture", shortcut: "shift+super+KeyA" }); await tick();
  assert.deepEqual(ui.calls, []); assert.equal(ui.editing.at(-1), false);
  assert.equal(recorder(ui.page.render(), "record").props["aria-pressed"], false);
  ui.page.unmount(); await tick();
});

test("Wayland provides all six commands without claiming scoped registration and retains the opt-in Portal panel", async () => {
  const ui = harness({}, snapshot().map((item) => ({ ...item, status: "systemManaged" })));
  await tick(); const tree = ui.page.render();
  for (const command of ["kiri --capture", "kiri --record", "kiri --ocr", "kiri --library", "kiri --toggle-recording-pause", "kiri --stop-recording"]) assert.ok(text(tree).includes(command));
  assert.equal(recorder(tree), undefined);
  assert.equal(text(tree).includes("Only active while recording."), false);
  assert.ok(nodes(tree).some((node) => node?.type === "portal-shortcuts"));
  ui.page.unmount(); await tick();
});

test("keycaps preserve textual platform modifiers and individual macOS symbols", () => {
  const ui = harness();
  const keys = ui.runtime.mount("ShortcutKeys", { label: "Shift+Alt+Ctrl+R" });
  assert.equal(text(keys.render()), "Shift Alt Ctrl R");
  assert.equal(text(keys.render({ label: "⇧⌥⌘R" })), "⇧ ⌥ ⌘ R");
  ui.page.unmount();
});


test("custom and occupied shortcuts expose only applicable direct actions without replacing the configured key", async () => {
  const states = snapshot().map((item) => item.action === "capture" ? { ...item, label: "⌃Q", isDefault: false }
    : item.action === "record" ? { ...item, status: "occupied" } : item);
  const ui = harness({}, states); await tick(); const tree = ui.page.render();
  assert.ok(clearButton(tree, "capture"));
  assert.equal(retryButton(tree, "capture"), undefined);
  assert.ok(resetButton(tree, "capture").props.title.includes("⇧⌘A"), "the reset previews the default without replacing the custom chord");
  assert.ok(recorder(tree).props["aria-label"].endsWith("⌃Q"));
  assert.ok(clearButton(tree, "record"));
  assert.equal(resetButton(tree, "record"), undefined);
  const retry = retryButton(tree, "record");
  assert.equal(text(retry), "Retry");
  const feedback = nodes(row(tree, "record")).find((node) => node?.props?.className === "kiri-shortcut-feedback");
  assert.ok(nodes(feedback).includes(retry));
  assert.ok(recorder(tree, "record").props["aria-describedby"].split(" ").includes(feedback.props.id));
  retry.props.onClick(); await tick();
  assert.deepEqual(ui.calls, [["record", "retry"]]);
  assert.ok(recorder(ui.page.render(), "record").props["aria-label"].endsWith("⇧⌥⌘R"));
  ui.page.unmount(); await tick();
});

test("retry waits for native status and leaves a still-occupied binding available to edit or clear", async () => {
  const states = snapshot().map((item) => item.action === "recordingStop" ? { ...item, status: "occupied", label: "⌃Q", isDefault: false } : item);
  const pending = deferred(); const calls = [];
  const ui = harness({ retryActionShortcut: (action) => { calls.push(action); return pending.promise; } }, states);
  await tick(); const retry = retryButton(ui.page.render(), "recordingStop");
  retry.props.onClick(); retry.props.onClick(); await tick();
  assert.deepEqual(calls, ["recordingStop"]);
  assert.equal(retryButton(ui.page.render(), "recordingStop").props.disabled, true);
  assert.equal(clearButton(ui.page.render(), "recordingStop").props.disabled, true);
  pending.resolve(states); await tick();
  const tree = ui.page.render();
  assert.ok(text(row(tree, "recordingStop")).includes("This shortcut is in use by another app."));
  assert.ok(recorder(tree, "recordingStop").props["aria-label"].endsWith("⌃Q"));
  assert.equal(recorder(tree, "recordingStop").props.disabled, false);
  assert.equal(clearButton(tree, "recordingStop").props.disabled, false);
  assert.equal(retryButton(tree, "recordingStop").props.disabled, false);
  ui.page.unmount(); await tick();
});

test("recording shortcuts form a separate group and remain editable while inactive", async () => {
  const ui = harness(); await tick(); const tree = ui.page.render();
  const groups = nodes(tree).filter((node) => node?.props?.["data-shortcut-scope"]);
  assert.deepEqual(groups.map((group) => nodes(group).filter((node) => node?.props?.["data-action"]).map((node) => node.props["data-action"])),
    [["capture", "record", "ocr", "library"], ["recordingPauseResume", "recordingStop"]]);
  assert.ok(text(groups[0]).includes("Launch actions"));
  assert.ok(text(groups[1]).includes("While recording"));
  assert.equal(nodes(groups[1]).find((node) => node?.type === "h3").props.title, "Only active while recording.");
  for (const action of ["recordingPauseResume", "recordingStop"]) {
    assert.equal(recorder(tree, action).props.disabled, false);
    assert.equal(nodes(row(tree, action)).some((node) => ["alert", "status"].includes(node?.props?.role)), false);
    assert.equal(resetButton(tree, action), undefined);
    assert.equal(retryButton(tree, action), undefined);
    assert.ok(clearButton(tree, action));
  }
  await begin(ui, "recordingPauseResume");
  recorder(ui.page.render(), "recordingPauseResume").props.onKeyDown(key({ key: "p", code: "KeyP", ctrlKey: true, altKey: true, shiftKey: true }));
  await tick();
  assert.deepEqual(ui.calls, [["recordingPauseResume", "Control+Alt+Shift+KeyP"]]);
  const reference = ui.runtime.mount("ShortcutReference");
  assert.equal(text(reference.render()).includes("Recording controls"), false);
  assert.equal(text(reference.render()).includes("Pause/Resume Recording"), false);
  ui.page.unmount(); await tick();
});

test("in-app reference groups expose their headings and keys without requiring disclosure controls", () => {
  const ui = harness();
  const reference = ui.runtime.mount("ShortcutReference");
  const tree = reference.render();
  const groups = nodes(tree).filter((node) => node?.props?.className === "kiri-shortcut-reference__group");
  assert.equal(groups.length, 4);
  for (const group of groups) {
    const heading = nodes(group).find((node) => node?.type === "h3");
    assert.equal(group.props["aria-labelledby"], heading.props.id);
    assert.ok(nodes(group).some((node) => node?.type === "dt"));
    assert.ok(nodes(group).some((node) => node?.type === "dd" && node.props["aria-label"]));
  }
  assert.equal(nodes(tree).some((node) => node?.type === "details" || node?.type === "summary"), false);
  reference.unmount(); ui.page.unmount();
});

test("native recording changes update scoped status and dispose their subscription", async () => {
  const ui = harness(); await tick();
  ui.change(snapshot().map((item) => item.scope === "recording" ? { ...item, status: "occupied" } : item));
  assert.ok(text(row(ui.page.render(), "recordingStop")).includes("This shortcut is in use by another app."));
  assert.ok(retryButton(ui.page.render(), "recordingStop"));
  ui.change(snapshot());
  assert.equal(text(row(ui.page.render(), "recordingStop")).includes("This shortcut is in use by another app."), false);
  assert.equal(retryButton(ui.page.render(), "recordingStop"), undefined);
  ui.page.unmount(); await tick();
  assert.equal(ui.settingsDisposed(), 1);
  ui.change(snapshot().map((item) => ({ ...item, status: "occupied" })));
  assert.deepEqual(ui.calls, []);
});

test("a late initial fetch cannot overwrite a newer native shortcut update", async () => {
  const pending = deferred();
  const ui = harness({ getShortcutSettings: () => pending.promise });
  ui.change(snapshot().map((item) => item.action === "recordingStop" ? { ...item, status: "occupied" } : item));
  pending.resolve(snapshot()); await tick();
  assert.ok(text(row(ui.page.render(), "recordingStop")).includes("This shortcut is in use by another app."));
  ui.page.unmount(); await tick();
});


test("a pending shortcut save cannot overwrite newer recording registration status", async () => {
  const pending = deferred();
  const ui = harness({ setActionShortcut: () => pending.promise });
  await tick(); await begin(ui, "recordingStop");
  recorder(ui.page.render(), "recordingStop").props.onKeyDown(key({ ctrlKey: true, altKey: true, shiftKey: true }));
  await tick();
  ui.change(snapshot().map((item) => item.action === "recordingStop" ? { ...item, status: "occupied", label: "⌃⌥⇧Q", isDefault: false } : item));
  pending.resolve(snapshot().map((item) => item.action === "recordingStop" ? { ...item, label: "⌃⌥⇧Q", isDefault: false } : item));
  await tick();
  assert.ok(text(row(ui.page.render(), "recordingStop")).includes("This shortcut is in use by another app."));
  assert.ok(recorder(ui.page.render(), "recordingStop").props["aria-label"].endsWith("⌃⌥⇧Q"));
  ui.page.unmount(); await tick();
});


test("editing shows an honest recording prompt without a fake caret and cancellation restores the prior key", async () => {
  const states = snapshot().map((item) => item.action === "capture" ? { ...item, label: "⌃Q", isDefault: false } : item);
  const ui = harness({}, states); await tick();
  const idle = ui.page.render();
  const idleControls = nodes(row(idle, "capture")).find((node) => node?.props?.className === "kiri-global-shortcut__controls");
  const idleInstruction = recordingInstruction(idle);
  assert.equal(idleInstruction.props["aria-hidden"], true);
  await begin(ui, "capture");
  const tree = ui.page.render();
  const actionRow = row(tree, "capture");
  const field = nodes(actionRow).find((node) => node?.props?.className === "kiri-shortcut-field");
  const controls = nodes(actionRow).find((node) => node?.props?.className === "kiri-global-shortcut__controls");
  const instruction = recordingInstruction(tree);
  assert.equal(field.props["data-editing"], true);
  assert.equal(text(recorder(tree)), "Press shortcut…", "the recording button asks for input instead of pretending the prior key is editable text");
  assert.equal(nodes(recorder(tree)).some((node) => node?.props?.className === "kiri-shortcut-caret"), false);
  assert.ok(recorder(tree).props["aria-label"].endsWith("⌃Q"), "the persisted binding remains available to assistive technology");
  assert.equal(nodes(tree).some((node) => node?.props?.className === "kiri-shortcut-editor" || node?.props?.role === "menu"), false);
  assert.equal(nodes(controls).filter((node) => node?.type === "button").length,
    nodes(idleControls).filter((node) => node?.type === "button").length, "cancel replaces the clear control in the same field");
  assert.equal(instruction.props.id, idleInstruction.props.id);
  assert.equal(instruction.props["aria-hidden"], false);
  assert.equal(nodes(actionRow).includes(instruction), false, "one shared instruction serves the active row");
  assert.ok(recorder(tree).props["aria-describedby"].split(" ").includes(instruction.props.id));
  assert.ok(text(instruction).includes("Press a key or combination. Esc cancels."));
  assert.equal(clearButton(tree, "capture"), undefined);
  assert.equal(resetButton(tree, "capture").props.disabled, true);
  assert.equal(ui.runtime.document.activeElement, ui.button);
  const cancel = cancelButton(tree, "capture");
  assert.ok(nodes(field).includes(cancel));
  assert.equal(cancel.props["aria-label"], "Cancel");
  assert.equal(text(cancel), "Esc");
  cancel.props.onClick(); await tick();
  const cancelled = ui.page.render();
  assert.equal(recorder(cancelled).props["aria-pressed"], false);
  assert.equal(text(recorder(cancelled)), "⌃Q");
  assert.equal(recordingInstruction(cancelled).props["aria-hidden"], true);
  assert.ok(clearButton(cancelled, "capture"));
  assert.equal(cancelButton(cancelled, "capture"), undefined);
  assert.equal(ui.editing.at(-1), false);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});

test("custom and disabled shortcuts expose a direct restore button that waits for native success", async () => {
  const states = snapshot().map((item) => item.action === "capture" ? { ...item, label: "⌃Q", isDefault: false }
    : item.action === "recordingStop" ? { ...item, status: "disabled", label: null, isDefault: false } : item);
  const pending = deferred(); const calls = [];
  const ui = harness({ resetActionShortcut: (action) => { calls.push(action); return pending.promise; } }, states);
  await tick();
  const tree = ui.page.render();
  for (const action of ["capture", "recordingStop"]) {
    assert.ok(resetButton(tree, action));
    assert.equal(resetButton(tree, action).props.disabled, false);
    assert.ok(resetButton(tree, action).props.title.includes(states.find((item) => item.action === action).defaultLabel));
  }
  assert.equal(resetButton(tree, "ocr"), undefined);
  resetButton(tree, "recordingStop").props.onClick();
  resetButton(tree, "recordingStop").props.onClick(); await tick();
  assert.deepEqual(calls, ["recordingStop"]);
  assert.equal(resetButton(ui.page.render(), "recordingStop").props.disabled, true);
  assert.ok(recorder(ui.page.render(), "recordingStop").props["aria-label"].endsWith("Not set"));
  pending.resolve(snapshot()); await tick();
  assert.equal(resetButton(ui.page.render(), "recordingStop"), undefined);
  assert.ok(recorder(ui.page.render(), "recordingStop").props["aria-label"].endsWith("⇧⌥⌘S"));
  ui.page.unmount(); await tick();
});

test("an unidentified physical key reports feedback only in its row and never mutates the saved binding", async () => {
  const ui = harness(); await tick(); await begin(ui, "ocr");
  recorder(ui.page.render(), "ocr").props.onKeyDown(key({ key: "Unidentified", code: "Unidentified" }));
  const tree = ui.page.render();
  const actionRow = row(tree, "ocr");
  const controls = nodes(actionRow).find((node) => node?.props?.className === "kiri-global-shortcut__controls");
  const alerts = nodes(actionRow).filter((node) => node?.props?.role === "alert");
  assert.equal(alerts.length, 1);
  assert.ok(nodes(controls).includes(alerts[0]), "feedback remains within its action controls");
  assert.ok(text(alerts[0]).includes("This key is not supported as a shortcut."));
  assert.equal(text(recorder(tree, "ocr")), "Press shortcut…");
  assert.ok(recorder(tree, "ocr").props["aria-describedby"].split(" ").includes("shortcut-feedback-ocr"));
  assert.ok(recorder(tree, "ocr").props["aria-label"].endsWith("⇧⌥⌘O"));
  for (const {action} of snapshot().filter((item) => item.action !== "ocr")) {
    assert.equal(nodes(row(tree, action)).some((node) => node?.props?.role === "alert"), false);
  }
  assert.equal(recorder(tree, "ocr").props["aria-pressed"], true);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});


test("function, media and primary-modified physical keys save directly without the old letter/digit restriction", async () => {
  const cases = [
    [{ key: "F1", code: "F1" }, "F1"],
    [{ key: "F24", code: "F24" }, "F24"],
    [{ key: "F12", code: "F12", shiftKey: true }, "Shift+F12"],
    [{ key: "AudioVolumeUp", code: "AudioVolumeUp" }, "AudioVolumeUp"],
    [{ key: "MediaPlayPause", code: "MediaPlayPause" }, "MediaPlayPause"],
    [{ key: "Enter", code: "Enter", ctrlKey: true }, "Control+Enter"],
    [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true }, "Alt+ArrowLeft"],
    [{ key: "/", code: "Slash", metaKey: true }, "Super+Slash"],
    [{ key: "+", code: "NumpadAdd", ctrlKey: true }, "Control+NumpadAdd"],
    [{ key: "Escape", code: "Escape", ctrlKey: true }, "Control+Escape"],
    [{ key: "Tab", code: "Tab", altKey: true }, "Alt+Tab"],
    [{ key: "Tab", code: "Tab", metaKey: true, shiftKey: true }, "Shift+Super+Tab"],
  ];
  for (const [input, expected] of cases) {
    const ui = harness(); await tick(); await begin(ui);
    const handler = recorder(ui.page.render()).props.onKeyDown;
    handler(key(input)); handler(key(input)); await tick();
    assert.deepEqual(ui.calls, [["capture", expected]], expected);
    assert.equal(applyButton(ui.page.render(), "capture"), undefined);
    assert.equal(ui.editing.at(-1), false);
    ui.page.unmount(); await tick();
  }
});

test("bare and Shift-only physical keys stay as readable row-owned candidates until explicitly confirmed", async () => {
  const cases = [
    [{ key: "q", code: "KeyQ" }, "KeyQ", "Q"],
    [{ key: "Q", code: "KeyQ", shiftKey: true }, "Shift+KeyQ", "⇧Q"],
    [{ key: " ", code: "Space" }, "Space", "Space"],
    [{ key: "Enter", code: "Enter" }, "Enter", "↩"],
    [{ key: "Backspace", code: "Backspace" }, "Backspace", "⌫"],
    [{ key: "ArrowLeft", code: "ArrowLeft" }, "ArrowLeft", "←"],
    [{ key: "?", code: "Slash", shiftKey: true }, "Shift+Slash", "⇧/"],
    [{ key: "7", code: "Numpad7" }, "Numpad7", "Num 7"],
    [{ key: "+", code: "NumpadAdd" }, "NumpadAdd", "Num +"],
    [{ key: "Escape", code: "Escape", shiftKey: true }, "Shift+Escape", "⇧Esc"],
  ];
  for (const [input, shortcut, label] of cases) {
    const ui = harness(); await tick(); await begin(ui, "library");
    recorder(ui.page.render(), "library").props.onKeyDown(key(input));
    const tree = ui.page.render();
    assert.equal(text(recorder(tree, "library")), label, shortcut);
    assert.ok(recorder(tree, "library").props["aria-label"].endsWith(label), "assistive technology receives the visible candidate, not the previous binding");
    assert.equal(nodes(tree).filter((node) => node?.props?.className === "kiri-shortcut-apply").length, 1);
    assert.ok(text(row(tree, "library")).includes("This key will also trigger while typing or navigating in other apps."));
    assert.equal(nodes(row(tree, "library")).some((node) => node?.props?.role === "alert"), false);
    assert.deepEqual(ui.calls, []);
    const apply = applyButton(tree, "library");
    apply.props.onClick(); apply.props.onClick(); await tick();
    assert.deepEqual(ui.calls, [["library", shortcut]], shortcut);
    assert.equal(applyButton(ui.page.render(), "library"), undefined);
    ui.page.unmount(); await tick();
  }
});

test("confirmation waits for native success and uses the recording-only warning without changing the saved key early", async () => {
  const pending = deferred(); const calls = [];
  const ui = harness({ setActionShortcut: (action, shortcut) => { calls.push([action, shortcut]); return pending.promise; } });
  await tick(); await begin(ui, "recordingPauseResume");
  recorder(ui.page.render(), "recordingPauseResume").props.onKeyDown(key({ key: " ", code: "Space" }));
  const candidate = ui.page.render();
  assert.ok(text(row(candidate, "recordingPauseResume")).includes("While recording, this key will also trigger in other apps."));
  assert.equal(text(row(candidate, "recordingPauseResume")).includes("while typing or navigating"), false);
  assert.deepEqual(calls, []);
  applyButton(candidate, "recordingPauseResume").props.onClick(); await tick();
  const saving = ui.page.render();
  assert.equal(recorder(saving, "recordingPauseResume").props.disabled, true);
  assert.ok(recorder(saving, "recordingPauseResume").props["aria-label"].endsWith("⇧⌥⌘P"));
  pending.resolve(snapshot().map((item) => item.action === "recordingPauseResume" ? { ...item, label: "Space", isDefault: false } : item));
  await tick();
  assert.deepEqual(calls, [["recordingPauseResume", "Space"]]);
  assert.ok(recorder(ui.page.render(), "recordingPauseResume").props["aria-label"].endsWith("Space"));
  assert.equal(recorder(ui.page.render(), "recordingPauseResume").props.disabled, false);
  ui.page.unmount(); await tick();
});

test("native-recorded keys use the same candidate confirmation policy and target the currently edited action", async () => {
  const ui = harness(); await tick(); await begin(ui, "recordingStop");
  ui.emit({ action: "capture", shortcut: "shift+Numpad7" });
  const tree = ui.page.render();
  assert.equal(text(recorder(tree, "recordingStop")), "⇧Num 7");
  assert.ok(applyButton(tree, "recordingStop"));
  assert.equal(applyButton(tree, "capture"), undefined);
  assert.deepEqual(ui.calls, []);
  cancelButton(tree, "recordingStop").props.onClick(); await tick();
  assert.ok(recorder(ui.page.render(), "recordingStop").props["aria-label"].endsWith("⇧⌥⌘S"));
  await begin(ui, "library");
  ui.emit({ action: "capture", shortcut: "F13" }); await tick();
  assert.deepEqual(ui.calls, [["library", "F13"]]);
  ui.page.unmount(); await tick();
});

test("Tab immediately after a candidate keeps confirmation reachable and only leaving its controls discards it", async () => {
  const ui = harness(); await tick(); await begin(ui, "record");
  const handler = recorder(ui.page.render(), "record").props.onKeyDown;
  handler(key({ key: " ", code: "Space" }));
  const tab = key({ key: "Tab", code: "Tab" });
  handler(tab); // No render between the key and Tab: this exercises the native/event race.
  assert.equal(tab.prevented, false);
  const tree = ui.page.render();
  assert.equal(recorder(tree, "record").props["aria-pressed"], true);
  assert.ok(applyButton(tree, "record"));
  const applyTarget = {};
  controls(tree, "record").props.onBlur({ currentTarget: { contains: (target) => target === applyTarget }, relatedTarget: applyTarget });
  assert.ok(applyButton(ui.page.render(), "record"), "focus moving to confirmation does not cancel recording");
  controls(ui.page.render(), "record").props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  await tick();
  assert.equal(applyButton(ui.page.render(), "record"), undefined);
  assert.equal(recorder(ui.page.render(), "record").props["aria-pressed"], false);
  assert.ok(recorder(ui.page.render(), "record").props["aria-label"].endsWith("⇧⌥⌘R"));
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});

test("IME, repeats and modifier-only keys do not alter an existing pending candidate or cancel its controls", async () => {
  const ui = harness(); await tick(); await begin(ui, "capture");
  recorder(ui.page.render()).props.onKeyDown(key({ key: " ", code: "Space" }));
  const events = [
    key({ key: "Escape", code: "Escape", nativeEvent: { isComposing: true } }),
    key({ key: "Tab", code: "Tab", nativeEvent: { isComposing: true } }),
    key({ key: "Escape", code: "Escape", repeat: true }),
    key({ key: "Process", code: "KeyQ" }),
    key({ key: "OS", code: "MetaLeft", metaKey: true }),
    key({ nativeEvent: { isComposing: false, keyCode: 229 } }),
    ...["Control", "Alt", "Shift", "Meta"].map((name) => key({ key: name, code: `${name}Left` })),
  ];
  for (const event of events) {
    recorder(ui.page.render()).props.onKeyDown(event);
    assert.equal(text(recorder(ui.page.render())), "Space");
    assert.ok(applyButton(ui.page.render(), "capture"));
  }
  for (const event of [key({ key: "Escape", code: "Escape", nativeEvent: { isComposing: true } }), key({ key: "Escape", code: "Escape", repeat: true })]) {
    controls(ui.page.render(), "capture").props.onKeyDown(event);
    assert.ok(applyButton(ui.page.render(), "capture"));
  }
  const escape = key({ key: "Escape", code: "Escape" });
  controls(ui.page.render(), "capture").props.onKeyDown(escape); await tick();
  assert.equal(escape.prevented, true);
  assert.equal(applyButton(ui.page.render(), "capture"), undefined);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});

test("a pending choice is discarded on window blur, action switch, or unmount without applying it", async () => {
  for (const exit of ["blur", "switch", "unmount"]) {
    const ui = harness(); await tick(); await begin(ui, "capture");
    recorder(ui.page.render()).props.onKeyDown(key());
    assert.ok(applyButton(ui.page.render(), "capture"));
    if (exit === "blur") ui.runtime.window.dispatchEvent({ type: "blur" });
    else if (exit === "switch") await begin(ui, "record");
    else ui.page.unmount();
    await tick();
    if (exit !== "unmount") {
      assert.equal(applyButton(ui.page.render(), "capture"), undefined);
      assert.ok(recorder(ui.page.render(), "capture").props["aria-label"].endsWith("⇧⌘A"));
      ui.page.unmount(); await tick();
    }
    assert.deepEqual(ui.calls, [], exit);
  }
});

test("an occupied binding can be replaced by a confirmed bare key instead of hiding its confirmation behind the old error", async () => {
  const states = snapshot().map((item) => item.action === "capture" ? { ...item, status: "occupied" } : item);
  const ui = harness({}, states); await tick(); await begin(ui);
  recorder(ui.page.render()).props.onKeyDown(key({ key: " ", code: "Space" }));
  const tree = ui.page.render();
  assert.ok(applyButton(tree, "capture"));
  assert.equal(retryButton(tree, "capture"), undefined, "the old occupied state must not steal the candidate's confirmation action");
  applyButton(tree, "capture").props.onClick(); await tick();
  assert.deepEqual(ui.calls, [["capture", "Space"]]);
  ui.page.unmount(); await tick();
});

test("unsupported, duplicate and unavailable confirmed keys preserve the old binding and report only the affected row", async () => {
  for (const failure of ["This key is not supported as a shortcut.", "This shortcut is already assigned to another action.", "This shortcut is unavailable. Choose another combination.", "Could not save the shortcuts."]) {
    const calls = [];
    const ui = harness({ setActionShortcut: async (action, shortcut) => { calls.push([action, shortcut]); throw failure; } });
    await tick(); await begin(ui, "ocr");
    recorder(ui.page.render(), "ocr").props.onKeyDown(key({ key: " ", code: "Space" }));
    assert.deepEqual(calls, []);
    applyButton(ui.page.render(), "ocr").props.onClick(); await tick();
    const tree = ui.page.render();
    assert.deepEqual(calls, [["ocr", "Space"]]);
    assert.ok(recorder(tree, "ocr").props["aria-label"].endsWith("⇧⌥⌘O"));
    assert.equal(text(recorder(tree, "ocr")), "⇧⌥⌘O");
    assert.equal(applyButton(tree, "ocr"), undefined);
    for (const { action } of snapshot()) {
      const alerts = nodes(row(tree, action)).filter((node) => node?.props?.role === "alert");
      assert.equal(alerts.length, action === "ocr" ? 1 : 0);
      if (alerts.length) assert.equal(text(alerts[0]), failure);
    }
    ui.page.unmount(); await tick();
  }
});

test("Shift+Tab cancels ordinary key recording without trapping navigation", async () => {
  const ui = harness(); await tick(); await begin(ui);
  const tab = key({ key: "Tab", code: "Tab", shiftKey: true });
  recorder(ui.page.render()).props.onKeyDown(tab); await tick();
  assert.equal(tab.prevented, false);
  assert.equal(recorder(ui.page.render()).props["aria-pressed"], false);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});


test("Windows and Linux pending labels preserve keypad identity and show the actual Shift modifier", async () => {
  for (const userAgent of ["Windows NT 10.0", "X11; Linux x86_64"]) {
    const ui = harness({}, snapshot(), { navigator: { userAgent } });
    await tick(); await begin(ui);
    recorder(ui.page.render()).props.onKeyDown(key({ key: "+", code: "NumpadAdd", shiftKey: true }));
    assert.equal(text(recorder(ui.page.render())), "Shift+Num +");
    assert.deepEqual(ui.calls, []);
    recorder(ui.page.render()).props.onKeyDown(key({ key: "7", code: "Digit7" }));
    assert.equal(text(recorder(ui.page.render())), "7");
    recorder(ui.page.render()).props.onKeyDown(key({ key: "7", code: "Numpad7" }));
    assert.equal(text(recorder(ui.page.render())), "Num 7");
    applyButton(ui.page.render(), "capture").props.onClick(); await tick();
    assert.deepEqual(ui.calls, [["capture", "Numpad7"]]);
    ui.page.unmount(); await tick();
  }
});

test("a rejected retry preserves the configured binding and exposes the native error while keeping retry available", async () => {
  const states = snapshot().map((item) => item.action === "record" ? { ...item, status: "occupied", label: "F13", isDefault: false } : item);
  const failure = "This shortcut is unavailable. Choose another combination.";
  const calls = [];
  const ui = harness({ retryActionShortcut: async (action) => { calls.push(action); throw failure; } }, states);
  await tick(); retryButton(ui.page.render(), "record").props.onClick(); await tick();
  const tree = ui.page.render();
  assert.deepEqual(calls, ["record"]);
  assert.equal(text(recorder(tree, "record")), "F13");
  assert.ok(text(row(tree, "record")).includes(failure));
  assert.equal(retryButton(tree, "record").props.disabled, false);
  assert.equal(clearButton(tree, "record").props.disabled, false);
  assert.deepEqual(ui.calls, []);
  ui.page.unmount(); await tick();
});


test("long native key labels size the entire column and retain its width while editing", async () => {
  for (const [userAgent, label] of [
    ["Macintosh", "⇧⌃⌥⌘Previous Track"],
    ["Windows NT 10.0", "Shift+Ctrl+Alt+Win+Previous Track"],
  ]) {
    const normal = snapshot();
    if (!userAgent.includes("Macintosh")) {
      for (const setting of normal) setting.label = setting.defaultLabel = "Shift+Ctrl+Alt+P";
    }
    const ui = harness({}, normal, { navigator: { userAgent } });
    await tick();
    assert.equal(ui.page.render().props["data-long-keys"], undefined);
    ui.change(normal.map((setting) => setting.action === "recordingPauseResume" ? { ...setting, label, isDefault: false } : setting));
    const wide = ui.page.render();
    assert.equal(wide.props["data-long-keys"], true, "the field width belongs to the common page rather than a single row");
    assert.ok(text(row(wide, "recordingPauseResume")).includes(label));
    await begin(ui, "recordingPauseResume");
    assert.equal(ui.page.render().props["data-long-keys"], true, "the stored long key keeps the column stable while its prompt is shown");
    cancelButton(ui.page.render(), "recordingPauseResume").props.onClick(); await tick();
    assert.equal(ui.page.render().props["data-long-keys"], true);
    ui.change(normal);
    assert.equal(ui.page.render().props["data-long-keys"], undefined, "restoring short keys restores the compact layout");
    ui.page.unmount(); await tick();
  }
});
