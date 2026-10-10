# ADR 0085: Edit numbered callout descriptions on the canvas

Status: Accepted

## Context

The separate inspector textarea obscured the relationship between a numbered
badge and its description. Users need to type where the note will appear and
move that description independently. Continuous typing and OS composition must
retain the native textarea ownership established in ADR 0060 and PR #127.

## Decision

- Creating a callout opens its description editor directly at `labelRect`.
  Clicking a selected callout without dragging also opens that editor.
- The editor and rendered description have transparent backgrounds. The native
  text editor also stays transparent when editing ordinary text or directional
  labels; existing explicitly saved text backgrounds are preserved.
- The inspector contains number, filled/outline style, badge size, font size and
  color. It has no description textarea or separate drag instruction.
- Native input owns the live value, caret, composition and Undo/Redo. Selection
  notifications never write text back into that editor. Return inserts a line;
  Cmd/Ctrl+Return commits. Escape discards the draft and retains the badge and
  previously committed description. Clicking the canvas, switching tools and
  exporting commit the draft as one edit.
- The canvas keeps the badge and connector visible during editing. A grip at
  the description's top-right corner moves only the description. Badge handles
  and whole-mark dragging retain their existing behavior. New notes leave a
  32-point gap where the canvas has room; edge placement can choose another side.
- Persistence keeps the existing V1 callout fields. Empty descriptions remain
  valid numbered badges. Existing documents, crop translation and PNG export
  use the same model and renderer.

## Verification

Component regressions cover creation, live drafts, cancellation, exact export,
independent grip movement, continuous keys, native history and composition key
routing. Isolated built-UI regression and signed native package acceptance are
performed in the final integrated run; injected composition is not OS IME proof.
