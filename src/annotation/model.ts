// Annotation data model + history — port of AnnotationCanvasView.swift /
// AnnotationHistory.swift. All coordinates are canvas points relative to the
// image rect (top-left origin).

import type { Point, Rect } from "./geom";
import {watermarkBounds, watermarkContainsPoint} from "./watermark-geometry.js";
import {
  distanceToSegment,
  handlePoint,
  maxX,
  maxY,
  minX,
  minY,
  pointBounds,
  polylineDistance,
  standardized,
} from "./geom";

export type Tool = "select" | "pen" | "rectangle" | "line" | "arrow" | "text" | "label" | "callout" | "mosaic" | "watermark";

export type ColorPreset =
  | "violet"
  | "cherry"
  | "orange"
  | "yellow"
  | "mint"
  | "blue"
  | "white"
  | "black";

export const COLOR_PRESETS: ColorPreset[] = [
  "violet",
  "cherry",
  "orange",
  "yellow",
  "mint",
  "blue",
  "white",
  "black",
];

export const COLOR_HEX: Record<ColorPreset, string> = {
  violet: "#7D69F5",
  cherry: "#FA476E",
  orange: "#FF7D2E",
  yellow: "#FFD129",
  mint: "#29C78F",
  blue: "#2994FF",
  white: "#FFFFFF",
  black: "#141414",
};

export const COLOR_LABELS: Record<ColorPreset, string> = {
  violet: "Violet",
  cherry: "Cherry",
  orange: "Orange",
  yellow: "Yellow",
  mint: "Mint",
  blue: "Blue",
  white: "White",
  black: "Black",
};

export type TextBackgroundStyle = "transparent" | "dark";
export type LabelDirection = "left" | "right";
export type CalloutStyle = "filled" | "outline";
export interface CalloutMark {
  kind: "callout";
  id: number;
  center: Point;
  number: number;
  text: string;
  labelRect: Rect;
  color: ColorPreset;
  size: number;
  fontSize: number;
  style: CalloutStyle;
}
export type MosaicIntensity = "soft" | "standard" | "strong";
export type MosaicStyle = "pixel" | "blur";
export type MosaicShape = "brush" | "rectangle" | "ellipse";
export type WatermarkMode = "single" | "tiled";
export interface WatermarkMark {
  kind: "watermark";
  id: number;
  text: string;
  /** Unrotated text content in immutable document coordinates. */
  rect: Rect;
  color: ColorPreset;
  fontSize: number;
  opacity: number;
  rotation: number;
  mode: WatermarkMode;
  spacing: number;
}

export const MOSAIC_VIEW_BLOCK_SIZE: Record<MosaicIntensity, number> = {
  soft: 7,
  standard: 12,
  strong: 20,
};

export type AnnotationMark =
  | CalloutMark
  | WatermarkMark
  | { kind: "pen"; id: number; points: Point[]; color: ColorPreset; width: number }
  | { kind: "rectangle"; id: number; rect: Rect; color: ColorPreset; width: number }
  | { kind: "line"; id: number; start: Point; end: Point; color: ColorPreset; width: number }
  | { kind: "arrow"; id: number; start: Point; end: Point; color: ColorPreset; width: number }
  | {
      kind: "text";
      id: number;
      text: string;
      rect: Rect;
      color: ColorPreset;
      background: TextBackgroundStyle;
      fontSize: number;
      /** Omitted for ordinary text. The rect always describes the text content. */
      labelDirection?: LabelDirection;
    }
  | {
      kind: "mosaic";
      id: number;
      points: Point[];
      brushDiameter: number;
      intensity: MosaicIntensity;
      style: MosaicStyle;
      /** Omitted in older documents: a freehand brush stroke. */
      shape?: MosaicShape;
    };

/**
 * Persisted editable-annotation sidecar. Marks stay in the logical coordinate
 * space in which the capture was created; editor viewport changes never
 * rewrite these dimensions or coordinates.
 */
export interface AnnotationDocumentV1 {
  schemaVersion: 1;
  canvas: { width: number; height: number };
  sourcePixels: { width: number; height: number };
  marks: AnnotationMark[];
}

