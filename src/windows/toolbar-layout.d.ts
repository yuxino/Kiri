import type { Rect } from "../annotation/geom";
export function captureToolbarPosition(
  selection: Rect,
  bounds: Rect,
  size: { width: number; height: number },
  sizeControlsOpen?: boolean,
  modeSelector?: Rect | null,
): { left: number; top: number };
export function capturePanelLayout(
  selection: Rect,
  bounds: Rect,
  size: { width: number; height: number },
  modeSelector?: Rect | null,
  sizeControlsOpen?: boolean,
): { left: number; top: number; width: number; maxHeight: number };
