/** Map logical overlay coordinates to the frozen image's actual pixels. */
export function captureColorPixel(point, bounds, pixels) {
  if (![point.x, point.y, bounds.width, bounds.height, pixels.width, pixels.height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0 || pixels.width < 1 || pixels.height < 1 ||
      point.x < bounds.x || point.y < bounds.y ||
      point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) return null;
  return {
    x: Math.min(pixels.width - 1, Math.floor((point.x - bounds.x) * pixels.width / bounds.width)),
    y: Math.min(pixels.height - 1, Math.floor((point.y - bounds.y) * pixels.height / bounds.height)),
  };
}

export function captureColorHex(rgba) {
  return "#" + Array.from(rgba).slice(0, 3).map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Flip away from the pointer at display edges, keeping the panel onscreen. */
export function captureColorPosition(point, bounds, size) {
  const gap = 20;
  const margin = 8;
  const right = bounds.x + bounds.width - margin;
  const bottom = bounds.y + bounds.height - margin;
  const x = point.x + gap + size.width <= right ? point.x + gap : point.x - gap - size.width;
  const y = point.y + gap + size.height <= bottom ? point.y + gap : point.y - gap - size.height;
  return {
    left: Math.max(bounds.x + margin, Math.min(x, right - size.width)),
    top: Math.max(bounds.y + margin, Math.min(y, bottom - size.height)),
  };
}
