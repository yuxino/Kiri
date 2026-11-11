# ADR 0134: Stable library search and inline tag editing

Status: accepted.

## Context

Many tags can push capture search onto another line. The existing tag input
also discards valid drafts when it loses focus, and saved tags have no rename
control. [Issue #200](https://github.com/yuxino/Kiri/issues/200) reports both
problems.

## Decision

- Put search beside the capture heading. The media and favorite filters stay
  in the row below, where the tag strip scrolls horizontally. Scroll buttons
  appear when needed and keyboard focus can reach every tag. Long names
  truncate visually and retain their full accessible name. Card chips reserve a
  separate column for removal so WebKit gives short labels their full width.
- The pencil on a card tag opens its name for editing on that capture. Enter
  and leaving the editor save a valid draft, including clicks on the empty
  grid and on card actions that preserve focus. Escape and Cancel discard the draft. An active
  input-method composition keeps control of candidate confirmation.
- Keep a failed draft and its error when a card leaves and re-enters the
  view. The user can correct the name or retry with Enter or Save.
- Apply individual add, remove and rename operations under the library lock.
  Renaming checks the original name and rejects a destination that already
  exists on the capture. A change of casing on the same tag is allowed.
  Writes preserve the existing trimming and ASCII case-insensitive
  deduplication policy. A failed write leaves the persisted list intact.
  Acknowledged tag lists can update the view while a fresh read is pending.
  An acknowledgement yields to a snapshot already replaced by a newer read.

## Verification boundary

Native unit tests use temporary libraries for persistence and rejected writes.
Renderer tests cover input handling, failed drafts, and delayed snapshots.
The browser harness uses the real library UI with fixture assets and simulated
desktop commands. Installed WebView and operating-system input methods require
desktop acceptance.
