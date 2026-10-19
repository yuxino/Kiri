/** Overlay-local logical coordinates; the measured toolbar includes its border. */
export function captureToolbarPosition(selection, bounds, size, sizeControlsOpen = false, modeSelector = null, preferredPosition = null) {
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

  if (preferredPosition) {
    const desired = {left: clamp(preferredPosition.x, minLeft, maxLeft), top: clamp(preferredPosition.y, minTop, maxTop)};
    if (clearMode(desired)) return desired;
    const candidates = [
      {...desired, left: modeSelector.x - size.width - gap},
      {...desired, left: modeSelector.x + modeSelector.width + gap},
      {...desired, top: modeSelector.y - size.height - gap},
      {...desired, top: modeSelector.y + modeSelector.height + gap},
      {left: minLeft, top: minTop}, {left: maxLeft, top: minTop},
      {left: minLeft, top: maxTop}, {left: maxLeft, top: maxTop},
    ].filter(position => onScreen(position) && clearMode(position));
    candidates.sort((a, b) => Math.hypot(a.left - desired.left, a.top - desired.top) - Math.hypot(b.left - desired.left, b.top - desired.top));
    return candidates[0] ?? desired;
  }

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

/** Tool properties adapt around an already positioned main row. Growing or
 * switching properties must never choose a new anchor for that main row. */
export function captureToolOptionsLayout(toolbar, bounds, size, modeSelector = null, avoidBounds = [], preferredPosition = null) {
  const margin = 8, gap = 6;
  const screen = { x: bounds.x + margin, y: bounds.y + margin,
    width: Math.max(0, bounds.width - margin * 2), height: Math.max(0, bounds.height - margin * 2) };
  const width = Math.min(size.width, screen.width);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const exclude = (spaces, obstacle, clearance) => {
    const left = obstacle.x - clearance, right = obstacle.x + obstacle.width + clearance;
    const top = obstacle.y - clearance, bottom = obstacle.y + obstacle.height + clearance;
    return spaces.flatMap(rect => {
      const endX = rect.x + rect.width, endY = rect.y + rect.height;
      if (right <= rect.x || left >= endX || bottom <= rect.y || top >= endY) return [rect];
      return [
        { ...rect, width: Math.max(0, Math.min(left, endX) - rect.x) },
        { ...rect, x: Math.max(right, rect.x), width: Math.max(0, endX - Math.max(right, rect.x)) },
        { ...rect, height: Math.max(0, Math.min(top, endY) - rect.y) },
        { ...rect, y: Math.max(bottom, rect.y), height: Math.max(0, endY - Math.max(bottom, rect.y)) },
      ];
    }).filter(rect => rect.width >= width && rect.height > 0);
  };
  let free = exclude([screen], toolbar, gap);
  if (modeSelector) free = exclude(free, modeSelector, 10);
  // A user-chosen position wins over automatic annotation avoidance. Retain it
  // when content grows by scrolling in place, rather than snapping the panel.
  const minimumHeight = Math.min(size.height, 80);
  if (!preferredPosition && avoidBounds.length) {
    let clear = free;
    for (const rect of avoidBounds) clear = exclude(clear, rect, 10);
    const usable = clear.filter(rect => rect.height >= minimumHeight);
    if (usable.length) free = usable;
  }
  const centeredLeft = toolbar.x + (toolbar.width - width) / 2;
  const below = toolbar.y + toolbar.height + gap;
  const candidates = free.map(space => {
    const height = Math.min(size.height, space.height);
    const left = clamp(preferredPosition?.x ?? centeredLeft, space.x, space.x + space.width - width);
    const top = preferredPosition
      ? clamp(preferredPosition.y, space.y, space.y + space.height - Math.min(height, minimumHeight))
      : space.y + space.height <= toolbar.y - gap
        ? space.y + space.height - height
        : clamp(below, space.y, space.y + space.height - height);
    return { left, top, width, maxHeight: preferredPosition ? space.y + space.height - top : space.height,
      distance: Math.hypot(left - (preferredPosition?.x ?? centeredLeft), top - (preferredPosition?.y ?? below)) };
  });
  const complete = candidates.filter(candidate => candidate.maxHeight >= size.height);
  const choices = preferredPosition ? candidates : complete.length ? complete : candidates;
  choices.sort((a, b) => preferredPosition || complete.length ? a.distance - b.distance : b.maxHeight - a.maxHeight || a.distance - b.distance);
  const best = choices[0];
  return best ? { left: best.left, top: best.top, width, maxHeight: best.maxHeight }
    : { left: clamp(centeredLeft, screen.x, screen.x + screen.width - width), top: screen.y, width, maxHeight: 0 };
}

/** Recording setup follows its region: roomy selections contain it; small ones
 * use the nearest clear outside edge. OCR and annotation retain their own rules. */
export function recordingPanelLayout(selection, bounds, size, modeSelector = null, sizeControlsOpen = false) {
  const margin = 8, gap = 12;
  const screen = { x: bounds.x + margin, y: bounds.y + margin,
    width: Math.max(0, bounds.width - margin * 2), height: Math.max(0, bounds.height - margin * 2) };
  const width = Math.min(size.width, screen.width);
  const height = Math.min(size.height, screen.height);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const centeredLeft = clamp(selection.x + (selection.width - width) / 2, screen.x, screen.x + screen.width - width);
  const centeredTop = clamp(selection.y + (selection.height - height) / 2, screen.y, screen.y + screen.height - height);
  const clear = (position, panelHeight = height) => !modeSelector ||
    position.left + width + gap <= modeSelector.x || position.left >= modeSelector.x + modeSelector.width + gap ||
    position.top + panelHeight + gap <= modeSelector.y || position.top >= modeSelector.y + modeSelector.height + gap;
  const onScreen = p => p.left >= screen.x && p.left + width <= screen.x + screen.width &&
    p.top >= screen.y && p.top + height <= screen.y + screen.height;
  const inside = p => p.left >= selection.x + gap && p.left + width <= selection.x + selection.width - gap &&
    p.top >= selection.y + gap && p.top + height <= selection.y + selection.height - gap;
  const center = { left: centeredLeft, top: centeredTop };
  if (inside(center) && clear(center)) return { ...center, width, maxHeight: screen.height };

  const outside = [
    { left: centeredLeft, top: selection.y + selection.height + gap },
    { left: centeredLeft, top: selection.y - height - gap - (sizeControlsOpen ? 38 : 0) },
    { left: selection.x + selection.width + (sizeControlsOpen ? 80 : gap), top: centeredTop },
    { left: selection.x - width - gap, top: centeredTop },
  ];
  for (const p of outside) {
    if (onScreen(p) && clear(p)) return { ...p, width, maxHeight: screen.height };
  }

  // A moved/wrapped mode selector reserves only its own area. Choose the
  // nearest clear rectangle, keeping Start fixed above the scrollable settings.
  let spaces = [screen];
  if (modeSelector) {
    const right = screen.x + screen.width, bottom = screen.y + screen.height;
    spaces = [
      { ...screen, height: clamp(modeSelector.y - gap - screen.y, 0, screen.height) },
      { ...screen, y: clamp(modeSelector.y + modeSelector.height + gap, screen.y, bottom),
        height: Math.max(0, bottom - modeSelector.y - modeSelector.height - gap) },
      { ...screen, width: clamp(modeSelector.x - gap - screen.x, 0, screen.width) },
      { ...screen, x: clamp(modeSelector.x + modeSelector.width + gap, screen.x, right),
        width: Math.max(0, right - modeSelector.x - modeSelector.width - gap) },
    ];
  }
  const usable = spaces.filter(space => space.width >= width && space.height > 0);
  const complete = usable.filter(space => space.height >= height);
  const candidates = (complete.length ? complete : usable).map(space => {
    const panelHeight = Math.min(height, space.height);
    const p = { left: clamp(centeredLeft, space.x, space.x + space.width - width),
      top: clamp(centeredTop, space.y, space.y + space.height - panelHeight),
      width, maxHeight: space.height };
    return { p, distance: Math.hypot(p.left - centeredLeft, p.top - centeredTop) };
  });
  candidates.sort((a, b) => complete.length ? a.distance - b.distance : b.p.maxHeight - a.p.maxHeight);
  return candidates[0]?.p ?? { ...center, width, maxHeight: screen.height };
}
