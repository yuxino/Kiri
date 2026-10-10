import type {Point, Rect} from "./geom";
import type {AnnotationMark, WatermarkMark} from "./model";
export const MAX_WATERMARK_TILES: number;
export const MAX_TOTAL_WATERMARK_TILES: number;
export const MAX_WATERMARK_TEXT_UNITS: number;
export function watermarkCenter(mark: WatermarkMark): Point;
export function watermarkCorners(mark: WatermarkMark): Point[];
export function watermarkBounds(mark: WatermarkMark): Rect;
export function watermarkContainsPoint(mark: WatermarkMark, point: Point, paddingX?: number, paddingY?: number): boolean;
export function watermarkIntersectsRect(mark: WatermarkMark, rect: Rect): boolean;
export interface WatermarkTilePlan {
  center: Point; stepX: number; stepY: number;
  startColumn: number; endColumn: number; startRow: number; endRow: number; count: number;
}
export function watermarkTilePlan(mark: WatermarkMark, region: Rect): WatermarkTilePlan;
export function validateWatermarkDensity(marks: AnnotationMark[], region: Rect): number;