export interface AppearanceSettings {
  colorPreset: ColorPreset;
  textBackgroundStyle: TextBackgroundStyle;
  labelDirection: LabelDirection;
  mosaicIntensity: MosaicIntensity;
  mosaicStyle: MosaicStyle;
  mosaicShape: MosaicShape;
  penWidth: number;
  shapeWidth: number;
  textFontSize: number;
  mosaicBrushDiameter: number;
  calloutSize: number;
  calloutStyle: CalloutStyle;
  watermarkColor: ColorPreset;
  watermarkFontSize: number;
  watermarkOpacity: number;
  watermarkRotation: number;
  watermarkMode: WatermarkMode;
  watermarkSpacing: number;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorPreset: "cherry",
  textBackgroundStyle: "transparent",
  labelDirection: "left",
  mosaicIntensity: "standard",
  mosaicStyle: "pixel",
  mosaicShape: "brush",
  penWidth: 3,
  shapeWidth: 3,
  textFontSize: 18,
  mosaicBrushDiameter: 20,
  calloutSize: 36,
  calloutStyle: "filled",
  watermarkColor: "black",
  watermarkFontSize: 28,
  watermarkOpacity: 20,
  watermarkRotation: -30,
  watermarkMode: "tiled",
  watermarkSpacing: 80,
};

/** Rejects whitespace-only edits without normalizing meaningful user text. */
export function annotationTextForCommit(text: string): string | null {
  return text.trim() ? text : null;
}

/** One geometry shared by the canvas, inline editor, hit testing and dot button. */
export function labelGeometry(rect: Rect, fontSize: number, direction: LabelDirection) {
  const content = standardized(rect);
  const padX = fontSize * .65, padY = fontSize * .4;
  const tail = fontSize * .5, gap = fontSize * .4, radius = fontSize * .22;
  const body = {x: content.x - padX, y: content.y - padY,
    width: content.width + padX * 2, height: content.height + padY * 2};
  const edge = direction === "left" ? body.x : maxX(body);
  const sign = direction === "left" ? -1 : 1;
  const dot = {x: edge + sign * (tail + gap + radius), y: body.y + body.height / 2};
  const bounds = {x: direction === "left" ? dot.x - radius : body.x, y: body.y,
    width: body.width + tail + gap + radius * 2, height: body.height};
  return {body, dot, radius, tail, bounds, padX, padY};
}

/** Reserve either pointing side so flipping never moves the text or clips the dot. */
export function labelMovementBounds(mark: Extract<AnnotationMark, {kind: "text"}>): Rect {
  if (!mark.labelDirection) return standardized(mark.rect);
  const left = labelGeometry(mark.rect, mark.fontSize, "left").bounds;
  const right = labelGeometry(mark.rect, mark.fontSize, "right").bounds;
  return {x: left.x, y: left.y, width: maxX(right) - left.x, height: left.height};
}

interface HistoryStep {
  before: AnnotationMark[];
  after: AnnotationMark[];
  undoResult: AnnotationMark | null;
  redoResult: AnnotationMark | null;
}

export class AnnotationHistory {
  private visible: AnnotationMark[] = [];
  private undoSteps: HistoryStep[] = [];
  private redoSteps: HistoryStep[] = [];

  constructor(initialElements: AnnotationMark[] = []) {
    this.load(initialElements);
  }

  get elements(): AnnotationMark[] {
    return this.visible;
  }

  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** Loads a persisted baseline without making the whole document undoable. */
  load(elements: AnnotationMark[]): void {
    this.visible = elements.slice();
    this.undoSteps = [];
    this.redoSteps = [];
  }

  append(element: AnnotationMark): void {
    const before = this.visible.slice();
    this.visible = [...this.visible, element];
    this.record({ before, after: this.visible.slice(), undoResult: element, redoResult: element });
  }

