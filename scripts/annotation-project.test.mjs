import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {watermarkPixelCases} from "./helpers/watermark-pixel-cases.mjs";
import {watermarkBounds,watermarkContainsPoint,watermarkTilePlan,validateWatermarkDensity} from "../src/annotation/watermark-geometry.js";

import {
  ANNOTATION_PROJECT_LIMITS,
  MAX_ANNOTATION_DOCUMENT_BYTES,
  annotationSourceCrop,
  documentUnitsPerViewPixel,
  parseAnnotationDocument,
  viewPointToDocument,
} from "../src/annotation/project.js";

const TRANSPILE_OPTIONS = {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
};

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const compiledModules = new Map();
async function compileAnnotationModule(url) {
  if (compiledModules.has(url.href)) return compiledModules.get(url.href);
  const pending = (async () => {
    const source = await readFile(url, "utf8");
    let javascript = ts.transpileModule(source, TRANSPILE_OPTIONS).outputText;
    const imports = [...javascript.matchAll(/from "(\.\/[^"]+)"/g)];
    for (const [statement, specifier] of imports) {
      const extension = /\.[a-z]+$/.test(specifier) ? "" : ".ts";
      const dependency = await compileAnnotationModule(new URL(specifier + extension, url));
      javascript = javascript.replace(statement, `from ${JSON.stringify(dependency)}`);
    }
    return moduleDataUrl(javascript);
  })();
  compiledModules.set(url.href, pending);
  return pending;
}
async function loadAnnotationModel() {
  return import(await compileAnnotationModule(new URL("../src/annotation/model.ts", import.meta.url)));
}
async function loadAnnotationRender() {
  return import(await compileAnnotationModule(new URL("../src/annotation/render.ts", import.meta.url)));
}
async function loadWatermarkRender() {
  return import(await compileAnnotationModule(new URL("../src/annotation/watermark-render.ts", import.meta.url)));
}

function documentWith(marks = []) {
  return {
    schemaVersion: 1,
    canvas: { width: 640, height: 360 },
    sourcePixels: { width: 1280, height: 720 },
    marks,
  };
}

const ALL_MARKS = [
  // Keep the original fixture order; existing text/render tests address it below.
  {
    kind: "pen",
    id: 1.25,
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    color: "violet",
    width: 3,
  },
  {
    kind: "rectangle",
    id: 2.25,
    rect: { x: 10, y: 11, width: 120, height: 80 },
    color: "cherry",
    width: 4,
  },
  {
    kind: "line",
    id: 3.25,
    start: { x: 20, y: 21 },
    end: { x: 220, y: 121 },
    color: "orange",
    width: 5,
  },
  {
    kind: "arrow",
    id: 4.25,
    start: { x: 30, y: 31 },
    end: { x: 230, y: 131 },
    color: "yellow",
    width: 6,
  },
  {
    kind: "text",
    id: 5.25,
    text: "editable text\n第二行",
    rect: { x: 40, y: 41, width: 180, height: 60 },
    color: "white",
    background: "transparent",
    fontSize: 18,
  },
  {
    kind: "mosaic",
    id: 6.25,
    points: [{ x: 50, y: 51 }],
    brushDiameter: 20,
    intensity: "standard",
    style: "pixel",
  },
];

test("annotation documents round-trip every mark kind without changing IDs or order", () => {
  const input = documentWith(structuredClone(ALL_MARKS));
  const parsed = parseAnnotationDocument(input);

  assert.deepEqual(parsed, input);
  assert.deepEqual(parsed.marks.map((mark) => mark.kind), ALL_MARKS.map((mark) => mark.kind));
  assert.deepEqual(parsed.marks.map((mark) => mark.id), ALL_MARKS.map((mark) => mark.id));

  input.marks[0].points[0].x = 999;
  assert.equal(parsed.marks[0].points[0].x, 1, "the validated document must be detached");
});

test("annotation document validation is strict about schema, dimensions, numbers, and enums", () => {
  assert.throws(
    () => parseAnnotationDocument({ ...documentWith(), schemaVersion: 2 }),
    /schemaVersion/,
  );
  assert.throws(
    () => parseAnnotationDocument({ ...documentWith(), unexpected: true }),
    /unexpected/,
  );
  assert.throws(
    () => parseAnnotationDocument({ ...documentWith(), canvas: { width: 0, height: 360 } }),
    /canvas.width/,
  );
  assert.throws(
    () =>
      parseAnnotationDocument({
        ...documentWith(),
        sourcePixels: { width: 1280.5, height: 720 },
      }),
    /sourcePixels.width/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[1], id: Number.NaN }])),
    /marks\[0\]\.id/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[0], color: "green" }])),
    /marks\[0\]\.color/,
  );
  assert.throws(
    () =>
      parseAnnotationDocument(
        documentWith([{ ...ALL_MARKS[2], start: { x: Number.POSITIVE_INFINITY, y: 1 } }]),
      ),
    /marks\[0\]\.start\.x/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[4], background: "light" }])),
    /marks\[0\]\.background/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[5], intensity: "extreme" }])),
    /marks\[0\]\.intensity/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[5], style: "smear" }])),
    /marks\[0\]\.style/,
  );
  assert.throws(
    () => parseAnnotationDocument(documentWith([{ ...ALL_MARKS[1], kind: "ellipse" }])),
    /marks\[0\]\.kind/,
  );
});

