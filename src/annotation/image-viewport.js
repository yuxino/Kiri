// Image viewing uses source pixels; annotation geometry remains in its document.
export function imageViewport(image, viewport, mode = "auto", zoom = 1, dpr = 1, options = {}) {
  const padding = options.padding ?? 12;
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const nativeScale = 1 / Math.max(1, dpr);
  const maximumFitScale = options.allowUpscale ? Infinity : nativeScale;
  const longImage = image.height > image.width * 2;
  const fitWidth = Math.max(1, width - padding * 2) / Math.max(1, image.width);
  const fit = Math.min(fitWidth, Math.max(1, height - padding * 2) / Math.max(1, image.height));
  const readingWidth = longImage || (options.fitWidthWhenOverflowing && image.height * fitWidth > Math.max(1, height - padding * 2) + 1);
  const scale = mode === "manual" ? zoom * nativeScale : mode === "width" ? fitWidth
    : mode === "fit" ? Math.min(fit, maximumFitScale)
    : Math.min(readingWidth ? fitWidth : fit, maximumFitScale);
  const viewWidth = image.width * scale, viewHeight = image.height * scale;
  return { scale, zoom: scale / nativeScale, width: viewWidth, height: viewHeight,
    x: Math.max(padding, (width - viewWidth) / 2),
    y: options.alignLongImagesToTop && mode === "auto" && readingWidth ? padding : Math.max(padding, (height - viewHeight) / 2),
    surfaceWidth: Math.max(width, viewWidth + padding * 2),
    surfaceHeight: Math.max(height, viewHeight + padding * 2) };
}
export function imageZoomAnchor(layout, scroll, point) {
  return { x: (scroll.x + point.x - layout.x) / layout.scale,
    y: (scroll.y + point.y - layout.y) / layout.scale };
}
export function scrollToImageAnchor(layout, viewport, source, point) {
  return { x: Math.max(0, Math.min(layout.surfaceWidth - viewport.width, source.x * layout.scale + layout.x - point.x)),
    y: Math.max(0, Math.min(layout.surfaceHeight - viewport.height, source.y * layout.scale + layout.y - point.y)) };
}
export function visibleImageViewport(layout, viewport, scroll) {
  const margin = 96;
  const x = Math.max(0, scroll.x - layout.x - margin), y = Math.max(0, scroll.y - layout.y - margin);
  return { x, y, width: Math.max(1, Math.min(layout.width, scroll.x - layout.x + viewport.width + margin) - x),
    height: Math.max(1, Math.min(layout.height, scroll.y - layout.y + viewport.height + margin) - y) };
}
