# ADR 0081: Direct screenshot pinning and borderless references

- Status: Accepted
- Date: 2026-10-10
- Extends: ADR 0058 and ADR 0077 (quick screenshot completion)
- Supersedes: ADR 0010's single completion action for the screenshot toolbar

## Context

Pinning from the completion card takes another action after finishing capture.
A selected screenshot should also be available as a floating reference directly
from its toolbar.
The [follow-up in issue #104](https://github.com/yuxino/Kiri/issues/104#issuecomment-6093315341)
also asks for a borderless reference image.

## Decision

- Add a pin icon beside Done in the screenshot toolbar. Its localized label is
  Pin Screenshot on Top. OCR and recording retain their existing actions.
- Pin uses the same annotation export, completion lock, clipboard copy and local
  library import as Done, Return and double-click. It preserves editable marks
  and displays the saved flattened image, including mosaic.
- Carry the explicit pin request through the capture's existing owner-bound
  confirmation. The overlay closes only after its IPC response; creation of the
  reference window waits until every capture overlay is destroyed.
- Restore the capture origin before opening the reference. A successful direct
  pin does not also show the ordinary completion card. Clipboard failures still
  receive feedback. A pin failure shows the saved screenshot's completion card
  with an error and its existing Pin action for retry.
- Keep the library and completion-card pin commands scoped to those windows;
  the overlay cannot pin arbitrary saved assets.
- Reference windows have no native title bar, shadow, image padding or permanent
  header. Their initial size fits the saved image within 680 × 480 points, with
  an 80 × 60 minimum to keep actions reachable. Transparent surroundings preserve
  the image's aspect for very small or narrow images and when the operating system
  changes the window's aspect.
- Drag the image to move it. Hover or keyboard focus reveals localized icon
  actions for Unpin/Pin and Close. Escape and Cmd/Ctrl+W also close the reference.
- A lower-right grip resizes proportionally through serialized native size
  updates. This works around the unsupported native resize-dragging API on macOS
  without expanding window permissions. It uses the window's actual scale factor.
  macOS and Windows disable native user resizing so their corner hit-testing
  cannot resize the axes independently; the grip requests sizes programmatically.
  GTK requires a resizable Linux window for programmatic sizing, so its native
  window receives fixed-aspect geometry hints before it is shown. X11 window
  managers can enforce these hints. GTK 3's Wayland backend forwards minimum
  and maximum sizes but does not forward aspect constraints to the compositor;
  its web grip still requests proportional sizes, while compositor-controlled
  resizing remains a limitation requiring separate native acceptance.

## Consequences

The selected screenshot can be saved and pinned with one click. Normal screenshot
completion remains clipboard-first. Platform topmost limits from ADR 0058 still
apply, including compositor-controlled behavior on Wayland.
