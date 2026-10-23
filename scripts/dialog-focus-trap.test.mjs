import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";

const hookSource = readFileSync(new URL("../src/settings/useDialogFocusTrap.ts", import.meta.url), "utf8");
const fixtureSource = `import React from "react";\n${hookSource}
export function FocusTrapFixture() {
  const ref = useDialogFocusTrap();
  return <div ref={ref} role="dialog" tabIndex={-1} />;
}`;

function focusHarness() {
  let document;
  class Element {
    constructor(name, { disabled = false, hidden = false, tabIndex = 0 } = {}) {
      Object.assign(this, { name, disabled, hidden, tabIndex, isConnected: true });
    }
    focus() { if (!this.disabled && !this.hidden) document.activeElement = this; }
    get offsetParent() { return this.hidden ? null : {}; }
    matches(selector) { return selector === ":disabled" && this.disabled; }
  }
  const opener = new Element("opener");
  const body = new Element("body");
  const background = new Element("background");
  const first = new Element("first");
  const last = new Element("last");
  const localListeners = new Map();
  let controls = [first, last];
  const dialog = Object.assign(new Element("dialog", { tabIndex: -1 }), {
    querySelectorAll() { return controls.filter(control => !control.disabled); },
    contains(target) { return target === this || controls.includes(target); },
    addEventListener(name, callback) { localListeners.set(name, callback); },
    removeEventListener(name) { localListeners.delete(name); },
  });
  const harness = createLibraryHarness({}, fixtureSource, {
    document: { activeElement: opener }, globals: { HTMLElement: Element },
    attachRef(node) { if (node.props.role === "dialog") node.props.ref.current = dialog; },
  });
  document = harness.document;
  const component = harness.mount("FocusTrapFixture");
  component.render();
  const tab = (shiftKey = false) => {
    const event = { type: "keydown", key: "Tab", shiftKey, target: document.activeElement,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    harness.document.dispatchEvent(event);
    if (dialog.contains(event.target)) localListeners.get("keydown")?.(event);
    return event.defaultPrevented;
  };
  return { component, document, dialog, opener, body, background, first, last, tab, dispatchThroughTarget: harness.window.dispatchThroughTarget,
    setControls(next) { controls = next; }, Element };
}

test("saving with every control disabled keeps Tab and Shift+Tab in the modal after native focus falls to body", () => {
  const ui = focusHarness();
  ui.last.focus();
  ui.first.disabled = true; ui.last.disabled = true;
  for (const shift of [false, true]) {
    ui.document.activeElement = ui.body;
    assert.equal(ui.tab(shift), true);
    assert.equal(ui.document.activeElement, ui.dialog);
  }
  ui.component.unmount();
});

test("a failed save resumes field navigation from the modal and repairs focus outside it", () => {
  const ui = focusHarness();
  for (const origin of [ui.dialog, ui.body, ui.background]) {
    ui.document.activeElement = origin;
    assert.equal(ui.tab(), true);
    assert.equal(ui.document.activeElement, ui.first);
    ui.document.activeElement = origin;
    assert.equal(ui.tab(true), true);
    assert.equal(ui.document.activeElement, ui.last);
  }
  ui.first.focus();
  assert.equal(ui.tab(true), true);
  assert.equal(ui.document.activeElement, ui.last);
  assert.equal(ui.tab(), true);
  assert.equal(ui.document.activeElement, ui.first);
  assert.equal(ui.tab(), false, "ordinary navigation between fields stays native");
  ui.component.unmount();
});

test("focus trap cleanup restores its opener and releases document keyboard handling", () => {
  const ui = focusHarness();
  ui.last.focus();
  ui.component.unmount();
  assert.equal(ui.document.activeElement, ui.opener);
  ui.document.activeElement = ui.body;
  assert.equal(ui.tab(), false);
  assert.equal(ui.document.activeElement, ui.body);
});

test("nested controls keep their handled Tab events and non-Tab shortcuts", () => {
  const ui = focusHarness();
  ui.document.activeElement = ui.background;
  let prevented = 0;
  for (const key of ["Enter", "Escape", "a"]) {
    ui.document.dispatchEvent({ type: "keydown", key, preventDefault() { prevented++; } });
    assert.equal(ui.document.activeElement, ui.background);
  }
  ui.document.dispatchEvent({ type: "keydown", key: "Tab", defaultPrevented: true, preventDefault() { prevented++; } });
  assert.equal(ui.document.activeElement, ui.background);
  const event = { type: "keydown", key: "Tab", defaultPrevented: false, cancelBubble: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } };
  ui.dispatchThroughTarget(event, key => { key.preventDefault(); key.stopPropagation(); });
  assert.equal(ui.document.activeElement, ui.background, "a nested portalled menu owns its handled Tab");
  assert.equal(prevented, 0);
  ui.component.unmount();
});

test("OCR profile modal has a focusable fallback while saving disables every form control", () => {
  const source = 'import React from "react";\n' + readFileSync(new URL("../src/settings/OcrProfileDialog.tsx", import.meta.url), "utf8");
  const harness = createLibraryHarness({}, source, {
    modules: { "./useDialogFocusTrap": { useDialogFocusTrap: () => ({ current: null }) } },
  });
  const component = harness.mount("OcrProfileDialog", { profile: null, busy: true, error: null, onCancel() {}, onSave() {} });
  const tree = component.render();
  assert.equal(nodes(tree).find(node => node?.props?.role === "dialog").props.tabIndex, -1);
  const controls = nodes(tree).filter(node => ["input", "button", "select", "textarea"].includes(node?.type));
  assert.ok(controls.length > 0);
  assert.ok(controls.every(node => node.props.disabled));
  component.unmount();
});

test("OCR delete confirmation shares the focusable busy fallback", () => {
  const settings = readFileSync(new URL("../src/settings/SettingsView.tsx", import.meta.url), "utf8");
  const source = `import React,{useEffect,useId} from "react";
    import {t,fmt} from "../i18n";
    import {useDialogFocusTrap} from "./useDialogFocusTrap";
    export ${settings.slice(settings.indexOf("function DeleteProfileDialog("))}`;
  const harness = createLibraryHarness({}, source, {
    modules: { "./useDialogFocusTrap": { useDialogFocusTrap: () => ({ current: null }) } },
  });
  const component = harness.mount("DeleteProfileDialog", { profile: { name: "Fixture" }, active: false,
    busy: true, error: null, onCancel() {}, onDelete() {} });
  const tree = component.render();
  assert.equal(nodes(tree).find(node => node?.props?.role === "alertdialog").props.tabIndex, -1);
  assert.ok(nodes(tree).filter(node => node?.type === "button").every(node => node.props.disabled));
  component.unmount();
});
