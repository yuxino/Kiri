import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createLibraryHarness, nodes } from "./helpers/library-render-harness.mjs";
import * as project from "../src/annotation/project.js";
import * as crop from "../src/annotation/crop.js";
import * as layout from "../src/annotation/text-layout.js";
import * as composition from "../src/annotation/text-composition.js";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = source => ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
}}).outputText;
const geom = await import(dataUrl(compile(readFileSync(new URL("../src/annotation/geom.ts", import.meta.url), "utf8"))));
const geomUrl = dataUrl(compile(readFileSync(new URL("../src/annotation/geom.ts", import.meta.url), "utf8")));
const model = await import(dataUrl(compile(readFileSync(new URL("../src/annotation/model.ts", import.meta.url), "utf8")
  .replaceAll('"./geom"', JSON.stringify(geomUrl)))));
const source = readFileSync(new URL("../src/annotation/AnnotationCanvas.tsx", import.meta.url), "utf8");
const text = {kind: "text", id: 1, text: "first line\nsecond line", rect: {x: 40, y: 40, width: 180, height: 45},
  color: "white", background: "transparent", fontSize: 18};
const rectangle = {kind: "rectangle", id: 2, rect: {x: 100, y: 100, width: 100, height: 80}, color: "white", width: 3};
const appearance = model.DEFAULT_APPEARANCE;

const label = {...text, color:"cherry", labelDirection:"left", rect:{x:140,y:100,width:150,height:45}};
function dotButton(h) {
  const node = nodes(h.component.render()).find(node=>node?.type?.name==="LabelDot");
  assert.ok(node, "the visible label has an accessible dot control");
  return node.type(node.props);
}

test("clicking a label dot flips once without moving text, starts no drag, and survives undo/reopen", async()=>{
  const h=annotation(documentWith([label]),{selectedMarkId:label.id});
  let stopped=0, prevented=0;
  const event={key:"Enter",stopPropagation(){stopped++;},preventDefault(){prevented++;}};
  const button=dotButton(h);
  button.props.onPointerDown(event); button.props.onKeyDown(event); button.props.onKeyUp(event);
  assert.equal(stopped,3); assert.equal(prevented,1);
  button.props.onClick(event); h.component.render();
  const flipped={...label,labelDirection:"right"};
  assert.deepEqual(h.changes.at(-1),[flipped]);
  assert.equal(h.changes.length,1);
  const saved=await h.ref.current.exportResult();
  const reopened=annotation(saved.document);
  assert.deepEqual((await reopened.ref.current.exportResult()).document.marks,[flipped]);
  h.ref.current.undo();h.component.render();assert.deepEqual(h.changes.at(-1),[label]);
  h.ref.current.redo();h.component.render();assert.deepEqual(h.changes.at(-1),[flipped]);
});

test("label font changes remain a single edit and keep both possible dots inside narrow canvases",()=>{
  const h=annotation(documentWith([label]),{selectedMarkId:label.id});
  h.ref.current.updateSelectionAppearance({textFontSize:64},true);
  h.ref.current.updateSelectionAppearance({textFontSize:32},true);
  h.ref.current.finishAppearanceAdjustment();h.component.render();
  assert.equal(h.changes.length,1);
  const resized=h.changes[0][0];
  const bounds=model.labelMovementBounds(resized);
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=640&&bounds.y+bounds.height<=360);
  assert.equal(resized.labelDirection,"left");
  h.ref.current.undo();h.component.render();assert.deepEqual(h.changes.at(-1),[label]);
});