test("annotation document validation bounds aggregate data and rejects duplicate IDs", () => {
  assert.throws(
    () => parseAnnotationDocument(documentWith([ALL_MARKS[0], { ...ALL_MARKS[1], id: 1.25 }])),
    /duplicate/,
  );

  const tooManyMarks = Array.from(
    { length: ANNOTATION_PROJECT_LIMITS.maxMarks + 1 },
    (_, index) => ({ ...ALL_MARKS[1], id: index }),
  );
  assert.throws(() => parseAnnotationDocument(documentWith(tooManyMarks)), /marks/);

  const tooManyPoints = Array.from(
    { length: ANNOTATION_PROJECT_LIMITS.maxTotalPoints + 1 },
    () => ({ x: 1, y: 1 }),
  );
  assert.throws(
    () =>
      parseAnnotationDocument(
        documentWith([{ ...ALL_MARKS[5], id: 99, points: tooManyPoints }]),
      ),
    /points/,
  );

  assert.throws(
    () =>
      parseAnnotationDocument(
        documentWith([
          {
            ...ALL_MARKS[4],
            id: 100,
            text: "x".repeat(ANNOTATION_PROJECT_LIMITS.maxTotalText + 1),
          },
        ]),
      ),
    /text/,
  );
});

test("annotation document UTF-8 size matches the Rust four MiB boundary", () => {
  const verboseCoordinate = 0.12345678901234568;
  const points = Array.from({ length: ANNOTATION_PROJECT_LIMITS.maxTotalPoints }, (_, index) => ({
    x: verboseCoordinate,
    y: index < 55_000 ? verboseCoordinate : 0,
  }));
  const exactLimit = documentWith([
    {
      ...ALL_MARKS[5],
      id: 200,
      points,
    },
    {
      ...ALL_MARKS[4],
      id: 201,
      text: "",
    },
  ]);
  const remainingBytes =
    MAX_ANNOTATION_DOCUMENT_BYTES - Buffer.byteLength(JSON.stringify(exactLimit));
  assert.ok(remainingBytes > 0 && remainingBytes <= ANNOTATION_PROJECT_LIMITS.maxTotalText);
  exactLimit.marks[1].text = "x".repeat(remainingBytes);

  assert.equal(Buffer.byteLength(JSON.stringify(exactLimit)), MAX_ANNOTATION_DOCUMENT_BYTES);
  assert.equal(
    parseAnnotationDocument(exactLimit).marks[0].points.length,
    ANNOTATION_PROJECT_LIMITS.maxTotalPoints,
  );

  exactLimit.marks[1].text += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(exactLimit)), MAX_ANNOTATION_DOCUMENT_BYTES + 1);
  assert.throws(() => parseAnnotationDocument(exactLimit), /UTF-8 size limit/);

  for (const point of points) point.y = verboseCoordinate;
  exactLimit.marks[1].text = "";
  assert.ok(Buffer.byteLength(JSON.stringify(exactLimit)) > MAX_ANNOTATION_DOCUMENT_BYTES);
  assert.throws(() => parseAnnotationDocument(exactLimit), /UTF-8 size limit/);
});

test("live history previews commit the original element as the undo baseline", async () => {
  const { AnnotationHistory } = await loadAnnotationModel();
  const original = structuredClone(ALL_MARKS[4]);
  const resized = { ...original, fontSize: 30 };
  const history = new AnnotationHistory([original]);

  history.overwrite([resized]);
  assert.equal(history.canUndo, false, "a live preview is not independently undoable");
  history.commitOverwrite(0, original);

  assert.equal(history.canUndo, true);
  history.undo();
  assert.equal(history.elements[0].fontSize, original.fontSize);
  history.redo();
  assert.equal(history.elements[0].fontSize, resized.fontSize);
});

test("text commit emptiness checks preserve meaningful leading and trailing whitespace", async () => {
  const { annotationTextForCommit } = await loadAnnotationModel();
  const original = "  Kiri\nnext line  ";

  assert.equal(annotationTextForCommit(original), original);
  assert.equal(annotationTextForCommit(" \n\t "), null);
});

