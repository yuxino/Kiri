export function capturePixelScale(scale) {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function capturePixelSize(rect, scale) {
  const pixelScale = capturePixelScale(scale);
  return { width: Math.round(rect.width * pixelScale), height: Math.round(rect.height * pixelScale) };
}

/** Exact physical pixels, preserving the selection center until a display edge intervenes. */
export function resizeCapturePixels(rect, bounds, scale, axis, pixels) {
  if (!Number.isSafeInteger(pixels) || pixels <= 0) return rect;
  const pixelScale = capturePixelScale(scale);
  const limit = Math.floor(bounds[axis] * pixelScale);
  const minimum = Math.min(limit, Math.ceil(3 * pixelScale));
  const side = Math.min(limit, Math.max(minimum, pixels)) / pixelScale;
  const coordinate = axis === "width" ? "x" : "y";
  const position = Math.min(
    Math.max(bounds[coordinate], rect[coordinate] + (rect[axis] - side) / 2),
    bounds[coordinate] + bounds[axis] - side,
  );
  return { ...rect, [coordinate]: position, [axis]: side };
}

/** Edge labels sit clear of resize handles and flip inside at display boundaries. */
export function captureSizePositions(rect, bounds, sizes) {
  const margin = 6;
  const gap = 14;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const fit = (left, top, size) => ({
    left: clamp(left, bounds.x + margin, bounds.x + bounds.width - size.width - margin),
    top: clamp(top, bounds.y + margin, bounds.y + bounds.height - size.height - margin),
  });
  const right = rect.x + rect.width;
  const above = rect.y - gap - sizes.width.height;
  const widthTop = above >= bounds.y + margin ? above : rect.y + gap;
  const heightLeft = right + gap + sizes.height.width <= bounds.x + bounds.width - margin
    ? right + gap : right - gap - sizes.height.width;
  const width = fit(rect.x + rect.width / 2 - sizes.width.width / 2, widthTop, sizes.width);
  const height = fit(heightLeft, rect.y + rect.height / 2 - sizes.height.height / 2, sizes.height);
  // A tiny selection can bring the two labels together. Keep both readable.
  if (width.left < height.left + sizes.height.width + margin &&
      width.left + sizes.width.width + margin > height.left &&
      width.top < height.top + sizes.height.height + margin &&
      width.top + sizes.width.height + margin > height.top) {
    const above = width.top - sizes.height.height - margin;
    height.top = above >= bounds.y + margin ? above
      : clamp(width.top + sizes.width.height + margin, bounds.y + margin,
        bounds.y + bounds.height - sizes.height.height - margin);
  }
  return { width, height };
}
