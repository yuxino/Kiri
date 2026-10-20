export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export type ImageViewMode = "auto" | "fit" | "width" | "manual";
export interface ImageViewportLayout extends Point, Size { scale: number; zoom: number; surfaceWidth: number; surfaceHeight: number }
export function imageViewport(image: Size, viewport: Size, mode?: ImageViewMode, zoom?: number, dpr?: number): ImageViewportLayout;
export function imageZoomAnchor(layout: ImageViewportLayout, scroll: Point, point: Point): Point;
export function scrollToImageAnchor(layout: ImageViewportLayout, viewport: Size, source: Point, point: Point): Point;
export function visibleImageViewport(layout: ImageViewportLayout, viewport: Size, scroll: Point): Point & Size;