test("view coordinates project into a fixed document space without viewport drift", () => {
  const canvas = { width: 640, height: 360 };
  const firstViewport = { width: 960, height: 540 };
  const secondViewport = { width: 320, height: 180 };

  assert.deepEqual(viewPointToDocument({ x: 480, y: 270 }, firstViewport, canvas), {
    x: 320,
    y: 180,
  });
  assert.deepEqual(viewPointToDocument({ x: 160, y: 90 }, secondViewport, canvas), {
    x: 320,
    y: 180,
  });
  assert.throws(
    () => viewPointToDocument({ x: 1, y: 1 }, { width: 0, height: 10 }, canvas),
    /viewSize.width/,
  );
});

test("CSS-sized interaction targets expand in document space when the viewport shrinks", () => {
  const units = documentUnitsPerViewPixel(
    { width: 800, height: 450 },
    { width: 1600, height: 900 },
  );

  assert.deepEqual(units, { x: 2, y: 2, radial: 2 });
  assert.equal(5 * units.radial * (800 / 1600), 5, "a 5px handle stays 5 CSS px");
  assert.throws(
    () => documentUnitsPerViewPixel({ width: 0, height: 450 }, { width: 1600, height: 900 }),
    /viewSize.width/,
  );
});

test("fractional display selections use the same rounded integer source crop as persistence", () => {
  assert.deepEqual(
    annotationSourceCrop(
      { width: 8, height: 6 },
      { width: 4, height: 3 },
      { x: 0.25, y: 0.5, width: 2, height: 1.5 },
      { width: 4, height: 3 },
    ),
    { x: 1, y: 1, width: 4, height: 3 },
  );
  assert.deepEqual(
    annotationSourceCrop(
      { width: 8, height: 6 },
      { width: 4, height: 3 },
      { x: 3.75, y: 2.75, width: 0.25, height: 0.25 },
      { width: 1, height: 1 },
    ),
    { x: 7, y: 5, width: 1, height: 1 },
  );
  assert.throws(
    () =>
      annotationSourceCrop(
        { width: 8, height: 6 },
        { width: 4, height: 3 },
        { x: 0, y: 0, width: 2, height: 1.5 },
        { width: 3, height: 3 },
      ),
    /outputSize/,
  );
});

test("non-export rendering keeps document and CSS geometry unchanged", async () => {
  const { mosaicBlurRadius, renderGeometryScale, scaleRectForRender } =
    await loadAnnotationRender();
  const scale = renderGeometryScale(false, 4, 2);

  assert.deepEqual(scale, { x: 1, y: 1, stroke: 1 });
  assert.deepEqual(
    scaleRectForRender({ x: 10, y: 5, width: 30, height: 12 }, scale),
    { x: 10, y: 5, width: 30, height: 12 },
  );
  assert.equal(mosaicBlurRadius(20, "standard", scale), 5);
});

test("nonuniform export scales directional geometry on its own axis", async () => {
  const { renderGeometryScale, scaleRectForRender } = await loadAnnotationRender();
  const scale = renderGeometryScale(true, 4, 2);

  assert.deepEqual(scale, { x: 4, y: 2, stroke: 2 });
  assert.deepEqual(
    scaleRectForRender({ x: 10, y: 5, width: 30, height: 12 }, scale),
    { x: 40, y: 10, width: 120, height: 24 },
  );
});

test("blur mosaic export maps its document radius through the stroke scale", async () => {
  const { mosaicBlurRadius, renderGeometryScale } = await loadAnnotationRender();
  const scale = renderGeometryScale(true, 4, 2);

  assert.equal(mosaicBlurRadius(20, "soft", scale), 8);
  assert.equal(mosaicBlurRadius(20, "standard", scale), 10);
  assert.equal(mosaicBlurRadius(20, "strong", scale), 14);
});

test('privacy blur softens actual pixels and keeps transparent edges free of hidden colors',async()=>{
 const source=await readFile(new URL('../src/annotation/canvas-blur.ts',import.meta.url),'utf8');
 const {blurRgba}=await import(moduleDataUrl(ts.transpileModule(source,TRANSPILE_OPTIONS).outputText));
 const width=31,height=31,data=new Uint8ClampedArray(width*height*4);
 for(let i=0;i<data.length;i+=4){data[i+2]=255;data[i+3]=255;}
 for(let y=14;y<=16;y++)for(let x=14;x<=16;x++){const i=(y*width+x)*4;data[i+1]=255;data[i+2]=0;}
 const weak=data.slice(),strong=data.slice();blurRgba(weak,width,height,2);blurRgba(strong,width,height,5);
 const center=(15*width+15)*4,neighbor=(15*width+10)*4;
 assert.ok(weak[center+1]>strong[center+1]);assert.ok(weak[center+1]<200);
 assert.ok(strong[neighbor+1]>0);assert.equal(strong[center+3],255);
 const transparent=new Uint8ClampedArray(9*4);
 for(let i=0;i<transparent.length;i+=4)transparent[i]=255;
 transparent.set([0,0,255,255],4*4);blurRgba(transparent,9,1,2);
 assert.equal(transparent[4*4],0);assert.equal(transparent[4*4+2],255);
 const uniform=new Uint8ClampedArray([20,80,140,255]);blurRgba(uniform,1,1,20);
 assert.deepEqual([...uniform],[20,80,140,255]);
});

