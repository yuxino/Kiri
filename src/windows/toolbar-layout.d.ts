import type { Rect } from "../annotation/geom";
export function captureToolbarPosition(
  selection: Rect,
  bounds: Rect,
  size: { width: number; height: number },
  sizeControlsOpen?: boolean,
  modeSelector?: Rect | null,
  preferredPosition?: { x: number; y: number } | null,
): { left: number; top: number };
export function capturePanelLayout(
  selection: Rect,
  bounds: Rect,
  size: { width: number; height: number },
  modeSelector?: Rect | null,
  sizeControlsOpen?: boolean,
): { left: number; top: number; width: number; maxHeight: number };
export function captureToolOptionsLayout(
  toolbar: Rect,
  bounds: Rect,
  size: { width: number; height: number; minimumHeight?: number },
  modeSelector?: Rect | null,
  avoidBounds?: Rect[],
  preferredPosition?: { x: number; y: number } | null,
): { left: number; top: number; width: number; maxHeight: number };
export function recordingPanelLayout(
  selection: Rect,
  bounds: Rect,
  size: { width: number; height: number },
  modeSelector?: Rect | null,
  sizeControlsOpen?: boolean,
): { left: number; top: number; width: number; maxHeight: number };
