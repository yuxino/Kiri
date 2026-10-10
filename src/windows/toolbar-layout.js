/** Overlay-local logical coordinates; the measured toolbar includes its border. */
export function captureToolbarPosition(selection, bounds, size, sizeControlsOpen = false, modeSelector = null) {
  const margin = 8;
  const gap = 10;
  const minLeft = bounds.x + margin;
  const minTop = bounds.y + margin;
  const maxLeft = Math.max(minLeft, bounds.x + bounds.width - size.width - margin);
  const maxTop = Math.max(minTop, bounds.y + bounds.height - size.height - margin);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const centeredLeft = clamp(selection.x + (selection.width - size.width) / 2, minLeft, maxLeft);
  const centeredTop = clamp(selection.y + (selection.height - size.height) / 2, minTop, maxTop);
  const overlaps = (position, rect, clearance = 0) => !!rect &&
    position.left < rect.x + rect.width + clearance && position.left + size.width + clearance > rect.x &&
    position.top < rect.y + rect.height + clearance && position.top + size.height + clearance > rect.y;
  const onScreen = position => position.left >= minLeft && position.left <= maxLeft &&
    position.top >= minTop && position.top <= maxTop;
  const clearMode = position => !overlaps(position, modeSelector, gap);
  const variants = position => modeSelector ? [position,
    { ...position, left: modeSelector.x - size.width - gap },
    { ...position, left: modeSelector.x + modeSelector.width + gap },
  ] : [position];

  // Place the whole measured stack outside the selection. Clamping only its
  // top used to leave later settings rows across the selection's upper edge.
  const outside = [
    { left: centeredLeft, top: selection.y + selection.height + gap },
    { left: centeredLeft, top: selection.y - size.height - gap - (sizeControlsOpen ? 38 : 0) },
    { left: selection.x + selection.width + (sizeControlsOpen ? 80 : gap), top: centeredTop },
    { left: selection.x - size.width - gap, top: centeredTop },
  ];
  for (const position of outside.flatMap(variants)) {
    if (onScreen(position) && !overlaps(position, selection, gap) && clearMode(position)) return position;
  }

  // A full-height/full-display selection has no outside room. Keep the stack
  // fully inside it when possible instead of straddling a resize border.
  const inside = [
    { left: centeredLeft, top: selection.y + selection.height - size.height - gap },
    { left: centeredLeft, top: selection.y + gap },
    { left: centeredLeft, top: centeredTop },
  ];
  const contained = position => position.left >= selection.x + gap &&
    position.left + size.width <= selection.x + selection.width - gap &&
    position.top >= selection.y + gap && position.top + size.height <= selection.y + selection.height - gap;
  for (const position of inside.flatMap(variants)) {
    if (onScreen(position) && contained(position) && clearMode(position)) return position;
  }
  for (const position of inside.flatMap(variants)) {
    if (onScreen(position) && position.top >= selection.y + gap &&
        position.top + size.height <= selection.y + selection.height - gap && clearMode(position)) return position;
  }

  // If the selection is narrower than the HUD, screen corners remain usable.
  // Prefer one clear of the mode selector; HUDs retain their own input area.
  const fallback = [
    { left: centeredLeft, top: maxTop },
    { left: minLeft, top: minTop },
    { left: maxLeft, top: minTop },
    { left: minLeft, top: maxTop },
    { left: maxLeft, top: maxTop },
  ];
  return fallback.find(clearMode) ?? fallback[0];
}

/** Scrollable panels keep their actions visible in the space left by both HUDs. */
export function capturePanelLayout(selection, bounds, size, modeSelector = null, sizeControlsOpen = false) {
  const margin = 8;
  const gap = 10;
  const screen = { x: bounds.x + margin, y: bounds.y + margin,
    width: Math.max(0, bounds.width - margin * 2), height: Math.max(0, bounds.height - margin * 2) };
  const width = Math.min(size.width, screen.width);
  const intersect = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
      height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
  };
  let free = [screen];
  if (modeSelector) {
    const obstacle = { x: modeSelector.x - gap, y: modeSelector.y - gap,
      width: modeSelector.width + gap * 2, height: modeSelector.height + gap * 2 };
    free = [
      { ...screen, width: Math.max(0, obstacle.x - screen.x) },
      { ...screen, x: obstacle.x + obstacle.width,
        width: Math.max(0, screen.x + screen.width - obstacle.x - obstacle.width) },
      { ...screen, height: Math.max(0, obstacle.y - screen.y) },
      { ...screen, y: obstacle.y + obstacle.height,
        height: Math.max(0, screen.y + screen.height - obstacle.y - obstacle.height) },
    ].map(rect => intersect(rect, screen));
  }
  const below = selection.y + selection.height + gap;
  const above = selection.y - gap - (sizeControlsOpen ? 38 : 0);
  const outside = [
    { ...screen, y: below, height: Math.max(0, screen.y + screen.height - below) },
    { ...screen, height: Math.max(0, above - screen.y) },
    { ...screen, x: selection.x + selection.width + gap,
      width: Math.max(0, screen.x + screen.width - selection.x - selection.width - gap) },
    { ...screen, width: Math.max(0, selection.x - gap - screen.x) },
  ].flatMap(rect => free.map(space => intersect(rect, space)))
    .filter(rect => rect.width >= width && rect.height >= Math.min(size.height || 160, 160));
  // Prefer scrolling next to the selection to covering its border with a tall
  // panel. Full-display selections instead use the largest mode-free space.
  const available = outside.length ? outside : free.filter(rect => rect.width >= width);
  const maxHeight = Math.max(0, ...available.map(rect => rect.height));
  const height = Math.min(size.height, maxHeight);
  return { ...captureToolbarPosition(selection, bounds, { width, height }, sizeControlsOpen, modeSelector),
    width, maxHeight };
}
