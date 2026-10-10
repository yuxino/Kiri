# ADR 0084: Directional label bubbles

Status: accepted

## Context

Screenshots need short explanatory labels with a visible pointing dot. Changing
which side a label points toward should be a direct action on the annotation,
without moving its text or adding another permanent toolbar slot.

## Decision

- Add Label bubble (B) to the shared Text / Numbered callout tool menu in the
  capture overlay and saved-image editor.
- Clicking the image opens the existing native textarea for editable text.
  Return, Shift+Return, Escape and IME handling retain the text tool's behavior.
- Use a restrained opaque charcoal body, light text, proportional padding and
  rounded corners. The selected annotation color applies to the small dot.
- Clicking that dot flips the tip and dot between left and right. Its text,
  content rect, font and selection stay unchanged. Each committed flip is one
  undoable edit; flips during typing remain in that text edit.
- The dot is a real button with a readable action name, hover/focus feedback and
  Enter/Space activation. Pointer events do not start a move or finish capture.
- Provide font, dot-color and direction controls. The existing eight handles
  resize a label; body dragging moves it, and double-clicking edits its text.
- Persist labels as text marks with an optional `labelDirection: left | right`.
  Omitted fields retain ordinary text behavior. Both native and frontend parsers
  reject invalid values and preserve the existing bounds and revision protection.
- Use the same text and decoration geometry for the editor, exported PNG and
  hit testing. New text frames and movement reserve room on both possible sides
  so flipping does not move a label or clip its dot. An explicit crop may clip
  annotations and retains any intersecting body, tip or dot.

## Consequences

Labels share the existing local project, undo/redo, font sizing and cropping
paths. Older Kiri versions reject the extra field instead of silently dropping
its appearance, then use the existing invalid-project protection and flattened
image fallback. No network capability or new library layout is introduced.