function annotation(initialDocument, options = {}) {
  const exports = [], frames = [], creations = [], ref = {current: null}, changes = [];
  function canvas() {
    const value = {width: 640, height: 360, drawCalls: [],
      getBoundingClientRect: () => options.boundingRect?.() ?? ({left: 0, top: 0, width: initialDocument.canvas.width, height: initialDocument.canvas.height}),
      setPointerCapture() {}, releasePointerCapture() {},
      toBlob(callback) { callback(new Blob([new Uint8Array([1, 2, 3])], {type: "image/png"})); },
    };
    const context = {font: "", setTransform() {}, save() {}, restore() {},
      measureText(text) { const size = Number(this.font.match(/ ([\d.]+)px/)?.[1] ?? 18); return {width: options.measureText?.(text, size) ?? text.length * size * .4}; },
      drawImage: (...args) => value.drawCalls.push(args)};
    value.getContext = () => context;
    creations.push(value);
    return value;
  }
  const live = canvas();
  const image = {complete: true, naturalWidth: initialDocument.sourcePixels.width, naturalHeight: initialDocument.sourcePixels.height};
  const harness = createLibraryHarness({}, source, {
    modules: {
      "./geom": geom, "./model": model, "./project.js": project, "./crop.js": crop,
      "./text-layout.js": layout, "./text-composition.js": composition,
      "./render": {textFont: size => `600 ${size}px sans-serif`, renderAll(r, marks, options) {
        if (!r.exporting) frames.push({marks: structuredClone(marks), options: structuredClone(options)});
        if (r.exporting) exports.push({source: r.sourceImage, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight,
          sourceOffset: r.sourceOffset, regionSize: r.regionSize, scaleX: r.scaleX, scaleY: r.scaleY,
          marks: structuredClone(marks), canvasWidth: r.ctx.canvas?.width});
      }},
    },
    document: {createElement: type => { assert.equal(type, "canvas"); return canvas(); }},
    globals: {devicePixelRatio: 1},
    attachRef(node) { if (node.type === "canvas") node.props.ref.current = live; },
  });
  const props = {ref, image, region: {x: 0, y: 0, ...initialDocument.canvas}, initialDocument,
    appearance, tool: "select", onHistoryChange() {}, onCancel() {},
    onDocumentChange: marks => changes.push(structuredClone(marks)), ...options};
  const component = harness.mount("default", props);
  component.render();
  return {component, props, ref, changes, exports, frames, creations, live,
    pointer(name, x, y) {
      const node = nodes(component.render()).find(node => node?.type === "canvas");
      node.props[name]({clientX: x, clientY: y, button: 0, pointerId: 1, detail: 1,
        currentTarget: live, preventDefault() {}, stopPropagation() {}});
      component.render();
    },
  };
}

const documentWith = marks => ({schemaVersion: 1, canvas: {width: 640, height: 360}, sourcePixels: {width: 640, height: 360}, marks});

test("numbered notes create on click or drag and retain descriptions through export and reopen", async () => {
  const h = annotation(documentWith([]), {tool: "callout", calloutNumber: 7});
  h.pointer("onPointerDown", 80, 90); h.pointer("onPointerUp", 80, 90);
  const placed = h.changes.at(-1)[0];
  assert.equal(placed.kind, "callout"); assert.equal(placed.number, 7);
  assert.equal(placed.style, "filled"); assert.equal(model.nextCalloutNumber([placed]), 8);
  h.ref.current.updateSelectedCallout({text: "标题\nA short explanation", number: 12}, true);
  h.component.render();
  h.ref.current.updateSelectedCallout({size: 48, style: "outline"}, true);
  h.component.render();
  h.ref.current.finishAppearanceAdjustment(); h.component.render();
  const saved = h.changes.at(-1)[0];
  assert.equal(saved.text, "标题\nA short explanation"); assert.equal(saved.number, 12);
  assert.ok(saved.labelRect.height > saved.fontSize * 2);
  const exported = await h.ref.current.exportResult();
  assert.deepEqual(exported.document.marks, [saved]);
  const reopened = annotation(exported.document);
  assert.deepEqual(reopened.frames.at(-1).marks, [saved]);
  h.ref.current.undo(); h.component.render();
  assert.deepEqual(h.changes.at(-1), [placed], "one undo restores the complete inspector edit");
  h.ref.current.redo(); h.component.render();
  assert.deepEqual(h.changes.at(-1), [saved]);
  h.component.render({...h.props, calloutNumber: 13});
  h.pointer("onPointerDown", 90, 260); h.pointer("onPointerUp", 350, 280);
  assert.equal(h.changes.at(-1)[1].number, 13);
  assert.ok(h.changes.at(-1)[1].labelRect.x > 300);
});

