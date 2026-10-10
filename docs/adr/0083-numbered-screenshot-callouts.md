# ADR 0083: Editable numbered screenshot callouts

- Status: Accepted
- Date: 2026-10-10

## Context

Issue #120 requests a numbered marker with explanatory text. The screenshot
toolbar must stay compact, and the notes need the same editable persistence
and local export behavior as existing annotations.

## Decision

- Text and Numbered callout share one toolbar slot with an arrow menu in the
  capture overlay and saved-image editor. T selects Text; N selects callouts.
- Click places a numbered circle. Drag sets the optional description's position.
  The inspector edits the number and multiline text; empty text leaves only the
  circle. Subsequent notes start after the highest existing number, up to 999.
- The default badge is filled. Color, badge size, font size and filled/outline
  style are adjustable. Only appearance is remembered across windows; sequence
  numbers and descriptions belong to the document.
- A callout is one mark with independent badge and label geometry. Dragging a
  selected handle moves its part; dragging elsewhere on the mark moves the whole
  note. The connector follows the closest label boundary.
- Local V1 annotation documents carry the callout kind. Frontend and Rust
  validation bound numbers, geometry, styles, and aggregate text. Crop translates
  both parts. Preview and PNG export share the same renderer and text layout.
- The inspector groups live field edits into one history change per field or
  slider gesture. Native input editing and IME remain local to the input; Return
  in the description adds a line instead of completing a screenshot.

## Consequences

Notes remain editable after saving and reopening. Older Kiri versions that do
not understand the mark can still view the flattened PNG, but cannot edit the
new project data. The normal screenshot capture, focus and privacy boundaries
remain in force; synthetic source images are confined to isolated QA harnesses.
