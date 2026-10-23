# ADR 0115: Control focus and retryable library tags

Status: accepted.

## Context

Background review of the real renderer components found that several local
controls lost ownership of their input: card clicks opened assets while editing
tags, input-method confirmation submitted tags, and video shortcuts intercepted
button activation. Portalled choice menus followed their position at the end of
the document instead of the trigger's focus order. Disabling every control during
an OCR profile save also let Tab leave the modal.

## Decision

- Card input and action controls own their clicks. Tag inputs do not submit or
  cancel while an input method is composing. Tag writes are serialized, show
  failures beside the affected tags, and preserve failed drafts for retry.
  Successful writes immediately become the card's confirmed tag list, including
  the backend's trimming and ASCII case-insensitive deduplication. Later actions
  use that list while the library refresh catches up, so a stale snapshot cannot
  undo an acknowledged deletion.
- Video canvas shortcuts yield Enter and Space to focused buttons and other
  activation controls, and yield keyboard handling inside input, menu and dialog
  surfaces. Canvas editing and undo shortcuts remain available in their existing
  contexts.
- Choice menus close on Tab without committing a highlighted option. Navigation
  continues before or after the trigger in the document's focus order, respects
  modal boundaries, and includes native summary controls while skipping hidden,
  disabled and inert content.
- A saved microphone ID that has not been enumerated, cannot be loaded, or is
  no longer present must not be labelled as the system default. Enumeration
  remains explicit on menu opening; rendering never opens an audio device or
  changes the selected ID.
- Settings modals keep Tab inside their boundary when a pending operation
  disables every control. The focusable dialog container provides a temporary
  target; failed operations restore normal navigation and closing restores the
  opener. Nested controls may handle their own Tab before the dialog fallback.

## Verification boundary

Renderer regression tests cover clicks, composition, pending and rejected
writes, delayed library snapshots, control activation and focus navigation.
Isolated browser harnesses use the actual product components and styles with
generated media and mocked IPC, including narrow localized settings and failure
states. They do not access the user's library, credentials, microphone or screen.
Native WebView, operating-system IME, capture, permission and installed-app
acceptance remain separate checks and require an appropriate desktop session.
