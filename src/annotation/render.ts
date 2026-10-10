// Shared canvas rendering for the live annotation view and exported bitmap.
// Document coordinates are top-left (y down); export scales into pixel space.

import type {
  AnnotationMark,
  ColorPreset,
  MosaicIntensity,
  MosaicShape,
  TextBackgroundStyle,
} from "./model";
import { COLOR_HEX, MOSAIC_VIEW_BLOCK_SIZE, arrowHeadPoints, calloutConnectorEnd, selectionBounds, labelGeometry } from "./model";
import type { Point, Rect } from "./geom";
import { inset, intersection, maxX, maxY, minX, minY, standardized } from "./geom";
import { layoutTextLines, textLineRuns } from "./text-layout.js";
import {blurCanvas} from "./canvas-blur";
import { mosaicDocumentBlurRadius, orderedMosaics } from "./mosaic-render";
import { drawWatermark } from "./watermark-render";

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export function textFont(size: number): string {
  return `600 ${size}px ${FONT_STACK}`;
}

function colorValue(color: ColorPreset): string {
  return COLOR_HEX[color];
}

function backgroundValue(style: TextBackgroundStyle): string | null {
  switch (style) {
    case "transparent":
      return null;
    case "dark":
      return "rgba(0, 0, 0, 0.72)";
  }
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  /** Full-resolution source image. */
  sourceImage: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  /** Display-local offset of the region top-left (points). */
  sourceOffset: Point;
  /** Display size of the region (points). */
  regionSize: Rect;
  /** Image pixels per annotation-document point. */
  scaleX: number;
  scaleY: number;
  /** CSS viewport points per annotation-document point. */
  viewScaleX: number;
  viewScaleY: number;
  /** True when rendering the export bitmap in pixel space. */
  exporting: boolean;
}

export interface RenderGeometryScale {
  /** Directional document-to-output multipliers. */
  x: number;
  y: number;
  /**
   * Isotropic geometry uses the smaller axis so strokes, circular brush clips,
   * and blur kernels stay inside the mapped document-space bounds.
   */
  stroke: number;
}

export function renderGeometryScale(
  exporting: boolean,
  scaleX: number,
  scaleY: number,
): RenderGeometryScale {
  if (!exporting) return { x: 1, y: 1, stroke: 1 };
  return { x: scaleX, y: scaleY, stroke: Math.min(scaleX, scaleY) };
}

export function scaleRectForRender(rect: Rect, scale: RenderGeometryScale): Rect {
  return {
    x: rect.x * scale.x,
    y: rect.y * scale.y,
    width: rect.width * scale.x,
    height: rect.height * scale.y,
  };
}

export function mosaicBlurRadius(
  brushDiameter: number,
  intensity: MosaicIntensity,
  scale: RenderGeometryScale,
): number {
  const documentRadius = mosaicDocumentBlurRadius(brushDiameter, intensity);
  return Math.max(1, Math.round(documentRadius * scale.stroke));
}

function geometryScale(r: RenderContext): RenderGeometryScale {
  return renderGeometryScale(r.exporting, r.scaleX, r.scaleY);
}

function exportPoint(p: Point, r: RenderContext): Point {
  const scale = geometryScale(r);
  // Canvas 2D and the view are both y-down, so scaling without a vertical flip
  // keeps sub-region annotations aligned with the background image.
  return {
    x: p.x * scale.x,
    y: p.y * scale.y,
  };
}

function exportStrokeSize(size: number, r: RenderContext): number {
  return size * geometryScale(r).stroke;
}