test("number and description handles move independently, stay in bounds, and undo exactly", () => {
  const mark = {kind: "callout", id: 1, center: {x: 80, y: 80}, number: 1, text: "説明",
    labelRect: {x: 200, y: 60, width: 100, height: 40}, size: 36, fontSize: 18, color: "cherry", style: "filled"};
  const h = annotation(documentWith([mark]), {selectedMarkId: mark.id});
  h.pointer("onPointerDown", 80, 62); h.pointer("onPointerMove", 120, 102); h.pointer("onPointerUp", 120, 102);
  assert.deepEqual(h.changes.at(-1)[0].labelRect, mark.labelRect);
  assert.deepEqual(h.changes.at(-1)[0].center, {x: 120, y: 120});
  h.ref.current.undo(); h.component.render();
  h.pointer("onPointerDown", 250, 80); h.pointer("onPointerMove", 620, 350); h.pointer("onPointerUp", 620, 350);
  // Undo clears selection; this first drag moves the whole note. Select again for a handle drag.
  const current = h.changes.at(-1)[0];
  assert.ok(current.labelRect.x + current.labelRect.width <= 640);
  assert.ok(current.labelRect.y + current.labelRect.height <= 360);
  h.ref.current.undo(); h.component.render();
  h.pointer("onPointerDown", 250, 80); h.pointer("onPointerUp", 250, 80);
  h.pointer("onPointerDown", 300, 60); h.pointer("onPointerUp", 340, 90);
  const movedLabel = h.changes.at(-1)[0];
  assert.deepEqual(movedLabel.center, mark.center);
  assert.deepEqual(movedLabel.labelRect, {...mark.labelRect, x: 240, y: 90});
  h.ref.current.undo(); h.component.render();
  assert.deepEqual(h.changes.at(-1), [mark]);
});

test("opening the callout inspector during selection cannot move a mark or distort a drag", () => {
  const mark = {kind: "callout", id: 1, center: {x: 80, y: 80}, number: 1, text: "説明",
    labelRect: {x: 200, y: 60, width: 100, height: 40}, size: 36, fontSize: 18, color: "cherry", style: "filled"};
  let rect = {left: 0, top: 0, width: 640, height: 360};
  const h = annotation(documentWith([mark]), {boundingRect: () => rect});
  h.pointer("onPointerDown", 80, 80);
  rect = {left: 80, top: 100, width: 480, height: 270};
  h.pointer("onPointerMove", 80, 80); h.pointer("onPointerUp", 80, 80);
  assert.deepEqual(h.changes, [], "a stationary click stays a selection, with no undo entry");
  assert.deepEqual(h.frames.at(-1).marks, [mark]);
  rect = {left: 0, top: 0, width: 640, height: 360};
  h.pointer("onPointerDown", 80, 80);
  rect = {left: 80, top: 100, width: 480, height: 270};
  h.pointer("onPointerMove", 100, 90); h.pointer("onPointerUp", 100, 90);
  assert.deepEqual(h.changes.at(-1)[0].center, {x: 100, y: 90});
  assert.deepEqual(h.changes.at(-1)[0].labelRect, {...mark.labelRect, x: 220, y: 70});
});

test("keyboard-style live font changes update the selected mark and commit one undoable edit", () => {
  const h = annotation(documentWith([text]), {selectedMarkId: text.id});
  h.ref.current.setTextFontSizeLive(32); // Keyboard input has no pointerdown.
  h.component.render();
  h.ref.current.setTextFontSizeLive(48);
  h.component.render();
  h.ref.current.endTextFontSizeAdjustment();
  h.component.render();
  assert.equal(h.changes.length, 1);
  const larger = h.changes[0][0];
  assert.equal(larger.fontSize, 48);
  assert.equal(larger.rect.width, text.rect.width * 48 / 18);
  assert.equal(larger.rect.height, text.rect.height * 48 / 18);
  h.ref.current.undo();
  h.component.render();
  assert.deepEqual(h.changes.at(-1), [text]);
});