test('sparse mosaic samples cover the connecting stroke without overlap holes',async()=>{
 const {clipToMosaicStroke}=await loadAnnotationRender();
 function coverage(points){
  const shapes=[];let polygon=[];
  const ctx={save(){},beginPath(){},clip(){},moveTo(x,y){polygon=[{x,y}]},lineTo(x,y){polygon.push({x,y})},closePath(){shapes.push({polygon});polygon=[]},arc(x,y,r){shapes.push({x,y,r})}};
  clipToMosaicStroke(ctx,points,20);
  return (x,y)=>shapes.reduce((winding,shape)=>{
   if('r' in shape)return winding+(Math.hypot(x-shape.x,y-shape.y)<shape.r?1:0);
   const p=shape.polygon;let inside=false,area=0;
   for(let i=0,j=p.length-1;i<p.length;j=i++){
    const a=p[j],b=p[i];area+=a.x*b.y-b.x*a.y;
    if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
   }
   return winding+(inside?Math.sign(area):0);
  },0)!==0;
 }
 const horizontal=coverage([{x:10,y:10},{x:110,y:10}]);
 assert.ok(horizontal(60,10),'fast movement must fill the gap between samples');
 assert.ok(horizontal(15,10),'the segment must not cancel the overlapping round cap');
 assert.equal(horizontal(60,21),false);
 const diagonal=coverage([{x:10,y:10},{x:100,y:100},{x:30,y:100}]);
 assert.ok(diagonal(55,55));assert.ok(diagonal(65,100));assert.equal(diagonal(60,30),false);
 assert.ok(coverage([{x:50,y:50},{x:50,y:50}])(50,50));
});

test("mosaic regions preserve their shape through validation and legacy brushes remain unchanged",()=>{
  const base=ALL_MARKS.find(mark=>mark.kind==="mosaic");
  for(const shape of ["rectangle","ellipse"]){
    const mark={...base,shape,points:[{x:20,y:30},{x:120,y:80}]};
    assert.deepEqual(parseAnnotationDocument(documentWith([mark])).marks,[mark]);
    assert.throws(()=>parseAnnotationDocument(documentWith([{...mark,points:[{x:20,y:30}]}])),/two corners/);
  }
  assert.throws(()=>parseAnnotationDocument(documentWith([{...base,shape:"unknown"}])),/unknown/);
});

test("selected annotation appearance changes affect only the requested properties",async()=>{
  const {applyAnnotationAppearance}=await loadAnnotationModel();
  for(const mark of ALL_MARKS){
    const changed=applyAnnotationAppearance(mark,{colorPreset:"black",mosaicStyle:"blur"});
    assert.equal(changed.id,mark.id);
    if(mark.kind==="mosaic"){
      assert.equal(changed.style,"blur");assert.equal(changed.brushDiameter,mark.brushDiameter);
      assert.deepEqual(changed.points,mark.points);
    }else{assert.equal(changed.color,"black");assert.deepEqual(changed.rect,mark.rect);}
  }
  const text=ALL_MARKS.find(mark=>mark.kind==="text");
  const large=applyAnnotationAppearance(text,{textFontSize:36});
  assert.equal(large.rect.width,text.rect.width*2);
  assert.equal(large.rect.height,text.rect.height*2);
  assert.equal(large.text,text.text);
});

test("mosaic handles reshape an area and undo restores the original brush",async()=>{
  const {resizeAnnotationMark,selectionBounds,changeMosaicShape,AnnotationHistory,markIndexAt}=await loadAnnotationModel();
  const brush={...ALL_MARKS.find(mark=>mark.kind==="mosaic"),points:[{x:50,y:50},{x:150,y:50}],brushDiameter:20};
  const bounds={x:0,y:0,width:640,height:360};
  const taller=resizeAnnotationMark(brush,"bottom",{x:100,y:100},bounds);
  assert.equal(selectionBounds(taller).height,60);
  assert.equal(selectionBounds(taller).y,40);
  assert.equal(selectionBounds(taller).width,120);
  const ellipse=changeMosaicShape(brush,"ellipse");
  const changed=resizeAnnotationMark(ellipse,"bottomRight",{x:200,y:130},bounds);
  assert.deepEqual(selectionBounds(changed),{x:40,y:40,width:160,height:90});
  assert.equal(markIndexAt([changed],{x:120,y:85}),0);
  assert.equal(markIndexAt([changed],{x:40,y:40}),null,"an ellipse's bounding corner is not covered");
  const history=new AnnotationHistory([brush]);history.replace(0,ellipse);history.replace(0,changed);
  history.undo();assert.deepEqual(history.elements,[ellipse]);history.undo();assert.deepEqual(history.elements,[brush]);
});

