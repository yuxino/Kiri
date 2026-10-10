# ADR 0088: Edit annotation properties and local text watermarks on the canvas

Status: Accepted

## Context

Screenshot tools exposed different controls from saved-image tools. Selecting
most existing marks did not expose their properties. Mosaic offered a color
palette that had no effect, and changing the visible property panel moved the
saved-image canvas between clicks. Text should remain editable in place.

## Decision

- Share context-sensitive property controls between capture and saved-image
  editing. Selecting a mark reads its own properties; selection alone does not
  alter that mark or the saved appearance preferences. Explicit adjustments
  update the selected mark and future tool defaults. A slider gesture is one
  undo operation, and numeric controls accept keyboard input.
- Keep saved-image tool and property rows at fixed heights for each viewport
  width. Selecting, double-clicking, or typing must not move the canvas. The
  capture HUD measures its whole visible stack and constrains property scrolling
  while leaving completion controls reachable.
- Expose existing mosaic brush, rectangle and ellipse shapes, pixel and blur
  styles, and named strength levels. The brush preview follows diameter changes.
  Pixel blocks use a document-origin grid. Render weaker same-style masks first,
  including live drafts, so they cannot replace stronger coverage. Cross-style
  composition has deterministic order; this does not establish an information
  security guarantee for a blur or pixelation algorithm.
- Add an editable `watermark` mark to the V1 annotation document. It contains
  local text, a document-space rectangle, color, font size, opacity, rotation,
  single/tiled layout, and spacing. The PNG compositor draws watermarks above
  ordinary annotations. Appearance preferences retain only styling, never text.
- Watermark text uses the same uncontrolled native textarea as ordinary text,
  preserving composition, caret and native text history. The Watermark tool
  edits the last watermark or creates one in the canvas center. Single marks
  move and resize normally; only the primary tiled anchor is selectable, so
  repeated tiles do not intercept unrelated annotations.
- Cropping translates a tiled watermark's anchor even if it is outside the new
  canvas, preserving its pattern phase. The Watermark tool can reopen an
  off-screen anchor with an on-screen editor without moving the saved pattern.
- Validate before accepting a watermark edit. Bound text to 512 UTF-16 units,
  visible tiles to 4096 per mark and 8192 per document. Reject excess density
  explicitly in JavaScript and Rust. Never silently truncate a tiled pattern or
  save an image missing a rejected watermark.
- Older applications that do not recognize the new mark show the saved flat
  image and their existing invalid-project warning. They must not silently
  reinterpret or delete the unsupported editable content. This change adds no
  upload, network service or native media executable.

## Verification

Use generated image data for grid growth, overlap, opacity, layer order and
cropped-pattern pixel comparisons. Cover strict persistence, text draft dirty
state, undo/redo, second editing, live controls and off-screen anchors. Verify
both real product windows through an isolated IPC harness, narrow layouts and
all UI languages. Final native package checks and physical system-IME input
are recorded separately; browser text injection does not establish IME support.