test("font changes repair a previously saved short text box using explicit and wrapped lines", () => {
  const legacy = {...text, text: "long words wrap here\nsecond paragraph", fontSize: 48,
    rect: {x: 40, y: 40, width: 180, height: 45}};
  const h = annotation(documentWith([legacy]), {selectedMarkId: legacy.id});
  h.ref.current.setTextFontSizeLive(36);
  h.component.render();
  h.ref.current.endTextFontSizeAdjustment();
  h.component.render();
  const repaired = h.changes.at(-1)[0];
  const lines = layout.layoutTextLines(repaired.text, repaired.rect.width, value => value.length * 36 * .4);
  assert.ok(lines.length > 2, "the two paragraphs also need automatic wrapping");
  assert.equal(repaired.rect.height, Math.ceil(lines.length * 36 * 1.25));
  assert.ok(repaired.rect.height > legacy.rect.height);
  const lastLine = {x: repaired.rect.x + 10, y: repaired.rect.y + (lines.length - 1) * 36 * 1.25 + 10};
  assert.equal(model.markIndexAt([repaired], lastLine), 0);
  h.ref.current.undo();
  h.component.render();
  assert.deepEqual(h.changes.at(-1), [legacy]);
});

test("repairing bounds at the same font size is still one undoable change", () => {
  const legacy = {...text, rect: {...text.rect, height: 10}};
  const h = annotation(documentWith([legacy]), {selectedMarkId: legacy.id});
  h.ref.current.setTextFontSizeLive(18);
  h.ref.current.endTextFontSizeAdjustment();
  h.component.render();
  assert.equal(h.changes.at(-1)[0].rect.height, 45);
  h.ref.current.undo();
  h.component.render();
  assert.deepEqual(h.changes.at(-1), [legacy]);
});

test("clicking an off-center resize handle does not insert an invisible undo step", () => {
  const h = annotation(documentWith([rectangle]), {selectedMarkId: rectangle.id});
  h.pointer("onPointerDown", 140, 140);
  h.pointer("onPointerMove", 170, 150);
  h.pointer("onPointerUp", 170, 150);
  const moved = h.changes.at(-1)[0];
  assert.equal(moved.rect.x, 130);
  assert.equal(moved.rect.y, 110);
  h.pointer("onPointerDown", 183, 114); // Inside the 9px handle target, off its center.
  h.pointer("onPointerUp", 183, 114);
  assert.equal(h.changes.length, 1);
  h.ref.current.undo();
  h.component.render();
  assert.deepEqual(h.changes.at(-1), [rectangle]);
});

test("a cropped mosaic is exported using the same source bounds and document as reopening", async () => {
  const mosaic = {kind: "mosaic", id: 3, points: [{x: 200, y: 180}, {x: 460, y: 180}],
    brushDiameter: 20, intensity: "standard", style: "pixel"};
  const h = annotation(documentWith([mosaic]));
  const first = await h.ref.current.exportResult({x: 250, y: 0, width: 390, height: 360});
  assert.deepEqual(first.cropPixels, {x: 250, y: 0, width: 390, height: 360});
  assert.deepEqual(first.document.marks[0].points, [{x: -50, y: 180}, {x: 210, y: 180}]);
  const firstRender = h.exports[0];
  assert.equal(firstRender.sourceWidth, 390);
  assert.equal(firstRender.sourceHeight, 360);
  assert.deepEqual(firstRender.sourceOffset, {x: 0, y: 0});
  assert.deepEqual(firstRender.source.drawCalls[0].slice(1), [250, 0, 390, 360, 0, 0, 390, 360]);
  const reopened = annotation(first.document);
  const second = await reopened.ref.current.exportResult();
  assert.equal(second.cropPixels, null);
  assert.deepEqual(second.document, first.document);
  const reopenedRender = reopened.exports[0];
  for (const key of ["sourceWidth", "sourceHeight", "sourceOffset", "regionSize", "scaleX", "scaleY", "marks"]) {
    assert.deepEqual(reopenedRender[key], firstRender[key], key);
  }
});


