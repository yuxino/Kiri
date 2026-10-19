import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import {createLibraryHarness, nodes} from "./helpers/library-render-harness.mjs";

// Render the actual control components. IPC, layout and native IME are tested
// separately by the product harness; this unit suite owns only property UI.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url), cache = new Map();
function load(path) {
  path = resolve(root, path);
  if (cache.has(path)) return cache.get(path).exports;
  const module = {exports: {}}; cache.set(path, module);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }}).outputText;
  new Function("require", "module", "exports", code)(name => {
    if (name.endsWith(".css")) return {};
    if (name === "../i18n") return {t: key => key};
    if (!name.startsWith(".")) return require(name);
    const base = resolve(dirname(path), name);
    return load([base, `${base}.tsx`, `${base}.ts`].find(existsSync));
  }, module, module.exports);
  return module.exports;
}
const {DEFAULT_APPEARANCE} = load("src/annotation/model.ts");
const {AnnotationStyleControls, selectedAnnotationAppearance} = load("src/annotation/AnnotationStyleControls.tsx");
const mosaic = {kind: "mosaic", id: 1, points: [{x: 10, y: 10}, {x: 80, y: 60}], shape: "rectangle",
  style: "pixel", intensity: "strong", brushDiameter: 53};
const watermark = {kind: "watermark", id: 2, text: "水印", rect: {x: 10, y: 10, width: 100, height: 28},
  color: "white", fontSize: 256, opacity: .32, rotation: 18, mode: "single", spacing: 700};
function controls(selected, overrides = {}) {
  const never = () => assert.fail("rendering or selecting must not update styling");
  return renderToStaticMarkup(React.createElement(AnnotationStyleControls, {
    tool: "select", selected, appearance: Object.freeze({...DEFAULT_APPEARANCE}), nextNumber: 1,
    onNextNumber: never, onCalloutEdit: never, onChange: never, onFinish: never, onEditText: never, onEditWatermark: never,
    ...overrides,
  }));
}

test("Select resolves an object's existing style without replacing preferences", () => {
  const preferences = Object.freeze({...DEFAULT_APPEARANCE});
  const mark = Object.freeze({kind: "rectangle", id: 3, rect: {x: 0, y: 0, width: 20, height: 20}, color: "white", width: 13});
  const result = selectedAnnotationAppearance(preferences, mark);
  assert.equal(result.colorPreset, "white"); assert.equal(result.shapeWidth, 13);
  assert.equal(preferences.colorPreset, "cherry"); assert.equal(preferences.shapeWidth, 3);
  const html = controls(mark);
  assert.match(html, /data-tool="rectangle"/); assert.match(html, /value="13"/);
  assert.match(html, /aria-label="White" aria-pressed="true"/);
});

test("mosaic area Pixel has semantic strength and no irrelevant color or diameter", () => {
  const html = controls(mosaic);
  assert.match(html, /data-tool="mosaic"/);
  for (const text of ["Freehand", "Rectangle", "Ellipse", "Soft", "Standard", "Strong"]) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /kiri-annotation-colors|type="range"|Effect size/);
});

test("area Blur exposes its real effect size; the brush exposes its diameter", () => {
  const area = controls({...mosaic, style: "blur"});
  assert.match(area, /Effect size/); assert.match(area, /value="53"/);
  const brush = controls({...mosaic, shape: "brush"});
  assert.match(brush, /aria-label="Brush"/); assert.match(brush, /value="53"/);
});