  replace(index: number, element: AnnotationMark): AnnotationMark | null {
    if (index < 0 || index >= this.visible.length) return null;
    const before = this.visible.slice();
    const replaced = this.visible[index];
    const after = before.slice();
    after[index] = element;
    this.visible = after;
    this.record({ before, after: after.slice(), undoResult: element, redoResult: element });
    return replaced;
  }

  remove(index: number): AnnotationMark | null {
    if (index < 0 || index >= this.visible.length) return null;
    const before = this.visible.slice();
    const removed = this.visible[index];
    const after = before.filter((_, i) => i !== index);
    this.visible = after;
    this.record({ before, after: after.slice(), undoResult: removed, redoResult: removed });
    return removed;
  }

  /**
   * Replaces the visible array without recording history — used for live
   * previews (e.g. dragging the text-size slider). Callers must follow up
   * with a history-recording operation (append/replace/remove) or the
   * change is lost to undo.
   */
  overwrite(elements: AnnotationMark[]): void {
    this.visible = elements.slice();
  }

  /**
   * Records an already-visible preview as one undoable change. The caller
   * supplies the element that existed before overwrite() began.
   */
  commitOverwrite(index: number, original: AnnotationMark): AnnotationMark | null {
    if (index < 0 || index >= this.visible.length) return null;
    const current = this.visible[index];
    const before = this.visible.slice();
    before[index] = original;
    const after = this.visible.slice();
    this.record({ before, after, undoResult: current, redoResult: current });
    return current;
  }

  undo(): AnnotationMark | null {
    const step = this.undoSteps.pop();
    if (!step) return null;
    this.visible = step.before.slice();
    this.redoSteps.push(step);
    return step.undoResult;
  }

  redo(): AnnotationMark | null {
    const step = this.redoSteps.pop();
    if (!step) return null;
    this.visible = step.after.slice();
    this.undoSteps.push(step);
    return step.redoResult;
  }

  clear(): void {
    this.visible = [];
    this.undoSteps = [];
    this.redoSteps = [];
  }

  private record(step: HistoryStep): void {
    this.undoSteps.push(step);
    this.redoSteps = [];
  }
}

// ---------------------------------------------------------------------------
// Hit testing (spec §6.1)
// ---------------------------------------------------------------------------

export interface AnnotationHitTestScale {
  /** Document units represented by one CSS pixel on each axis. */
  x: number;
  y: number;
  radial: number;
}

const UNIT_HIT_TEST_SCALE: AnnotationHitTestScale = { x: 1, y: 1, radial: 1 };

function hitTestMark(
  mark: AnnotationMark,
  p: Point,
  scale: AnnotationHitTestScale,
): boolean {
  switch (mark.kind) {
    case "watermark":
      return watermarkContainsPoint(mark, p, 7 * scale.x, 6 * scale.y);
    case "pen":
      return (
        polylineDistance(p, mark.points) <=
        Math.max(7 * scale.radial, mark.width / 2 + 4 * scale.radial)
      );
    case "rectangle": {
      const r = standardized(mark.rect);
      return containsPadded(
        r,
        p,
        Math.max(6 * scale.x, mark.width),
        Math.max(6 * scale.y, mark.width),
      );
    }
    case "line":
    case "arrow":
      return (
        distanceToSegment(p, mark.start, mark.end) <=
        Math.max(7 * scale.radial, mark.width / 2 + 4 * scale.radial)
      );
    case "text": {
      const r = selectionBounds(mark);
      return containsPadded(r, p, 7 * scale.x, 6 * scale.y);
    }
    case "callout": {
      const radius = mark.size / 2 + 5 * scale.radial;
      if (Math.hypot(p.x - mark.center.x, p.y - mark.center.y) <= radius) return true;
      if (!mark.text.trim()) return false;
      const end = calloutConnectorEnd(mark);
      return containsPadded(mark.labelRect, p, 5 * scale.x, 5 * scale.y) ||
        distanceToSegment(p, mark.center, end) <= 6 * scale.radial;
    }
    case "mosaic":
      if (mark.shape && mark.shape !== "brush") {
        const b = pointBounds(mark.points);
        if (mark.shape === "rectangle") return containsPadded(b, p, 4 * scale.x, 4 * scale.y);
        const rx = b.width / 2 + 4 * scale.x, ry = b.height / 2 + 4 * scale.y;
        return ((p.x-b.x-b.width/2)/rx)**2 + ((p.y-b.y-b.height/2)/ry)**2 <= 1;
      }
      return (
        polylineDistance(p, mark.points) <=
        mark.brushDiameter / 2 + 4 * scale.radial
      );
  }
}

