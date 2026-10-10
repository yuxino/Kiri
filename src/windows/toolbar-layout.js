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
