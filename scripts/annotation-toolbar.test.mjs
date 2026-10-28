import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createLibraryHarness, nodes, settleRequests} from "./helpers/library-render-harness.mjs";

function toolbar(platform = "MacIntel") {
  return createLibraryHarness({}, 'export {AnnotationToolbarButton, toolbarShortcut} from "../components/AnnotationToolbarButton";', {
    navigator: {platform},
  });
}
function button(component) {
  return nodes(component.render()).find(node => node?.type === "button");
}

test("action chords use platform names in the tooltip and accessible shortcut", () => {
  for (const [platform, expected, aria] of [["MacIntel", "⇧⌘Z", "Meta+Shift+Z"], ["Win32", "Ctrl+Shift+Z", "Control+Shift+Z"], ["Linux x86_64", "Ctrl+Shift+Z", "Control+Shift+Z"]]) {
    const h = toolbar(platform);
    const component = h.mount("AnnotationToolbarButton", {icon: "arrow.uturn.forward", title: "Redo", shortcut: "Mod+Shift+Z", onClick() {}});
    const node = button(component);
    assert.equal(node.props["aria-keyshortcuts"], aria);
    assert.equal(node.props["aria-label"], "Redo");
    assert.equal(nodes(node).find(item => item?.type === "kbd"), undefined);
    node.props.onFocus();
    assert.ok(nodes(component.render()).some(item => item?.props?.title === `Redo · ${expected}`));
    assert.equal(node.props.title, undefined, "the custom tooltip must not duplicate a native title");
  }
});

test("unbound actions advertise no invented key and keep disabled/selected states", () => {
  const h = toolbar();
  const component = h.mount("AnnotationToolbarButton", {icon: "qrcode", title: "Recognize QR Codes", active: true, disabled: true, onClick() {}});
  const node = button(component);
  assert.equal(node.props["aria-keyshortcuts"], undefined);
  assert.equal(node.props["aria-pressed"], true);
  assert.equal(node.props["data-active"], true);
  assert.equal(node.props.disabled, true);
  assert.equal(nodes(node).find(item => item?.type === "kbd"), undefined, "unbound actions do not reserve an empty caption row");
});

test("focus and hover reveal the full localized name without changing the tool", () => {
  const h = toolbar();
  let clicks = 0;
  const component = h.mount("AnnotationToolbarButton", {icon: "number.circle", title: "序号标注 (N)", shortcut: "N", onClick() {clicks++;}});
  button(component).props.onFocus();
  let node = button(component);
  assert.ok(node.props["aria-describedby"]);
  assert.ok(nodes(component.render()).some(item => item?.props?.title === "序号标注 (N)"));
  node.props.onMouseEnter(); node.props.onBlur();
  assert.ok(button(component).props["aria-describedby"], "hover keeps the explanation after focus leaves");
  button(component).props.onMouseLeave();
  assert.equal(button(component).props["aria-describedby"], undefined);
  assert.equal(clicks, 0);
  button(component).props.onClick();
  assert.equal(clicks, 1);
});

test("focused activation remains native and never bubbles into capture completion", () => {
  const h = toolbar();
  const component = h.mount("AnnotationToolbarButton", {icon: "textformat", title: "Text (T)", shortcut: "T", onClick() {}});
  let stopped = 0;
  const node = button(component);
  assert.ok(nodes(node).includes("T"), "letter tool bindings remain visible");
  for (const key of ["Enter", " ", "t"]) node.props.onKeyDown({key, stopPropagation() {stopped++;}, preventDefault() {assert.fail("native button activation must remain available");}});
  assert.equal(stopped, 2);
});

test("completion keys retain platform names without advertising extra bindings", () => {
  for (const [platform, expected] of [["MacIntel", "Return"], ["Win32", "Enter"]]) {
    const component = toolbar(platform).mount("AnnotationToolbarButton", {icon: "checkmark", title: "Save", shortcut: "Enter", primary: true, onClick() {}});
    const node = button(component);
    assert.ok(nodes(node).includes("↵"));
    assert.ok(!nodes(node).includes("Save"), "completion names stay in the accessible tooltip, not the icon row");
    assert.equal(node.props["data-active"], undefined, "a completion action is not a selected tool");
    assert.equal(node.props["data-primary"], true);
    assert.equal(node.props["aria-keyshortcuts"], "Enter");
    node.props.onFocus();
    assert.ok(nodes(component.render()).some(item => item?.props?.title === `Save · ${expected}`));
  }
});

