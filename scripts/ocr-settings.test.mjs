import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, deferred, nodes, settleRequests } from "./helpers/library-render-harness.mjs";

const saved = { schemaVersion: 1, activeEngine: { kind: "local" }, profiles: [] };
const source = 'import React from "react";\n' + readFileSync(new URL("../src/settings/SettingsView.tsx", import.meta.url), "utf8");

function settingsHarness(api, hasUpdate = false) {
  const harness = createLibraryHarness(api, source, {
    document: { getElementById: () => null },
    modules: {
      "../components/ChoiceSelect": { ChoiceSelect: "choice-select" },
      "./useAppUpdater": { stateDetails: () => null },
      "./OcrProfileDialog": { OcrProfileDialog: "ocr-profile-dialog" },
      "./ShortcutsSettings": { ShortcutsSettings: "shortcuts-settings" },
      "./DockVisibilityRow": { DockVisibilityRow: "dock-row" },
      "./StartupSettingsRow": { StartupSettingsRow: "startup-row" },
      "./SupportLinks": { SupportLinks: "support-links" },
      "./ReleaseNotes": { ReleaseNotes: "release-notes" },
      "./OcrSettingsSection": { OcrSettingsSection: "ocr-settings" },
      "./useDialogFocusTrap": { useDialogFocusTrap: () => ({ current: null }) },
    },
  });
  const component = harness.mount("SettingsView", { updater: { hasUpdate } });
  component.render();
  return {
    component,
    tab(id) {
      nodes(component.render()).find(node => node?.props?.id === `settings-tab-${id}`).props.onClick();
      return component.render();
    },
    ocr() { return nodes(component.render()).find(node => node?.type === "ocr-settings"); },
  };
}

test("general, shortcuts and update settings do not query OCR credentials", async () => {
  for (const hasUpdate of [false, true]) {
    let loads = 0;
    const pending = deferred();
    const h = settingsHarness({ getOcrProviderSettings: () => { loads++; return pending.promise; } }, hasUpdate);
    h.tab("general"); h.tab("shortcuts"); h.tab("about");
    await settleRequests();
    assert.equal(loads, 0);
    h.tab("ocr");
    assert.equal(loads, 1);
    h.tab("general"); h.tab("ocr");
    assert.equal(loads, 1, "navigation does not duplicate an in-flight request");
    pending.resolve(saved); await settleRequests();
    assert.deepEqual(h.ocr().props.settings, saved);
    h.tab("about"); h.tab("ocr");
    assert.equal(loads, 1, "the successful load is cached for this settings session");
    h.component.unmount();
  }
});

test("a failed first OCR load remains explicitly retryable", async () => {
  const requests = [];
  const h = settingsHarness({ getOcrProviderSettings: () => {
    const request = deferred(); requests.push(request); return request.promise;
  } });
  h.tab("ocr");
  requests[0].reject(new Error("unavailable")); await settleRequests();
  h.tab("about"); h.tab("ocr");
  assert.equal(requests.length, 1, "tab navigation does not repeatedly query unavailable credential storage");
  nodes(h.component.render()).find(node => node?.type === "button" && nodes(node).includes("Retry")).props.onClick();
  assert.equal(requests.length, 2);
  requests[1].resolve(saved); await settleRequests();
  assert.deepEqual(h.ocr().props.settings, saved);
  h.component.unmount();
});

test("profile saves still replace the cached OCR settings", async () => {
  const result = { ...saved, profiles: [{ id: "new-profile", name: "New profile" }] };
  const h = settingsHarness({ getOcrProviderSettings: async () => saved, saveOcrProviderProfile: async () => result });
  h.tab("ocr"); await settleRequests();
  h.ocr().props.onAdd();
  nodes(h.component.render()).find(node => node?.type === "ocr-profile-dialog").props.onSave({ name: "New profile" });
  await settleRequests();
  assert.deepEqual(h.ocr().props.settings, result);
  assert.equal(nodes(h.component.render()).some(node => node?.type === "ocr-profile-dialog"), false);
  h.tab("general"); h.tab("ocr");
  assert.deepEqual(h.ocr().props.settings, result);
  h.component.unmount();
});
