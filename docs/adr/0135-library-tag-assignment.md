# ADR 0135: Assign and remove library tags

Status: accepted.

## Context

Issue [#201](https://github.com/yuxino/Kiri/issues/201) asks to assign tags by
dragging capture cards, create tags through a visible action, and remove a tag
from several captures at once. Tags are stored on each capture in the local
library index.

## Decision

- Drag a capture onto a visible tag filter to assign that tag. Dragging a
  selected card applies the tag to the current visible selection. Dragging an
  unchecked card applies it to that card. The gesture starts after pointer
  movement and highlights the tag under the pointer. Card activation,
  rubber-band selection, native file import, and selection export retain their
  existing entry points.
- **Add tag…** on each card opens its inline editor. **Manage Tags** in the
  selection toolbar can add a typed name or remove one of the selection's
  existing tags. Creating a tag attaches it to the targeted captures. A failed
  write preserves the draft or selection for retry.
- Edits apply a single tag change against the current index under the library
  lock. A drop validates that the destination tag still exists in the capture
  scope. The operation validates all selected IDs and writes the index once
  when tags change. Trimmed names match case-insensitively for ASCII characters.
  Duplicate adds and repeated removals are safe. Other tags and media files are
  preserved. The renderer applies acknowledged tags and discards older
  refreshes.

## Verification

The library tests cover repeated edits, a stale tag or capture, and index write
failure. Renderer tests exercise the real event handlers with mocked IPC.
Installed WebView drag behavior remains part of native acceptance.