test("pen and text resize handles preserve editable content and remain in the canvas",async()=>{
  const {resizeAnnotationMark,selectionBounds}=await loadAnnotationModel();
  const bounds={x:0,y:0,width:640,height:360};
  for(const mark of ALL_MARKS.filter(mark=>["pen","text"].includes(mark.kind))){
    for(const handle of ["topLeft","top","topRight","right","bottomRight","bottom","bottomLeft","left"]){
      const changed=resizeAnnotationMark(mark,handle,{x:600,y:320},bounds),b=selectionBounds(changed);
      assert.ok(b.x>=-1e-9&&b.y>=-1e-9&&b.x+b.width<=640+1e-9&&b.y+b.height<=360+1e-9,`${mark.kind} ${handle}`);
      assert.equal(changed.id,mark.id);assert.equal(changed.text,mark.text);
      assert.ok(Number.isFinite(b.width)&&b.width>0);
    }
  }
});

test("handle clicks and sub-point jitter keep geometry and the next meaningful undo intact", async () => {
  const { dragAnnotationHandle, translateMark, AnnotationHistory } = await loadAnnotationModel();
  const bounds = {x: 0, y: 0, width: 640, height: 360};
  for (const mark of ALL_MARKS) {
    const handle = mark.kind === "line" || mark.kind === "arrow" ? "start" : "top";
    assert.equal(dragAnnotationHandle(mark, handle, {x: 0, y: 0}, bounds), mark);
    assert.equal(dragAnnotationHandle(mark, handle, {x: .3, y: .4}, bounds), mark);
  }
  const original = ALL_MARKS[1];
  const moved = translateMark(original, {x: 20, y: 10}, bounds);
  const history = new AnnotationHistory([original]);
  history.replace(0, moved);
  const clicked = dragAnnotationHandle(moved, "top", {x: 0, y: 0}, bounds);
  if (clicked !== moved) history.replace(0, clicked);
  history.undo();
  assert.deepEqual(history.elements, [original]);
  const resized = dragAnnotationHandle(moved, "top", {x: 0, y: -5}, bounds);
  assert.equal(resized.rect.y, moved.rect.y - 5);
  assert.equal(resized.rect.height, moved.rect.height + 5);
});

test("larger text styling expands both selection and hit bounds with the visible text", async () => {
  const { applyAnnotationAppearance, markIndexAt, selectionBounds } = await loadAnnotationModel();
  const text = ALL_MARKS[4];
  const larger = applyAnnotationAppearance(text, {textFontSize: 48});
  const bounds = selectionBounds(larger);
  assert.equal(bounds.height, text.rect.height * 48 / text.fontSize);
  const lowerLine = {x: text.rect.x + 10, y: text.rect.y + text.rect.height + 20};
  assert.equal(markIndexAt([text], lowerLine), null);
  assert.equal(markIndexAt([larger], lowerLine), 0);
});

test("PNG exports clear their background instead of flattening source alpha onto dark gray", async () => {
  const { renderAll } = await loadAnnotationRender();
  const calls = [];
  const ctx = {canvas: {width: 4, height: 2},
    clearRect: (...args) => calls.push(["clear", ...args]),
    fillRect: (...args) => calls.push(["fill", ...args]),
    drawImage: (...args) => calls.push(["source", ...args]),
  };
  const sourceImage = {name: "transparent RGBA source"};
  renderAll({ctx, sourceImage, sourceWidth: 4, sourceHeight: 2,
    sourceOffset: {x: 0, y: 0}, regionSize: {x: 0, y: 0, width: 4, height: 2},
    scaleX: 1, scaleY: 1, viewScaleX: 1, viewScaleY: 1, exporting: true}, []);
  assert.deepEqual(calls.map(call => call[0]), ["clear", "source"]);
  assert.equal(calls[1][1], sourceImage);
});

test("text rendering places tab-separated columns at the same explicit stops", async () => {
  const { drawMark } = await loadAnnotationRender();
  const calls = [];
  const ctx = {save(){}, restore(){}, scale(){}, measureText: text => ({width: text.length * 10}),
    fillText: (...args) => calls.push(args)};
  const text = {...ALL_MARKS[4], text: "A\tB\tC\nAA\tBB\tCC", rect: {x: 10, y: 20, width: 200, height: 60}};
  drawMark(text, {exporting: true, scaleX: 1, scaleY: 1}, ctx);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ["A", 10], ["B", 90], ["C", 170], ["AA", 10], ["BB", 90], ["CC", 170],
  ]);
});


const numberedNote = {kind: "callout", id: 80, center: {x: 60, y: 80}, number: 123,
  text: "第一步\n説明を追加", labelRect: {x: 180, y: 60, width: 150, height: 70},
  color: "cherry", size: 36, fontSize: 18, style: "filled"};

