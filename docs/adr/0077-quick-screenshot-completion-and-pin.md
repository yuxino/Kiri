# ADR 0077: Quick screenshot completion and pinning

- Status: Accepted
- Date: 2026-10-09
- Extends: ADR 0003 and ADR 0058

## Context

Issue #104 asks for double-click screenshot completion and a more accessible
way to keep the resulting image above other applications. Pinning already
exists in the library, but reaching it requires leaving the capture flow.

## Decision

- A stationary double-click inside a screenshot selection confirms it. Both
  clicks must fall inside the region and away from its resize handles.
- While annotating, only the Select tool's unmarked canvas confirms. Existing
  text keeps double-click editing; shapes, handles, drawing tools, text inputs,
  and overlay controls do not confirm. OCR and recording do not use this gesture.
- Double-click, Return, and Done share the existing synchronous completion
  lock, clipboard copy, local import, and original-application focus restoration.
- Ready screenshot completion cards offer Pin alongside Copy and Trash. Pin
  reuses the existing reference window and dismisses the card on success;
  failures leave the card available for retry. Other media do not offer Pin.
- The pin command accepts only library and completion windows and still
  validates active, readable screenshot assets.

## Consequences

Capture remains clipboard-first and never opens the library automatically.
Pinning is an explicit action after the screenshot is saved. Native topmost
behavior retains the platform limits described in ADR 0058.
