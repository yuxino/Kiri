import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const source = `import React from "react";\n${readFileSync(new URL("../src/settings/StartupSettingsRow.tsx", import.meta.url), "utf8")}`;
const state = (enabled = false, requiresApproval = false) => ({ supported: true, enabled, requiresApproval });
const toggle = row => nodes(row.render()).find(node => node?.props?.role === "switch");
const button = (row, label) => nodes(row.render()).find(node => node?.type === "button" && nodes(node).includes(label));

test("reading and refocusing startup settings never registers a login item", async () => {
  let enabled = false;
  const writes = [];
  const harness = createLibraryHarness({
    getStartupSettings: async () => state(enabled),
    setStartupEnabled: async value => { writes.push(value); return state(value); },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  assert.equal(toggle(row).props.disabled, true);
  await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], false);
  enabled = true;
  harness.window.dispatchEvent({ type: "focus" });
  await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], true);
  enabled = false;
  harness.window.dispatchEvent({ type: "focus" });
  await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], false);
  assert.deepEqual(writes, []);
  row.unmount();
});

test("duplicate clicks and focus during a change cannot register twice or replace the returned OS state", async () => {
  const result = deferred();
  const writes = [];
  let reads = 0;
  const harness = createLibraryHarness({
    getStartupSettings: async () => { reads++; return state(); },
    setStartupEnabled: value => { writes.push(value); return result.promise; },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  row.render(); await settleRequests();
  const control = toggle(row);
  control.props.onClick(); control.props.onClick();
  harness.window.dispatchEvent({ type: "focus" });
  assert.deepEqual(writes, [true]);
  assert.equal(reads, 1);
  assert.equal(toggle(row).props["aria-checked"], false);
  assert.equal(toggle(row).props.disabled, true);
  result.resolve(state(false, true)); await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], true);
  assert.ok(button(row, "Open System Settings"));
  row.unmount();
});

test("a system-disabled registration is explained, refreshed after system settings, and can be removed", async () => {
  let current = state(false, true);
  const writes = [];
  let opened = 0;
  const harness = createLibraryHarness({
    getStartupSettings: async () => current,
    openSystemStartupSettings: async () => { opened++; current = state(true); },
    setStartupEnabled: async value => { writes.push(value); current = state(value); return current; },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  row.render(); await settleRequests();
  assert.ok(nodes(row.render()).includes("Not active. Allow Kiri in your system's startup settings."));
  button(row, "Open System Settings").props.onClick(); await settleRequests();
  assert.equal(opened, 1);
  assert.equal(button(row, "Open System Settings"), undefined);
  toggle(row).props.onClick(); await settleRequests();
  assert.deepEqual(writes, [false]);
  assert.equal(toggle(row).props["aria-checked"], false);
  row.unmount();
});

test("a failed native change keeps the current value and allows retry", async () => {
  const harness = createLibraryHarness({
    getStartupSettings: async () => state(true),
    setStartupEnabled: async () => { throw new Error("OS refused"); },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  row.render(); await settleRequests();
  toggle(row).props.onClick(); await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], true);
  assert.equal(toggle(row).props.disabled, false);
  assert.ok(nodes(row.render()).includes("Couldn't change startup settings."));
  row.unmount();
});

test("load failure offers retry and an unsupported installation never enables the switch", async () => {
  let reads = 0;
  const harness = createLibraryHarness({
    getStartupSettings: async () => {
      if (++reads === 1) throw new Error("IPC unavailable");
      return { supported: false, enabled: false, requiresApproval: false };
    },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  row.render(); await settleRequests();
  assert.equal(toggle(row), undefined);
  button(row, "Retry").props.onClick(); await settleRequests();
  assert.equal(toggle(row).props.disabled, true);
  assert.equal(toggle(row).props["aria-checked"], false);
  assert.ok(nodes(row.render()).includes("Startup is unavailable for this installation."));
  row.unmount();
});

test("a stale initial read cannot replace the newest state in Strict Mode", async () => {
  const old = deferred(), latest = deferred();
  let reads = 0;
  const harness = createLibraryHarness({
    getStartupSettings: () => ++reads === 1 ? old.promise : latest.promise,
  }, source, { strictEffects: true });
  const row = harness.mount("StartupSettingsRow", {});
  row.render();
  latest.resolve(state(true)); await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], true);
  old.resolve(state(false)); await settleRequests();
  assert.equal(toggle(row).props["aria-checked"], true);
  row.unmount();
});

test("failure to open system settings stays visible instead of being cleared by an automatic reload", async () => {
  let reads = 0;
  const harness = createLibraryHarness({
    getStartupSettings: async () => { reads++; return state(false, true); },
    openSystemStartupSettings: async () => { throw new Error("OS refused"); },
  }, source);
  const row = harness.mount("StartupSettingsRow", {});
  row.render(); await settleRequests();
  button(row, "Open System Settings").props.onClick(); await settleRequests();
  assert.ok(nodes(row.render()).includes("Couldn't open system startup settings."));
  assert.equal(reads, 1);
  assert.equal(toggle(row).props.disabled, false);
  row.unmount();
});