test("numbered notes validate, crop, and preserve independent editable geometry", async () => {
  const {cropAnnotationDocument} = await import("../src/annotation/crop.js");
  const {markIndexAt, nextCalloutNumber, selectionBounds} = await loadAnnotationModel();
  const document = parseAnnotationDocument(documentWith([numberedNote]));
  assert.deepEqual(document.marks, [numberedNote]);
  assert.equal(nextCalloutNumber(document.marks), 124);
  assert.equal(markIndexAt(document.marks, {x: 60, y: 80}), 0);
  assert.equal(markIndexAt(document.marks, {x: 190, y: 80}), 0);
  assert.equal(markIndexAt(document.marks, {x: 120, y: 300}), null);
  assert.deepEqual(selectionBounds(numberedNote), {x: 42, y: 60, width: 288, height: 70});
  const crop = cropAnnotationDocument(document, {x: 40, y: 40, width: 320, height: 180});
  assert.deepEqual(crop.document.marks[0].center, {x: 20, y: 40});
  assert.deepEqual(crop.document.marks[0].labelRect, {...numberedNote.labelRect, x: 140, y: 20});
  for (const patch of [{number: 0}, {number: 1000}, {number: 1.2}, {style: "unknown"}, {size: 0}, {text: "x".repeat(65537)}]) {
    assert.throws(() => parseAnnotationDocument(documentWith([{...numberedNote, ...patch}])));
  }
});

test("numbered note export uses transparent labels at Retina scale and contrasts light badge digits", async () => {
  const {drawMark} = await loadAnnotationRender();
  const calls = [];
  const ctx = {save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},arcTo(){},arc(){},stroke(){},fill(){calls.push(["fill", this.fillStyle]);},
    scale: (...args) => calls.push(["scale", ...args]),
    measureText: text => ({width: text.length * 9}),
    fillText(text, x, y) {calls.push(["text", text, x, y, this.fillStyle]);}};
  drawMark({...numberedNote, color: "yellow"}, {exporting: true, scaleX: 2, scaleY: 2}, ctx);
  assert.deepEqual(calls[0], ["scale", 2, 2]);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["text", "123", 60, 80.9]);
  assert.equal(calls.at(-1)[4], "#141414");
  assert.ok(calls.some(call => call[0] === "text" && call[1] === "第一步"));
  assert.equal(calls.filter(call => call[0] === "fill").length, 1, "only the badge fills pixels behind text");
  calls.length = 0;
  drawMark(numberedNote, {exporting: false, scaleX: 1, scaleY: 1}, ctx, true);
  assert.equal(calls.filter(call => call[0] === "text").length, 1, "inline editing leaves badge digits but never duplicates the textarea text");
});

test("empty callout drags preview their label position without exporting an empty box", async () => {
  const {drawMark} = await loadAnnotationRender();
  let leaders = 0;
  const ctx = {save(){},restore(){},scale(){},beginPath(){},moveTo(){},lineTo(){leaders++;},
    closePath(){},arcTo(){},arc(){},stroke(){},fill(){},fillText(){}};
  drawMark({...numberedNote, id: -1, text: ""}, {exporting: false, viewScaleX: 1, viewScaleY: 1}, ctx);
  assert.ok(leaders > 0);
  leaders = 0;
  drawMark({...numberedNote, text: ""}, {exporting: true, scaleX: 1, scaleY: 1}, ctx);
  assert.equal(leaders, 0);
});

for (const direction of ["left","right"]) {
  test(`label ${direction} persists and crop retains a visible dot when the text is outside`,async()=>{
    const {labelGeometry,markIndexAt,translateMark}=await loadAnnotationModel();
    const {cropAnnotationDocument}=await import("../src/annotation/crop.js");
    const label={...ALL_MARKS[4],rect:{x:160,y:100,width:100,height:45},color:"cherry",labelDirection:direction};
    const doc=parseAnnotationDocument(documentWith([label]));
    assert.deepEqual(doc.marks,[label]);
    assert.throws(()=>parseAnnotationDocument(documentWith([{...label,labelDirection:"top"}])),/labelDirection/);
    const geometry=labelGeometry(label.rect,label.fontSize,direction);
    assert.equal(markIndexAt([label],geometry.dot),0);
    const moved=translateMark(label,{x:-1000,y:-1000},{x:0,y:0,width:640,height:360});
    for(const side of ["left","right"]){
      const b=labelGeometry(moved.rect,moved.fontSize,side).bounds;
      assert.ok(b.x>=-1e-8&&b.y>=-1e-8);
    }
    const crop=cropAnnotationDocument(doc,{x:geometry.dot.x-5,y:geometry.dot.y-5,width:10,height:10});
    assert.equal(crop.document.marks.length,1);
    assert.equal(crop.document.marks[0].labelDirection,direction);
  });
}