function containsPadded(r: Rect, p: Point, dx: number, dy: number): boolean {
  return p.x >= minX(r) - dx && p.x <= maxX(r) + dx && p.y >= minY(r) - dy && p.y <= maxY(r) + dy;
}

/** Reverse-order hit test: topmost mark wins. */
export function markIndexAt(
  marks: AnnotationMark[],
  p: Point,
  scale: AnnotationHitTestScale = UNIT_HIT_TEST_SCALE,
): number | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (hitTestMark(marks[i], p, scale)) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mark transforms (spec §6.3) — used as drag previews
// ---------------------------------------------------------------------------

export function translateMark(mark: AnnotationMark, by: Point, bounds: Rect): AnnotationMark {
  switch (mark.kind) {
    case "watermark": {
      const b = watermarkBounds(mark);
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return {...mark,rect:{...mark.rect,x:mark.rect.x+tx,y:mark.rect.y+ty}};
    }
    case "callout": {
      const b = selectionBounds(mark);
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return {...mark, center: {x: mark.center.x + tx, y: mark.center.y + ty},
        labelRect: {...mark.labelRect, x: mark.labelRect.x + tx, y: mark.labelRect.y + ty}};
    }
    case "pen": {
      const b = pointBoundsPadded(mark.points, Math.max(1, mark.width / 2));
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return { ...mark, points: mark.points.map((p) => ({ x: p.x + tx, y: p.y + ty })) };
    }
    case "rectangle": {
      const b = standardized(mark.rect);
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return { ...mark, rect: { ...mark.rect, x: mark.rect.x + tx, y: mark.rect.y + ty } };
    }
    case "line":
    case "arrow": {
      const b = pointBoundsPadded([mark.start, mark.end], Math.max(1, mark.width / 2));
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return {
        ...mark,
        start: { x: mark.start.x + tx, y: mark.start.y + ty },
        end: { x: mark.end.x + tx, y: mark.end.y + ty },
      };
    }
    case "text": {
      const b = labelMovementBounds(mark);
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return { ...mark, rect: { ...mark.rect, x: mark.rect.x + tx, y: mark.rect.y + ty } };
    }
    case "mosaic": {
      const b = selectionBounds(mark);
      const tx = clampTranslation(by.x, minX(b), maxX(b), minX(bounds), maxX(bounds));
      const ty = clampTranslation(by.y, minY(b), maxY(b), minY(bounds), maxY(bounds));
      return { ...mark, points: mark.points.map((p) => ({ x: p.x + tx, y: p.y + ty })) };
    }
  }
}

function pointBoundsPadded(points: Point[], pad: number): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return {
    x,
    y,
    width: Math.max(...xs) - x + pad,
    height: Math.max(...ys) - y + pad,
  };
}

function clampTranslation(
  delta: number,
  markMin: number,
  markMax: number,
  boundMin: number,
  boundMax: number,
): number {
  return Math.min(Math.max(delta, boundMin - markMin), boundMax - markMax);
}

