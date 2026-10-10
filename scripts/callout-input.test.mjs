import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createLibraryHarness} from "./helpers/library-render-harness.mjs";
import * as composition from "../src/annotation/text-composition.js";

const source = readFileSync(new URL("../src/annotation/CalloutControls.tsx", import.meta.url), "utf8") +
  "\nexport {CalloutDescription};";

function input(text = "") {
  let value = "";
  const writes = [], changes = [], commands = [];
  const textarea = {
    selectionStart: 0, selectionEnd: 0,
    get value() {return value;},
    set value(next) {writes.push(next); value = next; this.selectionStart = this.selectionEnd = next.length;},
    ownerDocument: {execCommand(command) {commands.push(command); return true;}},
    blur() {node.props.onBlur({currentTarget: textarea});},
    type(next) {
      const start = this.selectionStart;
      value = value.slice(0, start) + next + value.slice(this.selectionEnd);
      this.selectionStart = this.selectionEnd = start + next.length;
      node.props.onChange({currentTarget: this});
    },
    nativeUndo(next) {
      value = next; this.selectionStart = this.selectionEnd = next.length;
      node.props.onChange({currentTarget: this});
    },
  };
  const h = createLibraryHarness({}, source, {
    modules: {"./model": {}, "./text-composition.js": composition, "./callout-controls.css": {}},
    attachRef(node) {if (node.type === "textarea") node.props.ref(textarea);},
  });
  let finishes = 0;
  const props = {text, disabled: false, onChange: text => changes.push(text), onFinish: () => finishes++};
  const component = h.mount("CalloutDescription", props);
  let node = component.render();
  return {textarea, writes, changes, commands, finishes: () => finishes,
    render(text) {node = component.render({...props, text}); return node;},
    key(options = {}) {
      const event = {key: "Enter", currentTarget: textarea, target: textarea,
        defaultPrevented: false, stopped: false,
        preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, ...options};
      node.props.onKeyDown(event); return event;
    },
    compose(active) {node.props[active ? "onCompositionStart" : "onCompositionEnd"]({currentTarget: textarea});},
  };
}

test("delayed callout selection echoes preserve continuous input and the native caret", () => {
  const h = input();
  for (const char of "abcdef") h.textarea.type(char);
  h.textarea.selectionStart = h.textarea.selectionEnd = 3;
  h.textarea.type("XY");
  for (const text of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcXYdef"]) {
    const node = h.render(text);
    assert.equal(node.props.value, undefined);
    assert.equal(node.props.defaultValue, undefined);
    assert.equal(h.textarea.value, "abcXYdef");
    assert.equal(h.textarea.selectionStart, 5);
  }
  assert.deepEqual(h.changes, ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcXYdef"]);
  assert.deepEqual(h.writes, [""]);
});

test("native Undo returning to the original prop cannot leave stale echoes or rewrite the input", () => {
  const h = input("saved");
  h.textarea.type("x"); h.textarea.nativeUndo("saved"); h.render("saved");
  h.textarea.nativeUndo("savedx"); h.render("savedx");
  h.textarea.type("\nsecond line");
  for (const echo of ["saved", "savedx", "savedx\nsecond line"]) h.render(echo);
  assert.equal(h.textarea.value, "savedx\nsecond line");
  assert.deepEqual(h.changes, ["savedx", "saved", "savedx", "savedx\nsecond line"]);
  assert.deepEqual(h.writes, ["saved"]);
});

test("callout composition owns Enter/Escape/undo, then native history executes once", () => {
  const h = input();
  h.compose(true); h.textarea.type("zhong"); h.render("zhong");
  for (const options of [{key: "Enter"}, {key: "Escape"}, {key: "z", metaKey: true}]) {
    const event = h.key(options);
    assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, true);
  }
  assert.equal(h.finishes(), 0); assert.deepEqual(h.commands, []);
  h.compose(false);
  assert.equal(h.key({key: "Escape", keyCode: 229}).defaultPrevented, false);
  assert.equal(h.key().defaultPrevented, false, "ordinary Return inserts a description newline");
  for (const modifier of ["metaKey", "ctrlKey"]) for (const shiftKey of [false, true]) {
    const event = h.key({key: "z", [modifier]: true, shiftKey});
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  }
  assert.deepEqual(h.commands, ["undo", "redo", "undo", "redo"]);
  h.textarea.ownerDocument.execCommand = () => false;
  assert.equal(h.key({key: "z", ctrlKey: true}).defaultPrevented, false);
  h.compose(true); h.textarea.blur();
  assert.equal(composition.isTextComposition({target: h.textarea}), false);
  assert.equal(h.finishes(), 1);
  assert.equal(h.key({key: "Escape"}).defaultPrevented, true);
  assert.equal(h.finishes(), 2);
});
