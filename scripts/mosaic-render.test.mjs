import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { mosaicPixelCases } from "./helpers/mosaic-pixel-cases.mjs";

const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compiled = new Map();
function compile(relative) {
  if (compiled.has(relative)) return compiled.get(relative);
  let source = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }}).outputText;
  source = source.replace(/from "(\.\/[^"]+)"/g, (match, specifier) => {
    const extension = /\.[a-z]+$/.test(specifier) ? "" : ".ts";
    const dependency = new URL(specifier + extension, new URL(relative, import.meta.url));
    const relativeDependency = dependency.href;
    return `from ${JSON.stringify(compile(relativeDependency))}`;
  });
  const url = moduleUrl(source);
  compiled.set(relative, url);
  return url;
}

let canvas;
try { canvas = await import(process.env.KIRI_TEST_CANVAS_MODULE ?? "@napi-rs/canvas"); } catch {}
test("mosaic order uses actual effect size within each style and a stable order across styles", async () => {
  const {orderedMosaics} = await import(compile("../src/annotation/mosaic-render.ts"));
  const pixel = {kind: "mosaic", id: 1, style: "pixel", intensity: "strong", brushDiameter: 12};
  const weakPixel = {...pixel, id: 2, intensity: "soft"};
  const blur = {...pixel, id: 3, style: "blur"};
  const largeBlur = {...blur, id: 4, intensity: "soft", brushDiameter: 120};
  assert.deepEqual(orderedMosaics([largeBlur, pixel, blur, weakPixel]).map(mark => mark.id), [2, 1, 3, 4]);
  assert.deepEqual(orderedMosaics([weakPixel, blur, pixel, largeBlur]).map(mark => mark.id), [2, 1, 3, 4]);
});
test("mosaic growth keeps its pixel grid stable and weak committed/draft strokes cannot weaken strong coverage", {
  skip: !canvas && "Set KIRI_TEST_CANVAS_MODULE to a native Canvas adapter, or run mosaicPixelCases in browser QA.",
}, async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {createElement: () => canvas.createCanvas(1, 1)};
  try {
    const {renderAll} = await import(compile("../src/annotation/render.ts"));
    assert.deepEqual(mosaicPixelCases(canvas.createCanvas, renderAll), {
      changedCoveredPixels: 0, weakenedPixels: 0, weakenedDraftPixels: 0,
      weakenedBlurPixels: 0, mixedStyleOrderDiff: 0, previewExportDiff: 0, edgeAlpha: 255,
      sourceReopenDiff: 0, blurSourceReopenDiff: 0,
    });
  } finally { globalThis.document = previousDocument; }
});