/** Resizes the editable object, including freehand coverage, from its original bounds. */
export function resizeAnnotationMark(mark: AnnotationMark, handle: string, point: Point, bounds: Rect): AnnotationMark {
  if (mark.kind === "line" || mark.kind === "arrow") return mark;
  const before = selectionBounds(mark);
  const next = resizeRect(before, handle, point, bounds);
  if (mark.kind === "rectangle") return {...mark, rect: next};
  if (mark.kind === "callout") {
    const sx = next.width / before.width, sy = next.height / before.height;
    const factor = Math.min(sx, sy);
    return {...mark,
      center: {x: next.x + (mark.center.x - before.x) * sx, y: next.y + (mark.center.y - before.y) * sy},
      size: Math.min(4096, Math.max(8, mark.size * factor)),
      fontSize: Math.min(4096, Math.max(6, mark.fontSize * factor)),
      labelRect: {x: next.x + (mark.labelRect.x - before.x) * sx,
        y: next.y + (mark.labelRect.y - before.y) * sy,
        width: mark.labelRect.width * sx, height: mark.labelRect.height * sy}};
  }
  if (mark.kind === "text" || mark.kind === "watermark") {
    // Text scales uniformly so a corner drag does not distort glyphs or rewrap words.
    const horizontal = handle === "left" || handle === "right";
    const vertical = handle === "top" || handle === "bottom";
    let factor = horizontal ? next.width / before.width : vertical ? next.height / before.height :
      Math.max(next.width / before.width, next.height / before.height);
    factor = Math.max(.1, Math.min(factor, 4096 / mark.fontSize));
    const left = handle.includes("Left") || handle === "left";
    const top = handle.startsWith("top");
    const right = handle.includes("Right") || handle === "right";
    const bottom = handle.startsWith("bottom");
    const anchorX = left ? maxX(before) : right ? before.x : before.x+before.width/2;
    const anchorY = top ? maxY(before) : bottom ? before.y : before.y+before.height/2;
    const roomX = left ? anchorX-bounds.x : right ? maxX(bounds)-anchorX : 2*Math.min(anchorX-bounds.x,maxX(bounds)-anchorX);
    const roomY = top ? anchorY-bounds.y : bottom ? maxY(bounds)-anchorY : 2*Math.min(anchorY-bounds.y,maxY(bounds)-anchorY);
    factor = Math.max(.01,Math.min(factor,roomX/before.width,roomY/before.height));
    const width=before.width*factor,height=before.height*factor;
    const x=left?anchorX-width:right?anchorX:anchorX-width/2, y=top?anchorY-height:bottom?anchorY:anchorY-height/2;
    const center = {x:x+width/2,y:y+height/2};
    return {...mark,fontSize:mark.fontSize*factor,rect:{
      x:mark.kind === "watermark" ? center.x-mark.rect.width*factor/2 : x+(mark.rect.x-before.x)*factor,
      y:mark.kind === "watermark" ? center.y-mark.rect.height*factor/2 : y+(mark.rect.y-before.y)*factor,
      width:mark.rect.width*factor,height:mark.rect.height*factor}};
  }
  if (mark.kind === "mosaic" && mark.shape && mark.shape !== "brush") {
    return {...mark,points:[{x:next.x,y:next.y},{x:maxX(next),y:maxY(next)}]};
  }
  const pointsBounds = pointBounds(mark.points);
  const oldSize = mark.kind === "pen" ? mark.width : mark.brushDiameter;
  const factor = Math.min(next.width/Math.max(1,before.width),next.height/Math.max(1,before.height));
  // A horizontal or vertical stroke still needs to grow along its thickness axis.
  const size = Math.max(.1,Math.min(4096,next.width,next.height,
    pointsBounds.width<.001||pointsBounds.height<.001 ? Math.min(next.width,next.height) : oldSize*factor));
  const points = mark.points.map(p=>({
    x:next.x+size/2+(pointsBounds.width>.001?(p.x-pointsBounds.x)/pointsBounds.width*(next.width-size):0),
    y:next.y+size/2+(pointsBounds.height>.001?(p.y-pointsBounds.y)/pointsBounds.height*(next.height-size):0),
  }));
  return mark.kind === "pen" ? {...mark,points,width:size} : {...mark,points,brushDiameter:size};
}