for (const handle of ["right", "left", "top", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight"]) {
  test(`text ${handle} resize remeasures wrapped preview and saves one fully hittable edit`, async () => {
    const original = {...text, text: "ALPHA BETA GAMMA DELTA\nONE TWO THREE FOUR FIVE", fontSize: 14,
      rect: {x: 180, y: 110, width: 130, height: 35}};
    // Real font hinting is not perfectly proportional. Simulate the smaller
    // font crossing a wrap threshold to exercise the native regression.
    const measureText = (value, size) => value.length * size * (size < 14 ? .6 : .4);
    const h = annotation(documentWith([original]), {selectedMarkId: original.id, measureText});
    const start = geom.handlePoint(handle, original.rect);
    const end = {x: start.x + (handle.toLowerCase().includes("left") ? 40 : -40),
      y: start.y + (handle.startsWith("top") ? 12 : -12)};
    h.pointer("onPointerDown", start.x, start.y);
    h.pointer("onPointerMove", end.x, end.y);
    assert.equal(h.changes.length, 0, "preview must not commit history");
    const preview = h.frames.at(-1).marks[0];
    h.pointer("onPointerUp", end.x, end.y);
    assert.equal(h.changes.length, 1);
    const resized = h.changes[0][0];
    const lines = layout.layoutTextLines(resized.text, resized.rect.width,
      value => measureText(value, resized.fontSize));
    assert.ok(lines.length > 2, "the simulated font needs additional wrapped lines");
    assert.equal(resized.rect.height, Math.ceil(lines.length * resized.fontSize * 1.25));
    assert.deepEqual(preview, resized, "drag preview and committed bounds agree");
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8);
    if (handle.startsWith("top")) close(resized.rect.y + resized.rect.height, original.rect.y + original.rect.height);
    else if (handle.startsWith("bottom")) close(resized.rect.y, original.rect.y);
    else close(resized.rect.y + resized.rect.height / 2, original.rect.y + original.rect.height / 2);
    const lastLine = {x: resized.rect.x + 10,
      y: resized.rect.y + (lines.length - .5) * resized.fontSize * 1.25};
    assert.equal(model.markIndexAt([resized], lastLine), 0);
    const saved = await h.ref.current.exportResult();
    const reopened = annotation(saved.document, {measureText});
    const savedAgain = await reopened.ref.current.exportResult();
    assert.deepEqual(savedAgain.document.marks, [resized]);
    assert.equal(model.markIndexAt(savedAgain.document.marks, lastLine), 0);
    h.ref.current.undo(); h.component.render();
    assert.deepEqual(h.changes.at(-1), [original]);
    h.ref.current.redo(); h.component.render();
    assert.deepEqual(h.changes.at(-1), [resized]);
  });
}

test("a text handle click without motion does not repair bounds or create history", () => {
  const legacy = {...text, rect: {...text.rect, height: 10}};
  const h = annotation(documentWith([legacy]), {selectedMarkId: legacy.id});
  const point = geom.handlePoint("right", legacy.rect);
  h.pointer("onPointerDown", point.x, point.y);
  h.pointer("onPointerMove", point.x + .2, point.y);
  assert.deepEqual(h.frames.at(-1).marks[0], legacy);
  h.pointer("onPointerUp", point.x + .2, point.y);
  assert.equal(h.changes.length, 0);
});


test("resizing an older malformed saved text box repairs all wrapped-line hit bounds", () => {
  const legacy = {...text, text: "ALPHA BETA GAMMA DELTA\nONE TWO THREE FOUR FIVE", fontSize: 14,
    rect: {x: 180, y: 110, width: 90, height: 35}};
  const h = annotation(documentWith([legacy]), {selectedMarkId: legacy.id});
  const point = geom.handlePoint("right", legacy.rect);
  h.pointer("onPointerDown", point.x, point.y);
  h.pointer("onPointerUp", point.x + 20, point.y);
  const repaired = h.changes.at(-1)[0];
  const lines = layout.layoutTextLines(repaired.text, repaired.rect.width,
    value => value.length * repaired.fontSize * .4);
  assert.ok(lines.length > 2);
  assert.equal(repaired.rect.height, Math.ceil(lines.length * repaired.fontSize * 1.25));
  assert.equal(model.markIndexAt([repaired], {x: repaired.rect.x + 5,
    y: repaired.rect.y + (lines.length - .5) * repaired.fontSize * 1.25}), 0);
});