function strokePolyline(ctx: CanvasRenderingContext2D, points: Point[]) {
  if (points.length === 0) return;
  if(points.length===1){ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(points[0].x,points[0].y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();return;}
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

/** Draws one mark into the given context (already in the right space). */
export function drawMark(mark: AnnotationMark, r: RenderContext, ctx: CanvasRenderingContext2D, editing = false) {
  switch (mark.kind) {
    case "watermark": {
      drawWatermark(mark, r, ctx, editing);
      break;
    }
    case "callout": {
      // Lay out the whole object in document space, preserving preview/export parity.
      const scale = geometryScale(r);
      ctx.save();
      ctx.scale(scale.x, scale.y);
      const color = colorValue(mark.color);
      const radius = mark.size / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, mark.size / 20);
      ctx.lineCap = "round";
      // A live drag shows where the optional label will appear; empty saved
      // notes still export only their number.
      if (mark.text.trim() || editing || (mark.id < 0 && !r.exporting)) {
        const end = calloutConnectorEnd(mark);
        const distance = Math.hypot(end.x - mark.center.x, end.y - mark.center.y);
        if (distance > radius) {
          ctx.beginPath();
          ctx.moveTo(mark.center.x + (end.x - mark.center.x) * radius / distance,
            mark.center.y + (end.y - mark.center.y) * radius / distance);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
        const rect = mark.labelRect;
        const pad = Math.max(4, mark.fontSize * .5);
        if (!editing) {
          roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, Math.min(8, mark.fontSize * .35));
          ctx.stroke();
        }
        if (mark.text.trim() && !editing) {
          ctx.font = textFont(mark.fontSize);
          ctx.textBaseline = "top";
          ctx.fillStyle = color;
          wrapText(ctx, mark.text, rect.x + pad, rect.y + pad, Math.max(1, rect.width - pad * 2), mark.fontSize);
        }
      }
      ctx.beginPath();
      ctx.arc(mark.center.x, mark.center.y, Math.max(1, radius - ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fillStyle = mark.style === "filled" ? color : "rgba(255,255,255,0.96)";
      ctx.fill();
      ctx.stroke();
      const digits = String(mark.number);
      ctx.font = textFont(mark.size * (digits.length === 1 ? .5 : digits.length === 2 ? .43 : .33));
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = mark.style === "outline" ? color :
        ["yellow", "mint", "orange", "white"].includes(mark.color) ? "#141414" : "#FFFFFF";
      ctx.fillText(digits, mark.center.x, mark.center.y + mark.size * .025);
      ctx.restore();
      break;
    }
    case "pen": {
      const points = mark.points.map((p) => exportPoint(p, r));
      ctx.strokeStyle = colorValue(mark.color);
      ctx.lineWidth = exportStrokeSize(mark.width, r);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      strokePolyline(ctx, points);
      break;
    }
    case "rectangle": {
      const rect = standardized(mark.rect);
      const scale = geometryScale(r);
      const outputRect = scaleRectForRender(rect, scale);
      const p = { x: minX(outputRect), y: minY(outputRect) };
      const w = outputRect.width;
      const h = outputRect.height;
      const radius = 2 * scale.stroke;
      ctx.strokeStyle = colorValue(mark.color);
      ctx.lineWidth = mark.width * scale.stroke;
      if (w < 1 && h < 1) {
        // Keep a click-only rectangle visible as a small dot.
        const dot = Math.max(mark.width * scale.stroke * 0.7, 2 * scale.stroke);
        ctx.fillStyle = colorValue(mark.color);
        ctx.beginPath();
        ctx.arc(p.x, p.y, dot / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      roundRectPath(ctx, p.x, p.y, w, h, radius);
      ctx.stroke();
      break;
    }
    case "line": {
      const start = exportPoint(mark.start, r);
      const end = exportPoint(mark.end, r);
      ctx.strokeStyle = colorValue(mark.color);
      ctx.lineWidth = exportStrokeSize(mark.width, r);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const start = exportPoint(mark.start, r);
      const end = exportPoint(mark.end, r);
      const width = exportStrokeSize(mark.width, r);
      ctx.strokeStyle = colorValue(mark.color);
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      const [left, right] = arrowHeadPoints(start, end, width);
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(end.x, end.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
      break;
    }
    case "text": {
      const rect = standardized(mark.rect);
      const scale = geometryScale(r);
      if (mark.labelDirection) {
        const {body, dot, radius, tail} = labelGeometry(rect, mark.fontSize, mark.labelDirection);
        ctx.save();
        ctx.scale(scale.x, scale.y);
        ctx.fillStyle = "#303136";
        roundRectPath(ctx, body.x, body.y, body.width, body.height, mark.fontSize * .45);
        ctx.fill();
        const edge = mark.labelDirection === "left" ? body.x : maxX(body);
        const sign = mark.labelDirection === "left" ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(edge - sign, dot.y - tail);
        ctx.lineTo(edge + sign * tail, dot.y);
        ctx.lineTo(edge - sign, dot.y + tail);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = colorValue(mark.color);
        ctx.beginPath(); ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fafafa";
        ctx.font = textFont(mark.fontSize);
        ctx.textBaseline = "top";
        wrapText(ctx, mark.text, rect.x, rect.y, rect.width, mark.fontSize);
        ctx.restore();
        break;
      }
      const outputRect = scaleRectForRender(rect, scale);
      const p = { x: minX(outputRect), y: minY(outputRect) };
      const background = backgroundValue(mark.background);
      if (background) {
        const padX = 5 * scale.x;
        const padY = 3 * scale.y;
        ctx.fillStyle = background;
        roundRectPath(
          ctx,
          p.x - padX,
          p.y - padY,
          outputRect.width + padX * 2,
          outputRect.height + padY * 2,
          5 * scale.stroke,
        );
        ctx.fill();
      }

      // Lay text out once in document coordinates, then map glyphs through the
      // directional output transform. This preserves wrapping while scaling
      // font height by Y and glyph width by X.
      ctx.save();
      ctx.scale(scale.x, scale.y);
      ctx.fillStyle = colorValue(mark.color);
      ctx.font = textFont(mark.fontSize);
      ctx.textBaseline = "top";
      wrapText(ctx, mark.text, minX(rect), minY(rect), rect.width, mark.fontSize);
      ctx.restore();
      break;
    }
    case "mosaic": {
      drawMosaicMark(mark, r, ctx);
      break;
    }
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(Math.max(radius, 0), Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
) {
  const lineHeight = fontSize * 1.25;
  const lines = layoutTextLines(text, maxWidth, (value) => ctx.measureText(value).width);
  for (const [index, line] of lines.entries()) {
    for (const run of textLineRuns(line, (value) => ctx.measureText(value).width).runs) {
      ctx.fillText(run.text, x + run.x, y + index * lineHeight);
    }
  }
}

// ---------------------------------------------------------------------------
// Mosaic (spec §7)
// ---------------------------------------------------------------------------

function mosaicStrokeBounds(points: Point[], diameter: number, region: Rect): Rect | null {
  const radius = diameter / 2;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const bounds = {
    x: Math.min(...xs) - radius,
    y: Math.min(...ys) - radius,
    width: Math.max(...xs) - Math.min(...xs) + diameter,
    height: Math.max(...ys) - Math.min(...ys) + diameter,
  };
  const clipped = intersection(bounds, region);
  return clipped.width >= 1 && clipped.height >= 1 ? clipped : null;
}

export function clipToMosaicStroke(ctx: CanvasRenderingContext2D, points: Point[], diameter: number, shape: MosaicShape = "brush") {
  ctx.save();
  ctx.beginPath();
  if(shape!=="brush" && points.length===2){
    const x=Math.min(points[0].x,points[1].x),y=Math.min(points[0].y,points[1].y);
    const width=Math.abs(points[1].x-points[0].x),height=Math.abs(points[1].y-points[0].y);
    if(shape==="ellipse")ctx.ellipse(x+width/2,y+height/2,width/2,height/2,0,0,Math.PI*2);
    else ctx.rect(x,y,width,height);
    ctx.clip();return;
  }
  // A filled capsule joins each pair of samples even when fast motion skips pixels.
  // Disks and connecting quads share their winding, so overlaps cannot cancel out.
  const radius = diameter / 2;
  for (let index=0;index<points.length;index++) {
    const p=points[index];
    ctx.moveTo(p.x+radius,p.y);ctx.arc(p.x,p.y,radius,0,Math.PI*2);
    if(!index)continue;
    const previous=points[index-1],dx=p.x-previous.x,dy=p.y-previous.y,length=Math.hypot(dx,dy);
    if(!length)continue;
    const nx=-dy/length*radius,ny=dx/length*radius;
    ctx.moveTo(previous.x-nx,previous.y-ny);ctx.lineTo(p.x-nx,p.y-ny);
    ctx.lineTo(p.x+nx,p.y+ny);ctx.lineTo(previous.x+nx,previous.y+ny);ctx.closePath();
  }
  ctx.clip();
}

function drawMosaicMark(
  mark: AnnotationMark & { kind: "mosaic" },
  r: RenderContext,
  ctx: CanvasRenderingContext2D,
) {
  const region = { x: 0, y: 0, width: r.regionSize.width, height: r.regionSize.height };
  const viewRect = mosaicStrokeBounds(mark.points, mark.shape && mark.shape!=="brush"?0:mark.brushDiameter, region);
  if (!viewRect) return;

  // Source-pixel crop: mark coordinates are region-local; add the source
  // offset of the region within the full-resolution image.
  const crop = {
    x: Math.floor((r.sourceOffset.x + minX(viewRect)) * r.scaleX),
    y: Math.floor((r.sourceOffset.y + minY(viewRect)) * r.scaleY),
    width: Math.ceil(viewRect.width * r.scaleX),
    height: Math.ceil(viewRect.height * r.scaleY),
  };
  const sourceW = r.sourceWidth;
  const sourceH = r.sourceHeight;
  const sourceLeft = Math.max(0, r.sourceOffset.x * r.scaleX);
  const sourceTop = Math.max(0, r.sourceOffset.y * r.scaleY);
  const sourceRight = Math.min(sourceW, (r.sourceOffset.x + region.width) * r.scaleX);
  const sourceBottom = Math.min(sourceH, (r.sourceOffset.y + region.height) * r.scaleY);
  const cx = Math.max(0, Math.min(crop.x, sourceW));
  const cy = Math.max(0, Math.min(crop.y, sourceH));
  const cw = Math.max(1, Math.min(crop.width, sourceW - cx));
  const ch = Math.max(1, Math.min(crop.height, sourceH - cy));

  const scale = geometryScale(r);
  const clipDiameter = mark.brushDiameter * scale.stroke;
  const points = r.exporting ? mark.points.map((p) => exportPoint(p, r)) : mark.points;
  const drawW = r.exporting ? viewRect.width * r.scaleX : viewRect.width;
  const drawH = r.exporting ? viewRect.height * r.scaleY : viewRect.height;
  const drawX = r.exporting ? minX(viewRect) * r.scaleX : minX(viewRect);
  const drawY = r.exporting ? minY(viewRect) * r.scaleY : minY(viewRect);

  if (mark.style === "blur") {
    // Gaussian-blur mosaic: draw the source crop into an offscreen canvas,
    // blur it, and stamp it through the brush-stroke clip. The blur radius
    // scales with the brush diameter and the intensity preset.
    const blurPx = mosaicBlurRadius(mark.brushDiameter, mark.intensity, scale);
    const sourceRadius=blurPx*cw/drawW,pad=Math.ceil(sourceRadius*3);
    // Sample beyond the stroke so a small brush can soften details that fill it.
    const sx=Math.max(sourceLeft,cx-pad),sy=Math.max(sourceTop,cy-pad);
    const sw=Math.min(sourceRight,cx+cw+pad)-sx,sh=Math.min(sourceBottom,cy+ch+pad)-sy;
    const off = document.createElement("canvas");
    off.width = sw;
    off.height = sh;
    const offCtx = off.getContext("2d")!;
    offCtx.drawImage(r.sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
    blurCanvas(off,sourceRadius);
    clipToMosaicStroke(ctx, points, clipDiameter, mark.shape);
    ctx.drawImage(off, 0, 0, sw, sh, drawX+(sx-cx)*drawW/cw, drawY+(sy-cy)*drawH/ch, sw*drawW/cw, sh*drawH/ch);
    ctx.restore();
    return;
  }

  // Anchor cells to the document origin. A growing stroke only adds cells;
  // it never changes the sampling coordinates of cells already covered.
  const block = MOSAIC_VIEW_BLOCK_SIZE[mark.intensity];
  const gridX = Math.floor(viewRect.x / block) * block;
  const gridY = Math.floor(viewRect.y / block) * block;
  const smallW = Math.max(1, Math.ceil((maxX(viewRect) - gridX) / block));
  const smallH = Math.max(1, Math.ceil((maxY(viewRect) - gridY) / block));
  const small = document.createElement("canvas");
  small.width = smallW;
  small.height = smallH;
  const smallCtx = small.getContext("2d")!;
  smallCtx.imageSmoothingEnabled = true;
  const sourceX = (r.sourceOffset.x + gridX) * r.scaleX;
  const sourceY = (r.sourceOffset.y + gridY) * r.scaleY;
  const cellWidth = block * r.scaleX, cellHeight = block * r.scaleY;
  // Downsampling a source crop can sample neighboring pixels outside that
  // crop in WebKit/Chromium. Copy only this bounded clean patch first so a
  // capture and its persisted cropped source use the exact same sampler.
  const patchWidth = Math.min(sourceRight - sourceX, smallW * cellWidth);
  const patchHeight = Math.min(sourceBottom - sourceY, smallH * cellHeight);
  const patch = document.createElement("canvas");
  patch.width = Math.max(1, Math.ceil(patchWidth));
  patch.height = Math.max(1, Math.ceil(patchHeight));
  patch.getContext("2d")!.drawImage(r.sourceImage, sourceX, sourceY, patchWidth, patchHeight,
    0, 0, patchWidth, patchHeight);
  smallCtx.drawImage(patch, 0, 0, smallW * cellWidth, smallH * cellHeight,
    0, 0, smallW, smallH);
  // The final partial image cell samples its available pixels rather than
  // transparent pixels outside the clean source. This stays stable at edges.
  if (sourceX + smallW * cellWidth > sourceRight || sourceY + smallH * cellHeight > sourceBottom) {
    for (let row = 0; row < smallH; row++) for (let column = 0; column < smallW; column++) {
      const sx = sourceX + column * cellWidth, sy = sourceY + row * cellHeight;
      if (sx + cellWidth <= sourceRight && sy + cellHeight <= sourceBottom) continue;
      const sw = Math.min(cellWidth, sourceRight - sx), sh = Math.min(cellHeight, sourceBottom - sy);
      if (sw > 0 && sh > 0) {
        smallCtx.clearRect(column, row, 1, 1);
        smallCtx.drawImage(patch, column * cellWidth, row * cellHeight, sw, sh, column, row, 1, 1);
      }
    }
  }

  clipToMosaicStroke(ctx, points, clipDiameter, mark.shape);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, smallW, smallH, gridX * scale.x, gridY * scale.y,
    smallW * block * scale.x, smallH * block * scale.y);
  patch.width = 0; patch.height = 0;
  ctx.restore();
}

/** Full render: background image → mosaics → other marks → draft → cursor → selection. */
export function renderAll(
  r: RenderContext,
  marks: AnnotationMark[],
  options: {
    draft?: AnnotationMark | null;
    brushCursor?: Point | null;
    brushDiameter?: number;
    selectedIndex?: number | null;
    editingIndex?: number | null;
    editingId?: number;
    chromeOnly?: boolean;
  } = {},
) {
  const { ctx } = r;
  const region = { x: 0, y: 0, width: r.regionSize.width, height: r.regionSize.height };

  if(options.chromeOnly){
    ctx.clearRect(0,0,region.width,region.height);
  }else{
  if (r.exporting) {
    // PNG exports retain the source alpha unless an annotation covers it.
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  } else {
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, region.width, region.height);
  }

  if (r.exporting) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      r.sourceImage,
      r.sourceOffset.x * r.scaleX,
      r.sourceOffset.y * r.scaleY,
      region.width * r.scaleX,
      region.height * r.scaleY,
      0,
      0,
      region.width * r.scaleX,
      region.height * r.scaleY,
    );
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      r.sourceImage,
      r.sourceOffset.x * r.scaleX,
      r.sourceOffset.y * r.scaleY,
      region.width * r.scaleX,
      region.height * r.scaleY,
      0,
      0,
      region.width,
      region.height,
    );
  }

  const mosaics = marks.filter((m): m is Extract<AnnotationMark, {kind: "mosaic"}> => m.kind === "mosaic");
  if (options.draft?.kind === "mosaic") mosaics.push(options.draft);
  const others = marks.filter((m) => m.kind !== "mosaic" && m.kind !== "watermark");
  for (const mark of orderedMosaics(mosaics)) drawMark(mark, r, ctx);
  for (const mark of others) {
    if (options.editingIndex !== null && options.editingIndex !== undefined) {
      const editingMark = marks[options.editingIndex];
      if (editingMark && mark.id === editingMark.id) {
        if (mark.kind === "callout") drawMark(mark, r, ctx, true);
        continue;
      }
    }
    drawMark(mark, r, ctx);
  }
  if (options.draft && options.draft.kind !== "mosaic" && options.draft.kind !== "watermark") drawMark(options.draft, r, ctx);
  const watermarks = marks.filter(mark => mark.kind === "watermark");
  if (options.draft?.kind === "watermark") watermarks.push(options.draft);
  for (const mark of watermarks) {
    const editing = !r.exporting && (mark.id === options.editingId ||
      (options.editingIndex != null && marks[options.editingIndex]?.id === mark.id));
    drawMark(mark, r, ctx, editing);
  }
  }

  if (!r.exporting && options.brushCursor && options.brushDiameter) {
    drawBrushCursor(
      ctx,
      options.brushCursor,
      options.brushDiameter,
      r.viewScaleX,
      r.viewScaleY,
    );
  }
  if (!r.exporting && options.selectedIndex !== null && options.selectedIndex !== undefined) {
    const selected = marks[options.selectedIndex];
    if (selected) drawSelectionOutline(ctx, selected, r.viewScaleX, r.viewScaleY);
  }
}

function drawBrushCursor(
  ctx: CanvasRenderingContext2D,
  p: Point,
  diameter: number,
  viewScaleX: number,
  viewScaleY: number,
) {
  const center = { x: p.x * viewScaleX, y: p.y * viewScaleY };
  const radiusX = (diameter * viewScaleX) / 2;
  const radiusY = (diameter * viewScaleY) / 2;
  // Interaction chrome is drawn in CSS viewport coordinates so its outline
  // remains legible while the document itself is zoomed to fit the editor.
  ctx.save();
  ctx.scale(1 / viewScaleX, 1 / viewScaleY);
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawSelectionOutline(
  ctx: CanvasRenderingContext2D,
  mark: AnnotationMark,
  viewScaleX: number,
  viewScaleY: number,
) {
  const documentBounds = selectionBounds(mark);
  const bounds = {
    x: documentBounds.x * viewScaleX,
    y: documentBounds.y * viewScaleY,
    width: documentBounds.width * viewScaleX,
    height: documentBounds.height * viewScaleY,
  };
  const toViewPoint = (point: Point): Point => ({
    x: point.x * viewScaleX,
    y: point.y * viewScaleY,
  });
  ctx.save();
  ctx.scale(1 / viewScaleX, 1 / viewScaleY);
  if (mark.kind === "callout") {
    drawSelectionHandle(ctx, toViewPoint({x: mark.center.x, y: mark.center.y - mark.size / 2}));
    if (mark.text.trim()) drawSelectionHandle(ctx, toViewPoint({x: mark.labelRect.x + mark.labelRect.width,
      y: mark.labelRect.y}));
    ctx.restore();
    return;
  }
  if (mark.kind === "line" || mark.kind === "arrow") {
    drawSelectionHandle(ctx, toViewPoint(mark.start));
    drawSelectionHandle(ctx, toViewPoint(mark.end));
    ctx.restore();
    return;
  }
  const outline = inset(standardized(bounds), 5, 5);
  roundRectPath(ctx, outline.x, outline.y, outline.width, outline.height, 6);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = "#050505";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  {
    const handles = [
      { x: minX(bounds), y: minY(bounds) },
      { x: (minX(bounds) + maxX(bounds)) / 2, y: minY(bounds) },
      { x: maxX(bounds), y: minY(bounds) },
      { x: maxX(bounds), y: (minY(bounds) + maxY(bounds)) / 2 },
      { x: maxX(bounds), y: maxY(bounds) },
      { x: (minX(bounds) + maxX(bounds)) / 2, y: maxY(bounds) },
      { x: minX(bounds), y: maxY(bounds) },
      { x: minX(bounds), y: (minY(bounds) + maxY(bounds)) / 2 },
    ];
    for (const handle of handles) drawSelectionHandle(ctx, handle);
  }
  ctx.restore();
}

function drawSelectionHandle(ctx: CanvasRenderingContext2D, p: Point) {
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#050505";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
  ctx.fill();
}
