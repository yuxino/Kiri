# ADR 0097: Discoverable, recoverable library batch actions

- Status: Accepted
- Date: 2026-10-12
- Partially supersedes: ADR 0019's rubber-band-only selection entry

## Context

Issue #144 requests batch movement to Trash. The library already supports an
atomic batch operation, but a drag from empty grid space is its only entry.
Failure also silently clears the user's selection.

## Decision

- Add Select captures to Library and Trash. Ordinary card clicks still open
  directly; explicit selection or rubber-band selection exposes checkboxes.
- In selection mode, card click, checkbox, Space and Return toggle that card.
  Select All and Cmd/Ctrl+A select the current filtered finished assets only.
  Editable text fields retain native select-all behavior.
- Cancel or Escape exits selection. Changing search, filter or section clears
  selection to avoid applying an action to invisible assets.
- Label the recoverable action Move to Trash with its selected count. Reuse the
  existing validated, atomic batch mutation and normal restore route.
- Serialize batch mutations, disable conflicting actions while pending, clear
  selection after success, and show an error with selection retained on failure.
- Permanent deletion stays confined to Trash with its existing confirmation.

## Consequences

Batch cleanup is visible without changing the default direct-open interaction
or introducing a permanent-delete shortcut. Unfinished recordings and hidden
search/filter results cannot be included by Select All.
