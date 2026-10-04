# ADR 0076: Inline capture size controls

- Status: Accepted
- Date: 2026-10-04

## Context

Exact-size input was hidden in the screenshot toolbar's More Actions row and
started with empty values. Selection dimensions were a separate passive badge.
The same operation should be directly available around the selection without
adding another screenshot toolbar button or a permanently expanded form.

## Decision

- Before annotation, the existing sliders button toggles width and height
  fields beside the selection's top and right edges. Recording options expose
  the same toggle. OCR and saved-image cropping retain their current behavior.
- Compact monochrome numeric pills follow the actual selection in physical
  output pixels. They flip inside the screen at display edges and separate
  for very small selections. Resize handles remain available.
- Inputs start with current dimensions. Enter and blur apply a positive integer;
  Escape discards the draft before another Escape cancels capture. Arrow keys
  adjust by one pixel, or ten with Shift. Inputs retain native editing shortcuts.
- Each axis preserves the selection center where screen bounds allow. Sizes
  clamp to the display and to the existing three-logical-point selection minimum.
- Controls hide while annotation locks the selection. The sliders then retain
  their annotation appearance controls. New selections and mode switches close
  the size controls; no extra setting is persisted.
- Toolbars and recording panels reserve space when placed above the selection.
  All controls remain frontend-only; capture and media backends are unchanged.

## Verification

Geometry tests cover Retina/fractional scale, invalid dimensions, boundary
clamping, and label separation at screen corners. An isolated UI harness uses
the real screenshot toolbar and recording options without a native capture
session or library access. Browser checks cover toggle, dimensions, draft
confirmation/cancellation, and screenshot/record mode switching. The macOS app
was packaged, installed at the fixed path, and launched with the existing
signing identity. Native selection interaction remains unverified because UI
automation could not trigger the system capture shortcut. Windows and Linux
distribution and native desktop acceptance remain separate.