test("capture, image, video and recording use one tool order, icon, title and shortcut", () => {
  const h = createLibraryHarness({}, `
    import React from "react";
    import {annotationToolGroups, SCREENSHOT_ANNOTATION_TOOLS, IMAGE_ANNOTATION_TOOLS,
      VIDEO_ANNOTATION_TOOLS, LIVE_ANNOTATION_TOOLS} from "../components/AnnotationTools";
    const modes = {capture: SCREENSHOT_ANNOTATION_TOOLS, image: IMAGE_ANNOTATION_TOOLS, video: VIDEO_ANNOTATION_TOOLS, recording: LIVE_ANNOTATION_TOOLS};
    export function Tools(props) {return <>{annotationToolGroups({tools: modes[props.mode], selected: "pen", onChange: props.onChange})}</>;}
  `);
  const clicked = [];
  const controls = mode => nodes(h.mount("Tools", {mode, onChange: tool => clicked.push(tool)}).render())
    .filter(node => node?.props?.shortcut).map(node => node.props);
  const image = controls("image");
  for (const mode of ["capture", "video", "recording"]) {
    const subset = controls(mode);
    assert.deepEqual(subset.map(({icon, title, shortcut}) => ({icon, title, shortcut})),
      image.filter(item => subset.some(other => item.shortcut === other.shortcut)).map(({icon, title, shortcut}) => ({icon, title, shortcut})));
    subset.find(item => item.shortcut === "P").onClick();
    assert.equal(subset.find(item => item.shortcut === "P").active, true);
  }
  assert.deepEqual(controls("recording").map(item => item.shortcut), ["V", "P", "R", "A", "T"]);
  assert.deepEqual(clicked, ["pen", "pen", "pen"]);
});

const recordingSource = 'import React from "react";\n' + readFileSync(new URL("../src/windows/RecordingAnnotationControls.tsx", import.meta.url), "utf8");
function recordingControls() {
  const calls = [], preferences = [];
  let selection;
  const appearance = {colorPreset: "cherry", penWidth: 3, shapeWidth: 3, textFontSize: 18, textBackgroundStyle: "transparent"};
  const state = {ready: true, tool: "pen", canUndo: true, canRedo: false, hasMarks: true};
  const h = createLibraryHarness({}, recordingSource, {modules: {
    "../annotation/AnnotationStyleControls": {AnnotationStyleControls: "style-controls"},
    "../annotation/useAnnotationAppearance": {useAnnotationAppearance: () => [appearance, value => preferences.push(value)]},
    "../lib/ipc": {
      api: {
        setRecordingAnnotationTool: async (...args) => {calls.push(["tool", ...args]);},
        recordingAnnotationAction: async (...args) => {calls.push(["action", ...args]);},
        updateRecordingAnnotationAppearance: async (...args) => {calls.push(["appearance", ...args]);},
      },
      onRecordingAnnotationSelection: handler => {selection = handler; return Promise.resolve(() => {});},
    },
  }});
  const component = h.mount("RecordingAnnotationControls", {sessionId: "session-1", state, disabled: false});
  component.render();
  return {component, calls, preferences, state, selection: event => selection(event),
    control: title => nodes(component.render()).find(node => node?.props?.title === title),
    style: () => nodes(component.render()).find(node => node?.type === "style-controls")};
}

test("live controls use the shared appearance panel and expose selected text actions", async () => {
  const h = recordingControls();
  const selected = {kind: "text", id: 1, text: "Hello", color: "white", fontSize: 24, background: "dark"};
  h.selection({sessionId: "older-session", mark: selected});
  assert.equal(h.style().props.selected, null, "another recording cannot replace the current selection");
  h.selection({sessionId: "session-1", mark: selected});
  assert.equal(h.style().props.selected, selected);
  h.style().props.onEditText(); await settleRequests(); h.component.render();
  h.style().props.onDelete(); await settleRequests();
  assert.deepEqual(h.calls, [["action", "session-1", "editText"], ["action", "session-1", "delete"]]);
  h.state.tool = "desktop";
  assert.equal(h.style().props.selected, null, "desktop leaves no stale selected-object controls");
  h.component.unmount();
});

test("selected appearance relays same-valued preferences and groups slider edits into one finish", async () => {
  const h = recordingControls();
  h.selection({sessionId: "session-1", mark: {kind: "pen", color: "white", width: 6}});
  h.style().props.onChange({colorPreset: "cherry"});
  h.style().props.onChange({penWidth: 4}, true);
  h.style().props.onChange({penWidth: 5}, true);
  h.style().props.onFinish(); h.style().props.onFinish();
  for (let index = 0; index < 3; index++) await settleRequests();
  assert.deepEqual(h.calls, [
    ["appearance", "session-1", {colorPreset: "cherry"}, false],
    ["appearance", "session-1", {penWidth: 4}, true],
    ["appearance", "session-1", {penWidth: 5}, true],
    ["appearance", "session-1", {}, false, true],
  ]);
  assert.equal(h.preferences.at(-1).penWidth, 5);
  h.component.unmount();
});

test("recording keeps contextual desktop, shared history, options visibility and explicit clear chord", async () => {
  const h = recordingControls();
  assert.equal(h.control("Operate Desktop").props.shortcut, "Escape");
  assert.equal(h.control("Clear Annotations").props.shortcut, "Mod+Shift+Backspace");
  assert.equal(h.control("Redo").props.disabled, true);
  h.control("Tool options").props.onClick();
  assert.equal(h.style(), undefined);
  h.control("Tool options").props.onClick();
  assert.ok(h.style());
  h.control("Rectangle (R)").props.onClick(); await settleRequests(); h.component.render();
  h.control("Operate Desktop").props.onClick(); await settleRequests(); h.component.render();
  h.control("Clear Annotations").props.onClick(); await settleRequests();
  assert.deepEqual(h.calls, [["tool", "session-1", "rectangle"], ["tool", "session-1", "desktop"], ["action", "session-1", "clear"]]);
  h.component.unmount();
});