test("watermark reads independent color and percentage, preserving saved large values", () => {
  const values = selectedAnnotationAppearance(DEFAULT_APPEARANCE, watermark);
  assert.equal(values.watermarkColor, "white"); assert.equal(values.colorPreset, DEFAULT_APPEARANCE.colorPreset);
  assert.equal(values.watermarkOpacity, 32); assert.equal(values.watermarkFontSize, 256); assert.equal(values.watermarkSpacing, 700);
  const html = controls(watermark);
  assert.match(html, /Edit watermark/); assert.match(html, /value="256"/); assert.match(html, /value="32"/);
  assert.doesNotMatch(html, /textarea|type="text"|Watermark layout|>Single<|>Tiled</);
  assert.match(html, /Spacing/); assert.match(html, /value="700"/);
  assert.match(controls({...watermark, mode: "tiled"}), /value="700"/);
});

test("selected text actions stay in the heading, with a named quiet delete and contextual help", () => {
  const html = controls({kind: "callout", id: 5, number: 2, text: "说明", color: "cherry", size: 36, fontSize: 18, style: "filled"}, {onDelete() {}});
  const heading = html.slice(0, html.indexOf('class="kiri-annotation-control-fields"'));
  assert.match(heading, /Edit text/);
  assert.match(heading, /aria-label="Delete annotation" title="Delete annotation"/);
  assert.match(heading, /class="kiri-annotation-help"/);
  assert.match(heading, /role="tooltip"/);
  assert.doesNotMatch(heading, /Selected object/);
  assert.doesNotMatch(html.slice(heading.length), /Edit text|Double-click/);
});