export function changeMosaicShape(mark: Extract<AnnotationMark,{kind:"mosaic"}>, shape: MosaicShape): Extract<AnnotationMark,{kind:"mosaic"}>;
export function changeMosaicShape(mark: AnnotationMark, shape: MosaicShape): AnnotationMark;
export function changeMosaicShape(mark: AnnotationMark, shape: MosaicShape): AnnotationMark {
  if (mark.kind !== "mosaic" || (mark.shape ?? "brush") === shape) return mark;
  const b=selectionBounds(mark);
  if (shape !== "brush") return {...mark,shape,points:[{x:b.x,y:b.y},{x:maxX(b),y:maxY(b)}]};
  const diameter=Math.min(b.width,b.height);
  return {...mark,shape,brushDiameter:Math.max(.1,diameter),points:b.width>=b.height?
    [{x:b.x+diameter/2,y:b.y+b.height/2},{x:maxX(b)-diameter/2,y:b.y+b.height/2}]:
    [{x:b.x+b.width/2,y:b.y+diameter/2},{x:b.x+b.width/2,y:maxY(b)-diameter/2}]};
}

/** Apply only the changed property; selecting an object never replaces its styling. */
export function applyAnnotationAppearance(mark: AnnotationMark, patch: Partial<AppearanceSettings>): AnnotationMark {
  if(mark.kind === "watermark") {
    const fontSize=patch.watermarkFontSize??mark.fontSize, scale=fontSize/mark.fontSize;
    const center={x:mark.rect.x+mark.rect.width/2,y:mark.rect.y+mark.rect.height/2};
    return {...mark,color:patch.watermarkColor??mark.color,fontSize,
      opacity:patch.watermarkOpacity===undefined?mark.opacity:patch.watermarkOpacity/100,
      rotation:patch.watermarkRotation??mark.rotation,mode:patch.watermarkMode??mark.mode,
      spacing:patch.watermarkSpacing??mark.spacing,
      rect:{x:center.x-mark.rect.width*scale/2,y:center.y-mark.rect.height*scale/2,
        width:mark.rect.width*scale,height:mark.rect.height*scale}};
  }
  if(mark.kind === "mosaic")return {...changeMosaicShape(mark,patch.mosaicShape??mark.shape??"brush"),
    ...(patch.mosaicBrushDiameter===undefined?{}:{brushDiameter:patch.mosaicBrushDiameter}),
    ...(patch.mosaicIntensity===undefined?{}:{intensity:patch.mosaicIntensity}),
    ...(patch.mosaicStyle===undefined?{}:{style:patch.mosaicStyle})};
  const color=patch.colorPreset??mark.color;
  if (mark.kind === "callout") return {...mark, color, size: patch.calloutSize ?? mark.size,
    style: patch.calloutStyle ?? mark.style, fontSize: patch.textFontSize ?? mark.fontSize};
  if(mark.kind === "text"){
    const fontSize=patch.textFontSize??mark.fontSize,scale=fontSize/mark.fontSize;
    return {...mark,color,fontSize,background:patch.textBackgroundStyle??mark.background,
      ...(mark.labelDirection ? {labelDirection:patch.labelDirection??mark.labelDirection} : {}),
      rect:{...mark.rect,width:mark.rect.width*scale,height:mark.rect.height*scale}};
  }
  return {...mark,color,width:(mark.kind==="pen"?patch.penWidth:patch.shapeWidth)??mark.width};
}

// Reuse the SelectionGeometry resize algorithm from geom.ts.
import { resized } from "./geom";

function resizeRect(r: Rect, handle: string, point: Point, bounds: Rect): Rect {
  return resized(r, handle as Parameters<typeof resized>[1], point, bounds, 8);
}

export function moveEndpointMark(
  mark: AnnotationMark,
  isStart: boolean,
  point: Point,
): AnnotationMark {
  if (mark.kind !== "line" && mark.kind !== "arrow") return mark;
  return isStart ? { ...mark, start: point } : { ...mark, end: point };
}

