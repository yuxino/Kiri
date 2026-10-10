import assert from "node:assert/strict";
import test from "node:test";
import {watermarkTilePlan,watermarkIntersectsRect} from "../src/annotation/watermark-geometry.js";

import {
  cropAnnotationDocument,
  cropPixelsFromDocumentRect,
  fullCropRect,
  isFullCrop,
} from "../src/annotation/crop.js";

function documentWithMarks() {
  return {
    schemaVersion: 1,
    canvas: { width: 600, height: 400 },
    sourcePixels: { width: 1200, height: 800 },
    marks: [
      { kind: "rectangle", id: 1, rect: { x: 50, y: 40, width: 100, height: 80 }, color: "violet", width: 3 },
      { kind: "line", id: 2, start: { x: 250, y: 150 }, end: { x: 500, y: 300 }, color: "orange", width: 3 },
      { kind: "text", id: 3, text: "outside", rect: { x: 500, y: 20, width: 80, height: 30 }, color: "white", background: "transparent", fontSize: 18 },
    ],
  };
}

test("crop preserves tiled watermark anchor phase even when the editable master is outside",()=>{
  const mark={kind:"watermark",id:11,text:"© Kiri",rect:{x:10,y:10,width:100,height:30},color:"black",
    fontSize:24,opacity:.2,rotation:-30,mode:"tiled",spacing:80};
  const document={...documentWithMarks(),marks:[mark]},crop={x:200,y:150,width:200,height:160};
  const result=cropAnnotationDocument(document,crop).document;
  assert.equal(result.marks.length,1);assert.deepEqual(result.marks[0].rect,{...mark.rect,x:-190,y:-140});
  const before=watermarkTilePlan(mark,crop),after=watermarkTilePlan(result.marks[0],{x:0,y:0,...result.canvas});
  assert.equal(before.stepX,after.stepX);assert.equal(before.stepY,after.stepY);
  assert.equal(before.startColumn,after.startColumn);assert.equal(before.endColumn,after.endColumn);
  assert.equal(before.startRow,after.startRow);assert.equal(before.endRow,after.endRow);
});

test("single watermark crop follows rotated content rather than its unrotated rect",()=>{
  const mark={kind:"watermark",id:12,text:"Kiri",rect:{x:100,y:100,width:100,height:20},color:"black",
    fontSize:18,opacity:.5,rotation:90,mode:"single",spacing:80};
  const document={...documentWithMarks(),marks:[mark]},rotatedEdge={x:145,y:145,width:10,height:10};
  assert.equal(watermarkIntersectsRect(mark,rotatedEdge),true);
  assert.equal(cropAnnotationDocument(document,rotatedEdge).document.marks.length,1);
  const unrotatedOnly={x:190,y:100,width:8,height:8};
  assert.equal(watermarkIntersectsRect(mark,unrotatedOnly),false);
  assert.equal(cropAnnotationDocument(document,unrotatedOnly).document.marks.length,0);
});

test("full crop is a no-op at Retina scale", () => {
  const document = documentWithMarks();
  const full = fullCropRect(document);
  assert.equal(isFullCrop(document, full), true);
  assert.deepEqual(cropPixelsFromDocumentRect(document, full), {
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  });
});

test("crop snaps to source pixels, translates intersections, and drops outside marks", () => {
  const result = cropAnnotationDocument(documentWithMarks(), {
    x: 100.2,
    y: 79.8,
    width: 300.1,
    height: 200.4,
  });
  assert.deepEqual(result.cropPixels, { x: 200, y: 160, width: 601, height: 400 });
  assert.deepEqual(result.document.canvas, { width: 300.5, height: 200 });
  assert.deepEqual(result.document.sourcePixels, { width: 601, height: 400 });
  assert.deepEqual(result.document.marks.map((mark) => mark.id), [1, 2]);
  assert.deepEqual(result.document.marks[0].rect, {
    x: -50,
    y: -40,
    width: 100,
    height: 80,
  });
  assert.deepEqual(result.document.marks[1].start, { x: 150, y: 70 });
});

test("a crossing mark survives even when both endpoints are outside", () => {
  const document = documentWithMarks();
  document.marks = [{
    kind: "line",
    id: 9,
    start: { x: 0, y: 200 },
    end: { x: 600, y: 200 },
    color: "white",
    width: 2,
  }];
  const result = cropAnnotationDocument(document, { x: 200, y: 100, width: 100, height: 200 });
  assert.equal(result.document.marks.length, 1);
  assert.deepEqual(result.document.marks[0].start, { x: -200, y: 100 });
  assert.deepEqual(result.document.marks[0].end, { x: 400, y: 100 });
});

test("an arrow survives when only its minimum-size head enters the crop", () => {
  const document = documentWithMarks();
  document.marks = [{
    kind: "arrow",
    id: 10,
    start: { x: 40, y: 120 },
    end: { x: 90, y: 120 },
    color: "white",
    width: 1,
  }];
  const result = cropAnnotationDocument(document, { x: 76, y: 113, width: 20, height: 2 });
  assert.equal(result.document.marks.length, 1);
});

test("cropping through only a text background edge retains its editable mark", () => {
  const document = documentWithMarks();
  const text = {kind: "text", id: 22, text: "edge", rect: {x: 220, y: 106, width: 80, height: 26},
    color: "white", background: "dark", fontSize: 18};
  document.marks = [text];
  const selection = { x: 0, y: 0, width: 218.5, height: 360 };
  const result = cropAnnotationDocument(document, selection);
  assert.equal(result.document.marks.length, 1);
  assert.deepEqual(result.document.marks[0], text);
  const transparent = cropAnnotationDocument({...document, marks: [{...text, background: "transparent"}]}, selection);
  assert.equal(transparent.document.marks.length, 0);
});
