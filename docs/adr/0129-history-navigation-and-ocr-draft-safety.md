# ADR 0129: History navigation and OCR correction safety

- Status: Accepted
- Date: 2026-11-06
- Extends: ADRs 0055, 0072, 0093 and 0124

## Context

An annotation gesture holds the mark and array index from its initial press.
Undo can restore a deleted neighbour before release, allowing that old gesture
to overwrite the restored mark with a duplicate identity. Clearing marks during
a new stroke can likewise leave a draft that reappears on release. A live font
preview also needs to finish before history changes.

OCR corrections belong to Text History's mounted component. Leaving the page
while a save is pending loses its draft and error if persistence subsequently
fails. An earlier media import or paste can also navigate away when it finishes.

## Decision

- Undo and redo discard the active pointer gesture and capture-click checkpoints
  before changing local or externally owned history. They finish a live font
  adjustment as one edit before traversing history. Late move, release and
  cancellation events cannot commit the abandoned gesture.
- Delete uses the same gesture cancellation. Clear discards pointer, font and
  appearance previews, including a new stroke with no committed marks.
- The saved-image editor ignores repeated Enter events for saving, matching
  capture's requirement for a fresh press after committing inline text.
- Text History synchronously locks main navigation when correction editing or
  saving starts. Other destinations are disabled until explicit Cancel or a
  successful save. Failed corrections retain their draft, original save version
  and error for retry. Restore Original Text locks only its pending request.
- Media import and paste cannot start while correction navigation is locked.
  Previously started operations may finish, but cannot switch destinations while
  the lock is held. The parent checks a synchronous ref as well as rendering
  disabled controls, covering events before the next React render.

## Verification and limits

Real component-handler regressions cover restored mark identities and export,
undo/redo during drawing, movement, resize and endpoint changes, late pointer
events, clear, external history callbacks and font adjustment. Editor regressions
cover repeated and fresh Enter, focused controls and composition guards.

Parent/child navigation regressions mount LibraryWindow with TextHistory and
exercise unsaved corrections, deferred save rejection and retry, cancellation,
successful saving, Restore Original Text, drops and prior import/paste completion.
The correction remains in window memory; application closure and crash recovery
are outside this decision. Mocked IPC and component events do not establish native
keyboard, IME, packaged-app or cross-platform desktop acceptance.
