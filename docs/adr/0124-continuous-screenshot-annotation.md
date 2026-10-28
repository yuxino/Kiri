# ADR 0124: Continuous screenshot annotation and explicit completion

- Status: Accepted
- Date: 2026-10-28
- Partially supersedes: ADR 0092 (selected shape placement), ADR 0110 (automatic property avoidance)

## Context

The screenshot workflow consumes an entire empty-canvas drag merely to deselect
the previous shape. Ordinary text can finish the whole capture on Enter, while
callout and watermark inputs only finish their own editing. Right-clicking the
annotation canvas discards all marks, and automatic properties move as the
selected mark changes. These interruptions make consecutive edits unpredictable.

## Decision

- With Rectangle, Line or Arrow active and an existing annotation selected,
  an empty-canvas click only deselects. Dragging at least three CSS pixels uses
  that same gesture to create the next shape. The current tool remains active.
  Existing-object hits still move or resize that object on the first drag.
- Finishing active text/label/callout input still consumes a blank gesture.
  Text, Label and Callout placement retains a separate deselecting click,
  preventing stray empty inputs. Pen and mosaic remain continuous. Native IME,
  watermark reuse, double-click editing/completion, undo and the video editor's
  creation-then-Select policy retain their existing boundaries.
- Enter in ordinary text, labels and watermarks commits only the current edit;
  Shift+Enter adds a line. Callout Enter adds a line. Command/Ctrl+Enter commits
  the current edit for all of these inputs. Only a fresh Enter outside inputs
  confirms capture; a held key cannot close the editor and then confirm capture.
- Screenshot canvas right-click first commits active text, or cancels an
  unfinished drag. Otherwise it clears object selection and returns to Select.
  Completed marks, their undo history and the capture region stay intact,
  including after repeated right clicks. Inputs and controls keep their own
  context menus. Before annotation, right-click clears a chosen region; another
  right-click with no region cancels capture. Escape and Cancel remain explicit
  ways to leave capture. QR, OCR and recording keep their existing routes.
- Select/V before annotation keeps region resizing available. Once a drawing
  tool is chosen, the region remains locked so mark coordinates do not change.
- Automatic properties stay next to the main toolbar, independent of selected
  marks. Prefer an adjacent usable scrolling panel over relocating to show all
  fields. Toolbar/mode-selector collisions, display boundaries and the measured
  heading plus first-field minimum still constrain placement. Both panels retain
  independent manual dragging and keyboard movement for the current capture.
  No additional settings or floating controls are introduced.

These changes preserve the existing neutral visual style, local capture/export
pipeline, saved annotation format and appearance preferences. They do not add
post-annotation crop resizing, network behavior or a separate editor workflow.

## Verification

Use the same generated image for consecutive shapes, click-only deselection,
existing-object moves, undo/redo, double-click completion and cancelled gestures.
Check ordinary text, labels, multiline callouts, watermarks and composition guards;
verify one Enter ends text and the next confirms capture. Right-click must retain
completed content and history, including after cancelling a drag or text input.
Check default/manual property placement at display edges and narrow widths in
multiple languages, and shared saved-image/video editing behavior.

Isolated browser data and automated composition events do not establish native
IME, global shortcuts, screen capture or focus restoration. Native desktop
acceptance remains separate when the user requests uninterrupted desktop use.
