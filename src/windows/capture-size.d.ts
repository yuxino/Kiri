import type { Rect } from "../annotation/geom";
export function capturePixelScale(scale: number): number;
export function capturePixelSize(rect: Rect, scale: number): { width: number; height: number };
export function resizeCapturePixels(rect: Rect, bounds: Rect, scale: number, axis: "width" | "height", pixels: number): Rect;
export function captureSizePositions(rect: Rect, bounds: Rect, sizes: {
  width: { width: number; height: number };
  height: { width: number; height: number };
}): { width: { left: number; top: number }; height: { left: number; top: number } };
