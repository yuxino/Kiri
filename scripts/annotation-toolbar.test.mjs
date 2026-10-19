import assert from "node:assert/strict";
import test from "node:test";
import {createLibraryHarness, nodes} from "./helpers/library-render-harness.mjs";

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