/** A handle follows the pointer delta, preserving the initial grab offset. */
export function dragAnnotationHandle(
  mark: AnnotationMark,
  handle: string,
  delta: Point,
  bounds: Rect,
): AnnotationMark {
  if (Math.hypot(delta.x, delta.y) < 1) return mark;
  if (mark.kind === "callout" && handle === "badge") {
    const radius = mark.size / 2;
    return {...mark, center: {x: Math.min(maxX(bounds) - radius, Math.max(bounds.x + radius, mark.center.x + delta.x)),
      y: Math.min(maxY(bounds) - radius, Math.max(bounds.y + radius, mark.center.y + delta.y))}};
  }
  if (mark.kind === "callout" && handle === "label") {
    return {...mark, labelRect: {...mark.labelRect,
      x: Math.min(maxX(bounds) - mark.labelRect.width, Math.max(bounds.x, mark.labelRect.x + delta.x)),
      y: Math.min(maxY(bounds) - mark.labelRect.height, Math.max(bounds.y, mark.labelRect.y + delta.y))}};
  }
  if (mark.kind === "line" || mark.kind === "arrow") {
    const original = handle === "start" ? mark.start : mark.end;
    return moveEndpointMark(mark, handle === "start", {
      x: original.x + delta.x,
      y: original.y + delta.y,
    });
  }
  const original = handlePoint(handle as Parameters<typeof handlePoint>[0], selectionBounds(mark));
  return resizeAnnotationMark(mark, handle, {
    x: original.x + delta.x,
    y: original.y + delta.y,
  }, bounds);
}

/** Selection bounds used for the outline (spec §6.4). */
export function selectionBounds(mark: AnnotationMark): Rect {
  switch (mark.kind) {
    case "watermark":
      return watermarkBounds(mark);
    case "callout": {
      const radius = mark.size / 2;
      const badge = {x: mark.center.x - radius, y: mark.center.y - radius, width: mark.size, height: mark.size};
      if (!mark.text.trim()) return badge;
      const x = Math.min(badge.x, mark.labelRect.x), y = Math.min(badge.y, mark.labelRect.y);
      return {x, y, width: Math.max(maxX(badge), maxX(mark.labelRect)) - x,
        height: Math.max(maxY(badge), maxY(mark.labelRect)) - y};
    }
    case "pen": {
      const b = pointBounds(mark.points);
      const pad = Math.max(1, mark.width / 2);
      return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
    }
    case "rectangle":
      return standardized(mark.rect);
    case "line":
    case "arrow": {
      const b = pointBounds([mark.start, mark.end]);
      const pad = Math.max(1, mark.width / 2);
      return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
    }
    case "text":
      return mark.labelDirection ? labelGeometry(mark.rect, mark.fontSize, mark.labelDirection).bounds : standardized(mark.rect);
    case "mosaic": {
      const b = pointBounds(mark.points);
      if (mark.shape && mark.shape !== "brush") return b;
      const pad = mark.brushDiameter / 2;
      return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
    }
  }
}

/** Closest point on the label boundary; the leader always follows both objects. */
export function calloutConnectorEnd(mark: CalloutMark): Point {
  const r = mark.labelRect;
  return {x: Math.max(r.x, Math.min(mark.center.x, maxX(r))),
    y: Math.max(r.y, Math.min(mark.center.y, maxY(r)))};
}

export function calloutHandleAt(mark: CalloutMark, point: Point, tolerance: number): "badge" | "label" | null {
  if (Math.hypot(point.x - mark.center.x, point.y - mark.center.y + mark.size / 2) <= tolerance) return "badge";
  if (mark.text.trim() && Math.hypot(point.x - mark.labelRect.x - mark.labelRect.width,
    point.y - mark.labelRect.y) <= tolerance) return "label";
  return null;
}

export function nextCalloutNumber(marks: AnnotationMark[]): number {
  return Math.min(999, marks.reduce((next, mark) => mark.kind === "callout" ? Math.max(next, mark.number + 1) : next, 1));
}

/** Arrow head geometry (spec §5.4). */
export function arrowHeadPoints(start: Point, end: Point, width: number): [Point, Point] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(12, width * 4);
  return [
    {
      x: end.x - headLength * Math.cos(angle - Math.PI / 6),
      y: end.y - headLength * Math.sin(angle - Math.PI / 6),
    },
    {
      x: end.x - headLength * Math.cos(angle + Math.PI / 6),
      y: end.y - headLength * Math.sin(angle + Math.PI / 6),
    },
  ];
}