test("the selected color has both a pressed state and a visible check", () => {
  const html = controls({kind: "rectangle", id: 6, color: "white", width: 4});
  assert.match(html, /aria-label="White" aria-pressed="true"[^>]*>[\s\S]*?lucide-check/);
  assert.match(html, /kiri-annotation-choice-label">Color/);
  assert.equal((html.match(/lucide-check/g) ?? []).length, 1);
});

test("heading actions preserve text focus and isolate Return/Space from capture shortcuts", () => {
  const source = 'import React from "react";\n' + readFileSync(resolve(root, "src/annotation/AnnotationStyleControls.tsx"), "utf8");
  const h = createLibraryHarness({}, source, {modules: {
    "./AnnotationControlFields": {AnnotationChoices: "choices", AnnotationColors: "colors", AnnotationNumberControl: "number"},
    "./MosaicControls": {MosaicControls: "mosaic"}, "./WatermarkControls": {WatermarkControls: "watermark"},
    "./annotation-controls.css": {},
  }});
  let edits = 0, deletes = 0, prevented = 0, stopped = 0;
  const props = {tool: "select", selected: {kind: "text", id: 2, color: "white", fontSize: 20, background: "transparent"},
    appearance: DEFAULT_APPEARANCE, nextNumber: 1, onEditText() {edits++;}, onDelete() {deletes++;}};
  const component = h.mount("AnnotationStyleControls", props);
  const buttons = nodes(component.render()).filter(node => node.type === "button" && node.props.className?.includes("kiri-annotation-action"));
  assert.equal(buttons.length, 2);
  buttons[0].props.onPointerDown({preventDefault() {prevented++;}});
  buttons[0].props.onClick(); buttons[1].props.onClick();
  for (const key of ["Enter", " "]) for (const button of buttons) button.props.onKeyDown({key, stopPropagation() {stopped++;}});
  assert.deepEqual({edits, deletes, prevented, stopped}, {edits: 1, deletes: 1, prevented: 1, stopped: 4});
  const help = nodes(component.render({...props, disabled: true})).find(node => node.type === "button" && node.props.className === "kiri-annotation-help-button");
  assert.equal(help.props.disabled, true);
});

function numberControl(overrides = {}) {
  const changes = [], finishes = [];
  const source = 'import React from "react";\n' + readFileSync(resolve(root, "src/annotation/AnnotationControlFields.tsx"), "utf8");
  const harness = createLibraryHarness({}, source, {modules: {"./model": load("src/annotation/model.ts")}});
  let props = {label: "Opacity", value: 20, min: 0, max: 100,
    onChange(value, transient) {changes.push({value, transient}); props = {...props, value};},
    onFinish() {finishes.push(true);}, ...overrides};
  const component = harness.mount("AnnotationNumberControl", props);
  const input = type => nodes(component.render(props)).find(node => node.type === "input" && node.props.type === type);
  return {input, changes, finishes};
}

test("one pointer gesture previews live and finishes once despite capture cleanup", () => {
  const h = numberControl();
  const target = {focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({left: 0, width: 112})};
  h.input("range").props.onPointerDown({button: 0, clientX: 26, pointerId: 1, currentTarget: target, preventDefault() {}});
  h.input("range").props.onPointerMove({clientX: 66, currentTarget: target});
  h.input("range").props.onPointerUp(); h.input("range").props.onLostPointerCapture();
  assert.deepEqual(h.changes, [{value: 20, transient: true}, {value: 60, transient: true}]);
  assert.equal(h.finishes.length, 1);
});

test("a stationary drag preserves saved values beyond the default slider limits", () => {
  const h = numberControl({label: "Font", value: 256, min: 12, max: 128});
  const target = {focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({left: 0, width: 112})};
  h.input("range").props.onPointerDown({button: 0, clientX: 66, pointerId: 1, currentTarget: target, preventDefault() {}});
  assert.equal(h.changes.at(-1).value, 158);
  // React receives the live value between moves. A stationary pointer must
  // retain its value and the same track bounds throughout the gesture.
  assert.equal(h.input("range").props.max, 256);
  h.input("range").props.onPointerMove({clientX: 66, currentTarget: target});
  assert.equal(h.changes.at(-1).value, 158);
  h.input("range").props.onPointerMove({clientX: 106, currentTarget: target});
  assert.equal(h.changes.at(-1).value, 256);
  assert.equal(h.finishes.length, 0);
  h.input("range").props.onPointerUp();
  h.input("range").props.onLostPointerCapture();
  assert.equal(h.finishes.length, 1);
});

test("range arrow keys retain native input handling and finish after key release", () => {
  const h = numberControl({label: "Number size", value: 36, min: 24, max: 72});
  let stopped = 0;
  h.input("range").props.onKeyDown({key: "ArrowRight", stopPropagation() {stopped++;},
    preventDefault() {assert.fail("Arrow keys must retain native range stepping");}});
  h.input("range").props.onChange({target: {value: "37"}});
  assert.equal(h.input("range").props.value, 37);
  assert.equal(h.finishes.length, 0);
  h.input("range").props.onKeyUp();
  assert.equal(stopped, 1);
  assert.deepEqual(h.changes, [{value: 37, transient: true}]);
  assert.equal(h.finishes.length, 1);
});

test("a keyboard number edit tolerates an empty draft and commits on leaving the field", () => {
  const h = numberControl();
  h.input("number").props.onFocus();
  h.input("number").props.onChange({target: {value: ""}});
  assert.equal(h.changes.length, 0);
  h.input("number").props.onChange({target: {value: "35"}});
  assert.deepEqual(h.changes, [{value: 35, transient: true}]);
  let stopped = 0, prevented = 0;
  h.input("number").props.onKeyDown({key: "Enter", stopPropagation() {stopped++;}, preventDefault() {prevented++;},
    currentTarget: {blur() {h.input("number").props.onBlur();}}});
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(h.finishes.length, 1);
  assert.equal(h.input("number").props.value, "35");
});


test("overlay panel chrome shares the existing heading without adding another options title", () => {
  const html = controls(null, {tool: "text", panelChrome: React.createElement("button", {"aria-label": "Hide tool options"}, "chrome")});
  const heading = html.slice(0, html.indexOf('class="kiri-annotation-control-fields"'));
  assert.ok(heading.includes('aria-label="Hide tool options"'));
  assert.equal((html.match(/kiri-annotation-controls-heading/g) ?? []).length, 1);
  assert.doesNotMatch(controls(null, {tool: "text"}), /Hide tool options/);
});
