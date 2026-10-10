# ADR 0082: Screenshot hover color picker

- Status: Accepted
- Date: 2026-10-10
- Partially supersedes: ADR 0003's prohibition on a hover loupe, for Screenshot mode only

## Context

Users want to inspect screen pixels and copy their color directly during capture,
without saving an image or opening another tool. Window recognition must retain
its single monochrome outline and normal click/drag selection behavior.

## Decision

- Idle hover over the frozen screen in Screenshot mode shows a compact monochrome
  loupe, display-local zero-based pixel coordinates, an sRGB `#RRGGBB` value and
  the platform's copy shortcut. It works before and after choosing a region.
- Sample the original frozen image, before dimming, selection borders or other
  Kiri controls. Actual decoded-image dimensions map logical coordinates to
  physical pixels, including Retina and fractional display scales.
- The loupe magnifies a 15×15 pixel patch with smoothing disabled, marks the
  center pixel and flips/clamps at display edges. Only the patch is copied into
  a sampling canvas; there is no second display-sized canvas or native capture.
- Cmd+C / Ctrl+C copies uppercase HEX through a capture-owner-checked native
  command. Success and failure appear in the loupe. Copying a color keeps the
  capture session, region and original application focus target intact.
- Dragging, resizing, moving, annotation, recording, OCR and QR hide the loupe.
  Controls, editable inputs, text selections and IME retain their native copy
  behavior. Existing annotation Cmd/Ctrl+C completion remains unchanged.
- No captures are persisted by color copying, and no additional permissions,
  network requests, preferences or library entries are introduced.

## Verification

Geometry/shortcut tests cover actual backing dimensions, fractional scales,
leading-zero colors, boundary flipping, inputs, text selections and composition.
The isolated `scripts/qa/capture-color-harness.html` mounts the real overlay with
Tauri's test IPC mocks and generated pixels; it never reaches a user's clipboard
or library. Platform acceptance and its remaining limits are recorded in
[`../qa/capture-color.md`](../qa/capture-color.md).
