import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createLibraryHarness, nodes} from "./helpers/library-render-harness.mjs";
import ts from "typescript";
import * as layout from "../src/annotation/text-layout.js";
import * as composition from "../src/annotation/text-composition.js";

const canvasSource = readFileSync(new URL("../src/annotation/AnnotationCanvas.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("AnnotationCanvas.tsx", canvasSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editor = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "TextEditor");
assert.ok(editor);
const source = `import React, {useRef, useCallback, useEffect, useLayoutEffect, useId} from "react";
import {t} from "../i18n";
import {COLOR_HEX} from "./model";
import {textFont} from "./render";
import {fitTextEditorFrame, layoutTextLines, TEXT_TAB_SIZE, textEditorInsets} from "./text-layout.js";
import {handleTextEditorKey, isTextComposition, setTextComposition} from "./text-composition.js";
${editor.getText(tree)}
export {TextEditor};`;

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
      node.props.onChange({currentTarget: this, target: this});
    },
    nativeUndo(next) {
      value = next; this.selectionStart = this.selectionEnd = next.length;
      node.props.onChange({currentTarget: this, target: this});
    },
  };
  const h = createLibraryHarness({}, source, {
    modules: {"./model": {COLOR_HEX: {cherry: "#f53b58"}}, "./text-composition.js": composition,
      "./text-layout.js": layout, "./render": {textFont: size => `600 ${size}px sans-serif`}},
    attachRef(node) {if (node.type === "textarea") node.props.ref(textarea);},
    document: {createElement: () => ({getContext: () => ({measureText: text => ({width: text.length * 9})})})},
  });
  let finishes = 0;
  const props = {editing: {id: 1, index: 0, text, callout: {}, rect: {x: 130, y: 80, width: 160, height: 41},
    maxWidth: 280, uiScale: 1, fontSize: 18, color: "cherry", background: "transparent"},
    bounds: {width: 640, height: 360}, disabled: false, onTextChange: text => changes.push(text),
    onRectChange() {}, onCommit: () => finishes++, onCancel: () => finishes++, onUndo() {}, onRedo() {}, nativeUndo: true};
  const component = h.mount("TextEditor", props);
  let node = nodes(component.render()).find(node => node?.type === "textarea");
  return {textarea, writes, changes, commands, finishes: () => finishes,
    render(text, patch = {}) {node = nodes(component.render({...props, editing: {...props.editing, text, ...patch}})).find(node => node?.type === "textarea"); return node;},
    grip() {return nodes(component.render()).find(node => node?.type === "button");},
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
    assert.equal(node.props.style.background, "transparent");
    assert.equal(h.textarea.value, "abcXYdef");
    assert.equal(h.textarea.selectionStart, 5);
  }
  assert.deepEqual(h.changes, ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcXYdef"]);
  assert.deepEqual(h.writes, [""]);
});

test("the inline grip stays inside display edges and ordinary input remains transparent over saved backgrounds", () => {
  const h = input();
  h.render("", {rect: {x: 480, y: 0, width: 160, height: 41}});
  const grip = h.grip();
  assert.equal(grip.props.style.left, 624);
  assert.equal(grip.props.style.top, 0);
  const text = h.render("saved", {callout: undefined, background: "dark"});
  assert.equal(text.props.style.background, "transparent");
});

test("callout padding includes its border without narrowing the rendered text area", () => {
  const h = input();
  const node = h.render("saved");
  assert.equal(node.props.style.padding, 8);
  assert.equal(2 * (node.props.style.padding + 1), 18);
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
  assert.equal(h.finishes(), 0);
  assert.equal(h.key({key: "Escape"}).defaultPrevented, true);
  assert.equal(h.finishes(), 1);
  assert.equal(h.key({key: "Enter", ctrlKey: true}).defaultPrevented, true);
  assert.equal(h.finishes(), 2);
});
