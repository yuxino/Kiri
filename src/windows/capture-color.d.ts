import type { Point, Rect } from "../annotation/geom";
export function captureColorPixel(point: Point, bounds: Rect, pixels: { width: number; height: number }): Point | null;
export function captureColorHex(rgba: Uint8ClampedArray | number[]): string;
export function captureColorPosition(point: Point, bounds: Rect, size: { width: number; height: number }): { left: number; top: number };