test("label export scales its complete geometry and keeps neutral body and readable text",async()=>{
  const {drawMark}=await loadAnnotationRender();
  const label={...ALL_MARKS[4],labelDirection:"left",color:"black"};
  const fills=[],scales=[];
  const ctx={save(){},restore(){},scale:(...args)=>scales.push(args),beginPath(){},moveTo(){},lineTo(){},quadraticCurveTo(){},arcTo(){},closePath(){},arc(){},
    fill(){fills.push(this.fillStyle);},fillText(){fills.push(this.fillStyle);},measureText:value=>({width:value.length*8})};
  drawMark(label,{exporting:true,scaleX:2,scaleY:3},ctx);
  assert.deepEqual(scales,[[2,3]]);
  assert.ok(fills.includes("#303136"));assert.ok(fills.includes("#fafafa"));assert.ok(fills.includes("#141414"));
});

const WATERMARK = {kind:"watermark",id:80,text:"Kiri © 中文",rect:{x:80,y:60,width:150,height:35},
  color:"black",fontSize:28,opacity:.2,rotation:-30,mode:"tiled",spacing:80};

test("watermarks round-trip without weakening strict schema or legacy documents",()=>{
  const input=documentWith([WATERMARK]);
  const parsed=parseAnnotationDocument(input);
  assert.deepEqual(parsed,input);
  assert.notEqual(parsed.marks[0].rect,input.marks[0].rect);
  assert.deepEqual(parseAnnotationDocument(JSON.parse(JSON.stringify(parsed))),parsed);
  assert.deepEqual(parseAnnotationDocument(documentWith(ALL_MARKS)).marks,ALL_MARKS);
  for(const patch of [{opacity:-.1},{opacity:1.1},{rotation:181},{rotation:NaN},{spacing:15},{spacing:4097},
    {mode:"repeat"},{fontSize:0},{extra:true},{text:"😀".repeat(257)},{rect:{...WATERMARK.rect,width:0}}]) {
    assert.throws(()=>parseAnnotationDocument(documentWith([{...WATERMARK,...patch}])));
  }
  assert.equal(parseAnnotationDocument(documentWith([{...WATERMARK,text:"😀".repeat(256)}])).marks[0].text.length,512);
});

test("watermark density includes boundary tiles, offscreen anchors and the whole document",()=>{
  const mark={...WATERMARK,rotation:0,rect:{x:0,y:0,width:1,height:1},spacing:16};
  assert.equal(watermarkTilePlan(mark,{x:0,y:0,width:1071,height:1071}).count,4096);
  const region={x:0,y:0,width:1088,height:1088};
  assert.throws(()=>watermarkTilePlan(mark,region),/Watermark is too dense/);
  assert.throws(()=>watermarkTilePlan({...mark,rect:{...mark.rect,x:-10013,y:-10013}},region),/Watermark is too dense/);
  const document={...documentWith(),canvas:{width:1024,height:1024},sourcePixels:{width:1024,height:1024}};
  assert.equal(validateWatermarkDensity([mark,{...mark,id:81}],{x:0,y:0,...document.canvas}),7442);
  assert.throws(()=>parseAnnotationDocument({...document,marks:[mark,{...mark,id:81},{...mark,id:82}]}),/Watermark is too dense/);
  assert.equal(validateWatermarkDensity([{...mark,mode:"single"}],region),1);
});

test("rotated master hit testing does not let repeated tiles capture other objects",async()=>{
  const {markIndexAt,selectionBounds}=await loadAnnotationModel();
  const mark={...WATERMARK,rect:{x:100,y:100,width:200,height:30},rotation:45};
  const center={x:200,y:115}, bounds=watermarkBounds(mark);
  assert.deepEqual(selectionBounds(mark),bounds);
  assert.equal(watermarkContainsPoint(mark,center),true);
  assert.equal(watermarkContainsPoint(mark,{x:bounds.x+1,y:bounds.y+1}),false);
  const plan=watermarkTilePlan(mark,{x:0,y:0,width:640,height:360});
  const copy={x:center.x+plan.stepX,y:center.y};
  assert.equal(markIndexAt([mark],copy),null);
  const underneath={kind:"rectangle",id:81,rect:{x:copy.x-10,y:copy.y-10,width:20,height:20},color:"blue",width:3};
  assert.equal(markIndexAt([underneath,mark],copy),0);
  assert.equal(markIndexAt([underneath,mark],center),1);
});

