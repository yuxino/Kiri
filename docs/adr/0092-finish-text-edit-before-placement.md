# ADR 0092: Finish editing and clear selection before the next placement

Status: Accepted

## Context

Clicking an empty canvas while editing an annotation currently commits its text
and immediately opens another input or creates another mark. Users need a gesture
to finish editing or clear a selection while keeping their current tool ready.

## Decision

- In the capture overlay and saved-image editor, with any tool active, the first
  genuinely blank-canvas gesture while editing ordinary text, a numbered
  description, or a label commits that input and clears selection. It creates no
  new annotation or empty input; the next gesture uses the current tool.
- With Text, Numbered callout, Label bubble, Rectangle, Line, or Arrow active and
  an existing annotation selected, the first blank-canvas gesture only clears
  selection. A later gesture creates the next annotation.
- Consume each finishing or deselecting gesture explicitly, including its pointer
  release and click events. The tool remains active; do not automatically switch
  to Select.
- Pen and mosaic keep continuous drawing. Automatic selection of the previous
  stroke must not consume the next stroke. They still consume a blank gesture
  when it is needed to finish an existing inline text input.
- During watermark input, a gesture on blank canvas or the current watermark’s
  primary anchor commits and closes its editor without reopening it. Tiled copies
  count as blank canvas. Hitting another watermark’s primary anchor retains the
  direct switch to editing that object.
- Remember the just edited watermark by stable ID. The next blank-canvas edit
  reuses it, even when a document has several imported watermarks; if it was
  deleted, fall back to a surviving watermark. Repeated toolbar or inspector edit
  actions preserve the live native draft.
- Preserve dragging an existing annotation on its first drag, double-click
  re-editing, and native textarea composition, caret, selection, and text history.
  Hit testing existing objects and handles keeps those routes separate from a
  genuinely blank gesture. Ending a draft retains existing empty-draft rules.
- The video editor retains its creation-then-Select policy. Saved mark formats,
  appearance preferences, undo, crop, and export retain their existing paths.

## Verification

Exercise input finishing under every tool and selected-annotation clearing under
the six placement tools. The first blank gesture must leave no new input or mark;
the next uses the still-active tool. Repeat after reopening saved annotations,
including first drags, double-click editing, cancellation, undo, and save/reopen.
Check successive pen and mosaic strokes, ending watermark input on blank canvas
or its own anchor, direct switching to another watermark, reuse by stable ID with
several imported marks, deletion fallback, and repeated edit actions preserving
the draft and focus. Verify both screenshot editing surfaces; keep native IME
acceptance separate from browser text injection.