for (const sample of [
  {name: "full-height side", handle: "right", fontSize: 120, rect: {x: 180, y: 30, width: 160, height: 300}, dx: -16, dy: 0},
  {name: "near-top anchored", handle: "top", fontSize: 14, rect: {x: 180, y: 5, width: 20, height: 35}, dx: 0, dy: 4},
  {name: "near-bottom anchored", handle: "bottom", fontSize: 14, rect: {x: 180, y: 320, width: 20, height: 35}, dx: 0, dy: -4},
]) {
  test(`${sample.name} text resize fits measured lines without moving its anchor`, () => {
    const original = {...text, text: "A B\nC D", fontSize: sample.fontSize, rect: sample.rect};
    const measureText = (value, size) => value.length * size * (size < sample.fontSize ? .6 : .4);
    const h = annotation(documentWith([original]), {selectedMarkId: original.id, measureText});
    const start = geom.handlePoint(sample.handle, original.rect);
    h.pointer("onPointerDown", start.x, start.y);
    h.pointer("onPointerMove", start.x + sample.dx, start.y + sample.dy);
    const preview = h.frames.at(-1).marks[0];
    h.pointer("onPointerUp", start.x + sample.dx, start.y + sample.dy);
    const resized = h.changes.at(-1)[0];
    assert.deepEqual(preview, resized);
    const lines = layout.layoutTextLines(resized.text, resized.rect.width,
      value => measureText(value, resized.fontSize));
    assert.equal(resized.rect.height, Math.ceil(lines.length * resized.fontSize * 1.25));
    assert.ok(resized.rect.y >= 0);
    assert.ok(resized.rect.y + resized.rect.height <= 360);
    const actual = sample.handle === "top" ? resized.rect.y + resized.rect.height :
      sample.handle === "bottom" ? resized.rect.y : resized.rect.y + resized.rect.height / 2;
    const expected = sample.handle === "top" ? original.rect.y + original.rect.height :
      sample.handle === "bottom" ? original.rect.y : original.rect.y + original.rect.height / 2;
    assert.ok(Math.abs(actual - expected) < 1e-8);
  });
}

const movableMarks = [
  rectangle,
  label,
  {...text, rect: {x: 100, y: 100, width: 100, height: 80}},
  {kind: "pen", id: 3, points: [{x:100,y:100},{x:200,y:180}], color:"white", width:3},
  {kind: "line", id: 4, start:{x:100,y:100}, end:{x:200,y:180}, color:"white", width:3},
  {kind: "arrow", id: 5, start:{x:100,y:100}, end:{x:200,y:180}, color:"white", width:3},
  ...["brush", "rectangle", "ellipse"].map((shape,index) => ({kind:"mosaic",id:6+index,
    points:[{x:100,y:100},{x:200,y:180}],shape,brushDiameter:20,intensity:"standard",style:"pixel"})),
];