test("watermark movement, rotated resize and one-property styling preserve metadata",async()=>{
  const {translateMark,resizeAnnotationMark,selectionBounds,applyAnnotationAppearance,DEFAULT_APPEARANCE}=await loadAnnotationModel();
  const bounds={x:0,y:0,width:640,height:360};
  const moved=translateMark(WATERMARK,{x:30,y:20},bounds);
  assert.deepEqual(moved.rect,{...WATERMARK.rect,x:110,y:80});
  assert.equal(moved.rotation,-30);assert.equal(moved.spacing,80);
  const clamped=translateMark(WATERMARK,{x:-1000,y:-1000},bounds), box=selectionBounds(clamped);
  assert.ok(box.x>=-1e-9&&box.y>=-1e-9);
  const before=selectionBounds(WATERMARK);
  const resized=resizeAnnotationMark(WATERMARK,"bottomRight",{x:before.x+before.width*1.5,y:before.y+before.height*1.5},bounds);
  assert.ok(resized.fontSize>WATERMARK.fontSize);
  assert.ok(Math.abs(resized.rect.width/resized.rect.height-WATERMARK.rect.width/WATERMARK.rect.height)<1e-10);
  assert.equal(resized.opacity,WATERMARK.opacity);assert.equal(resized.rotation,WATERMARK.rotation);
  assert.equal(resized.mode,WATERMARK.mode);assert.equal(resized.spacing,WATERMARK.spacing);
  const changed=applyAnnotationAppearance(WATERMARK,{watermarkOpacity:55});
  assert.equal(changed.opacity,.55);assert.deepEqual(changed.rect,WATERMARK.rect);
  const enlarged=applyAnnotationAppearance(WATERMARK,{watermarkFontSize:56});
  assert.equal(enlarged.rect.x+enlarged.rect.width/2,WATERMARK.rect.x+WATERMARK.rect.width/2);
  assert.equal(enlarged.rect.width,WATERMARK.rect.width*2);
  assert.deepEqual(applyAnnotationAppearance(WATERMARK,{colorPreset:"white",textFontSize:64}),WATERMARK);
  assert.equal(DEFAULT_APPEARANCE.watermarkColor,"black");assert.equal(DEFAULT_APPEARANCE.watermarkOpacity,20);
  assert.equal(DEFAULT_APPEARANCE.mosaicShape,"brush");
});

test("watermark drawing isolates alpha/transform and hides only the inline-edit master",async()=>{
  const {drawWatermark}=await loadWatermarkRender();
  const state=[],paint=[],scales=[],transforms=[];
  const ctx={globalAlpha:.8,fillStyle:"sentinel",font:"sentinel",textAlign:"center",textBaseline:"alphabetic",
    save(){state.push([this.globalAlpha,this.fillStyle,this.font,this.textAlign,this.textBaseline]);},
    restore(){[this.globalAlpha,this.fillStyle,this.font,this.textAlign,this.textBaseline]=state.pop();},
    scale(...values){scales.push(values);},beginPath(){},rect(){},clip(){},
    translate(x,y){transforms.push([x,y]);},rotate(){},measureText:value=>({width:value.length*7}),
    fillText(value){paint.push({value,alpha:this.globalAlpha});}};
  const render={regionSize:{width:640,height:360},exporting:true,scaleX:2,scaleY:3};
  drawWatermark({...WATERMARK,mode:"single"},render,ctx);
  assert.equal(paint.length,1);assert.ok(Math.abs(paint[0].alpha-.16)<1e-10);assert.deepEqual(scales,[[2,3]]);
  assert.equal(ctx.globalAlpha,.8);assert.equal(ctx.fillStyle,"sentinel");assert.equal(state.length,0);
  paint.length=0;transforms.length=0;
  drawWatermark({...WATERMARK,mode:"single"},render,ctx,true);assert.equal(paint.length,0);
  drawWatermark(WATERMARK,render,ctx,true);
  const plan=watermarkTilePlan(WATERMARK,{x:0,y:0,...render.regionSize});
  assert.equal(transforms.length,plan.count-1);
  assert.ok(!transforms.some(([x,y])=>x===plan.center.x&&y===plan.center.y));
  assert.equal(state.length,0);
  const original=ctx.fillText;ctx.fillText=()=>{throw new Error("injected renderer failure");};
  assert.throws(()=>drawWatermark({...WATERMARK,mode:"single"},render,ctx),/injected/);
  assert.equal(state.length,0);assert.equal(ctx.globalAlpha,.8);ctx.fillText=original;
});

let nativeCanvas;
try {nativeCanvas=await import(process.env.KIRI_TEST_CANVAS_MODULE??"@napi-rs/canvas");} catch {}
test("real watermark pixels stay transparent, respect opacity, draw last and keep crop phase",{
  skip:!nativeCanvas&&"Set KIRI_TEST_CANVAS_MODULE to a native Canvas adapter for this pixel regression.",
},async()=>{
  const {renderAll}=await loadAnnotationRender();
  const {cropAnnotationDocument}=await import("../src/annotation/crop.js");
  const previous=globalThis.document;
  globalThis.document={createElement:()=>nativeCanvas.createCanvas(1,1)};
  try{
    const result=watermarkPixelCases(nativeCanvas.createCanvas,renderAll,cropAnnotationDocument);
    assert.equal(result.success,true,JSON.stringify(result));
    assert.deepEqual(result.checks,{transparentBackground:true,textHasVisiblePixels:true,
      opacityRespected:true,watermarkDrawnLast:true,cropPhasePreserved:true});
    assert.equal(result.cropComparedPixels,35916);
  }finally{globalThis.document=previous;}
});
