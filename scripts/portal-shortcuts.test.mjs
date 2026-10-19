import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

const source = 'import React from "react";\n' + readFileSync(new URL("../src/settings/PortalShortcutsCard.tsx", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const state = (status, revision = 1, extra = {}) => ({
  status, revision, available: true, canConfigure: false, appId: "io.yuxino.kiri",
  bindings: ["capture", "pause-resume", "stop"].map((id) => ({ id, trigger: null })), ...extra,
});
function harness(initial, overrides = {}) {
  let changed, cancelled = 0, disposed = 0;
  const calls = [];
  const api = {
    getPortalShortcuts: async () => initial,
    updatePortalShortcuts: async (operation) => { calls.push(operation); return initial; },
    cancelPortalShortcutSetup: async () => { cancelled++; },
    ...overrides,
  };
  const runtime = createLibraryHarness({}, source, { modules: { "../lib/ipc": {
    api, onPortalShortcutsChanged: (callback) => { changed = callback; return Promise.resolve(() => { disposed++; }); },
  } } });
  const card = runtime.mount("PortalShortcutsCard");
  card.render();
  return { card, runtime, calls, emit: (value) => changed(value), cancelled: () => cancelled, disposed: () => disposed };
}
const text = (tree) => nodes(tree).filter((node) => typeof node === "string").join(" ");
const button = (tree, label) => nodes(tree).find((node) => node?.type === "button" && text(node).includes(label));

test("unavailable Wayland keeps all three commands and makes no automatic setup request", async () => {
  const ui = harness(state("unavailable", 1, { available: false }));
  await tick(); const tree = ui.card.render();
  for (const command of ["kiri --capture", "kiri --toggle-recording-pause", "kiri --stop-recording"]) assert.ok(text(tree).includes(command));
  assert.equal(button(tree, "Set Up Desktop Shortcuts").props.disabled, true);
  assert.equal(button(tree, "Refresh Shortcut Status").props.disabled, false);
  assert.deepEqual(ui.calls, []);
  ui.card.unmount();
});

test("repeated setup clicks dispatch once and partial returned triggers stay honest", async () => {
  const request = pending(); let count = 0;
  const ui = harness(state("ready"), { updatePortalShortcuts: () => { count++; return request.promise; } });
  await tick(); let tree = ui.card.render();
  const setup = button(tree, "Set Up Desktop Shortcuts");
  setup.props.onClick(); setup.props.onClick();
  assert.equal(count, 1);
  ui.emit(state("connecting", 2)); tree = ui.card.render();
  assert.ok(button(tree, "Cancel Setup"));
  request.resolve(state("active", 3, { canConfigure: true, bindings: [
    { id: "capture", trigger: "Ctrl+A or Super+A" }, { id: "pause-resume", trigger: null }, { id: "stop", trigger: null },
  ] }));
  await tick(); tree = ui.card.render();
  assert.ok(text(tree).includes("Ctrl+A or Super+A"));
  assert.equal(text(tree).split("Not bound").length - 1, 2);
  assert.ok(button(tree, "Open Desktop Shortcut Settings"));
  ui.card.unmount();
});

test("session closure wins over a delayed successful setup response", async () => {
  const request = pending();
  const ui = harness(state("ready"), { updatePortalShortcuts: () => request.promise });
  await tick(); button(ui.card.render(), "Set Up Desktop Shortcuts").props.onClick();
  ui.emit(state("closed", 5));
  request.resolve(state("active", 4, { bindings: [{ id: "capture", trigger: "STALE KEY" }] }));
  await tick(); const tree = ui.card.render();
  assert.ok(text(tree).includes("session ended"));
  assert.ok(!text(tree).includes("STALE KEY"));
  assert.ok(button(tree, "Reconnect Desktop Shortcuts"));
  ui.card.unmount();
});

test("leaving Settings cancels only an in-progress setup and disposes the subscription", async () => {
  const request = pending();
  const ui = harness(state("ready"), { updatePortalShortcuts: () => request.promise });
  await tick(); button(ui.card.render(), "Set Up Desktop Shortcuts").props.onClick();
  ui.card.unmount(); await tick();
  assert.equal(ui.cancelled(), 1); assert.equal(ui.disposed(), 1);
  request.resolve(state("declined", 2)); await tick();
  const idle = harness(state("active", 5)); await tick(); idle.card.unmount(); await tick();
  assert.equal(idle.cancelled(), 0);
});

test("native shortcut path remains separate and packaging matches the portal app ID", () => {
  const root = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const lib = root("src-tauri/src/lib.rs");
  const shortcuts = root("src-tauri/src/shortcut_settings.rs");
  assert.match(shortcuts, /pub fn system_managed\(\)[\s\S]*?crate::capture::linux::is_wayland\(\)/);
  assert.match(shortcuts, /pub fn retry\([\s\S]*?if system_managed\(\)\s*\{\s*return Ok\(\(\)\);/);
  assert.ok(lib.includes('tauri_plugin_single_instance::init'));
  const config = JSON.parse(root("src-tauri/tauri.conf.json"));
  const linux = JSON.parse(root("src-tauri/tauri.linux.conf.json"));
  const file = linux.bundle.linux.deb.files[`/usr/share/applications/${config.identifier}.desktop`];
  assert.equal(file, "linux/io.yuxino.kiri.desktop");
  assert.match(root(`src-tauri/${file}`), /^NoDisplay=true$/m);
  assert.match(root(`src-tauri/${file}`), /^Exec=kiri$/m);
});

test("hiding the resident library cancels pending setup without cancelling on portal focus transfer", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const callback = lib.slice(lib.indexOf('if window.label() == "library" {'), lib.indexOf('.invoke_handler('));
  const portalCall = callback.indexOf('portal_shortcuts::cancel_setup');
  const cancellation = callback.slice(callback.lastIndexOf('if matches!(', portalCall), portalCall);
  assert.ok(cancellation.includes('WindowEvent::CloseRequested'));
  assert.ok(cancellation.includes('WindowEvent::Destroyed'));
  assert.ok(!cancellation.includes('WindowEvent::Focused'));
});

test("focus refresh is serialized and a newer closure rejects stale successful replies", async () => {
  const request = pending(); let calls = 0;
  const ui = harness(state("active", 3), { updatePortalShortcuts: () => { calls++; return request.promise; } });
  await tick();
  ui.runtime.window.dispatchEvent({ type: "focus" });
  ui.runtime.window.dispatchEvent({ type: "focus" });
  assert.equal(calls, 1);
  ui.emit(state("closed", 5));
  request.resolve(state("active", 4, { bindings: [{ id: "capture", trigger: "STALE KEY" }] }));
  await tick(); const tree = ui.card.render();
  assert.ok(text(tree).includes("session ended"));
  assert.ok(!text(tree).includes("STALE KEY"));
  ui.card.unmount();
});

test("clearing an unreadable snapshot never resets the revision high-water mark", async () => {
  let reads = 0;
  const ui = harness(state("ready"), {
    getPortalShortcuts: async () => { if (reads++) throw new Error("offline"); return state("ready"); },
    updatePortalShortcuts: async () => { throw new Error("offline"); },
  });
  await tick(); ui.emit(state("closed", 5));
  ui.runtime.window.dispatchEvent({ type: "focus" }); await tick();
  ui.emit(state("active", 4, { bindings: [{ id: "capture", trigger: "STALE KEY" }] }));
  assert.ok(!text(ui.card.render()).includes("STALE KEY"));
  ui.emit(state("closed", 5)); assert.ok(text(ui.card.render()).includes("session ended"));
  ui.card.unmount();
});