for (const mark of movableMarks) {
  test(`${mark.kind} ${mark.shape ?? ""} moves as one live mark, preserving layers, cancel and undo`, () => {
    const under = {...rectangle, id:90, rect:{x:400,y:100,width:30,height:30}};
    const over = {...rectangle, id:91, rect:{x:450,y:100,width:30,height:30}};
    const liveFrames = [];
    const h = annotation(documentWith([under,mark,over]), {selectedMarkId:mark.id,
      onLiveMarks: (marks,draft) => liveFrames.push({marks:structuredClone(marks),draft})});
    h.pointer("onPointerDown",150,140);
    h.pointer("onPointerMove",180,160);
    const frame = h.frames.at(-1);
    const moved = model.translateMark(mark,{x:30,y:20},{x:0,y:0,width:640,height:360});
    assert.deepEqual(frame.marks,[under,moved,over],"replace the old mark in its layer before releasing the pointer");
    assert.equal(frame.options.draft,null,"never draw a duplicate above the original");
    assert.equal(frame.options.selectedIndex,1,"handles follow the replacement");
    assert.deepEqual(liveFrames.at(-1),{marks:[under,moved,over],draft:null},"video uses the same live geometry");
    assert.equal(h.changes.length,0,"preview does not mutate the saved document");
    h.pointer("onPointerCancel",180,160);
    assert.deepEqual(h.frames.at(-1).marks,[under,mark,over]);
    assert.equal(h.changes.length,0);
    h.pointer("onPointerDown",150,140);
    h.pointer("onPointerMove",180,160);
    h.pointer("onPointerUp",180,160);
    assert.deepEqual(h.changes.at(-1),[under,moved,over]);
    h.ref.current.undo(); h.component.render();
    assert.deepEqual(h.changes.at(-1),[under,mark,over],"one undo restores the whole gesture");
    h.component.unmount();
  });
}

for (const mark of movableMarks) {
  test(`${mark.kind} ${mark.shape ?? ""} resize preview removes the old geometry and follows the handle`, () => {
    const h = annotation(documentWith([mark]), {selectedMarkId:mark.id});
    const bounds = model.selectionBounds(mark);
    const linear = mark.kind === "line" || mark.kind === "arrow";
    const point = linear ? mark.end : {x:bounds.x+bounds.width,y:bounds.y+bounds.height};
    h.pointer("onPointerDown",point.x,point.y);
    h.pointer("onPointerMove",point.x+30,point.y+20);
    const frame = h.frames.at(-1);
    assert.equal(frame.marks.length,1);
    assert.notDeepEqual(frame.marks[0],mark);
    assert.equal(frame.options.draft,null);
    assert.equal(frame.options.selectedIndex,0);
    assert.equal(h.changes.length,0);
    h.pointer("onPointerUp",point.x+30,point.y+20);
    assert.deepEqual(h.changes.at(-1),frame.marks);
    h.ref.current.undo();h.component.render();
    assert.deepEqual(h.changes.at(-1),[mark]);
    h.component.unmount();
  });
}

test("a newly drawn rectangle moves immediately and can be reopened without a ghost", () => {
  const h = annotation(documentWith([]), {tool:"rectangle"});
  h.pointer("onPointerDown",100,100);h.pointer("onPointerMove",200,180);h.pointer("onPointerUp",200,180);
  const mark = h.changes.at(-1)[0];
  h.component.render({...h.props,tool:"select"});
  h.pointer("onPointerDown",150,140);h.pointer("onPointerMove",180,160);
  assert.equal(h.frames.at(-1).marks.length,1);
  assert.equal(h.frames.at(-1).marks[0].rect.x,130);
  assert.equal(h.frames.at(-1).options.draft,null);
  h.pointer("onPointerUp",180,160);
  const reopened = annotation(documentWith(h.changes.at(-1)),{selectedMarkId:mark.id});
  reopened.pointer("onPointerDown",180,160);reopened.pointer("onPointerMove",190,170);
  assert.equal(reopened.frames.at(-1).marks.length,1);
  assert.equal(reopened.frames.at(-1).marks[0].rect.x,140);
  assert.equal(reopened.frames.at(-1).options.draft,null);
  h.component.unmount();reopened.component.unmount();
});

test("selecting a label stays stationary when its inspector changes the stage mid-click",()=>{
  const h=annotation(documentWith([label]));
  h.pointer("onPointerDown",200,120);
  h.live.getBoundingClientRect=()=>({left:20,top:30,width:512,height:288});
  h.pointer("onPointerUp",200,120);
  assert.equal(h.changes.length,0);
  assert.deepEqual(h.frames.at(-1).marks,[label]);
  const button=dotButton(h);
  button.props.onClick({stopPropagation(){}});h.component.render();
  assert.deepEqual(h.changes.at(-1),[{...label,labelDirection:"right"}]);
});
