# ADR 0093: Consistent annotation selection and deletion

Status: Accepted

## Context

The capture canvas handled Delete only with Select active. Numbered callouts
opened their description on a single click, making selection unexpectedly own
text input. Inspector fields could also keep focus after a canvas press.

## Decision

- A single click selects an existing annotation; dragging moves the selected
  geometry. Double-clicking text, labels, numbered callouts, or watermarks opens
  inline editing. Creating a new text annotation still opens its input directly.
  This supersedes the existing-callout click-to-edit rule in ADR 0085 and the
  direct watermark switch-to-edit rule in ADR 0092.
- Unmodified Delete and Backspace remove the selected annotation with any tool
  active, in both capture and saved-image editing. A visible Delete annotation
  action uses the same operation, including while an inline draft is open.
- Text inputs, inspector fields, system composition and read-only result dialogs
  retain their own keyboard behavior. A canvas press restores canvas focus only
  after composition and draft validation permit leaving the input.
- Deletion discards the associated inline draft and pointer preview before
  removing the saved mark, clears selection, and creates one undoable removal.
  Export cannot resurrect the deleted draft or replace its neighbouring mark.
  Repeated Delete with no selection removes nothing.
- In video annotation mode, Delete with no annotation selected cannot remove
  the underlying source clip. Clips, effects and stickers keep their respective
  selection and history ownership.

## Verification

Cover every annotation tool, single/double clicks, canvas focus after inspector
use, both delete keys, the visible action, native text deletion, composition,
export locks, cancellation, undo/redo and saved output. Verify the real product
windows with isolated generated images and a stable-signed macOS package.
Browser-injected text does not establish physical IME or other-platform native
acceptance; CI and package evidence are recorded separately.
