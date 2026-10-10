# ADR 0089: Anchor label flips and drag callouts directly

Status: Accepted

## Context

Users expect a directional label's dot to identify a fixed image location.
Flipping only the pointing decoration moved that location. A separate black
grip also made moving a numbered description difficult to discover.

## Decision

- Supersede ADR 0084's fixed text rectangle during a direction change. Keep the
  dot in the same document position and move the bubble to its other side.
  Text remains readable and unchanged. Shared geometry supplies the preview,
  hit testing and export. Direction changes in the inspector or during inline
  editing use the same anchor rule.
- At an image edge, fit the text on the requested side by wrapping or reducing
  its frame and font as needed. Preserve the pointing location rather than
  clamping the entire label to a new location.
- Keep the existing text rectangle and optional direction field in saved
  documents. No migration or additional persisted anchor is required.
- Supersede ADR 0085's description grip. Dragging a numbered badge moves that
  badge; dragging its description moves only the description. Dragging the
  connector retains whole-callout movement. These work on the first drag.
- While typing, the transparent description frame's border and padding are
  direct drag surfaces. Require three CSS pixels of pointer movement before
  moving it. Text clicks and text selection retain native textarea behavior;
  active IME composition does not start a drag. Remove the separate black grip.
- A completed movement is one undoable edit. Cancelling a pointer gesture does
  not publish a partially moved annotation. Typing retains the existing native
  composition, caret, and text-history ownership.

## Verification

Cover fixed-dot flips, edge layout, repeated direction changes, inline editing,
first-drag badge and description movement, cancellation, composition guards,
and undo/redo. Verify real pointer interaction in the isolated product window
and the signed native application; browser injection is not physical IME proof.
