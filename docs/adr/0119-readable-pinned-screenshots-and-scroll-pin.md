# ADR 0119: Readable pinned screenshots and scrolling-capture pinning

- Status: Accepted; native acceptance is recorded separately
- Date: 2026-10-24
- Extends: [ADR 0081](0081-direct-capture-toolbar-pin.md),
  [ADR 0096](0096-capture-origin-pin-placement.md),
  [ADR 0112](0112-free-bidirectional-scroll-capture.md) and
  [ADR 0113](0113-contextual-image-editor-and-zoom.md)
- Partially supersedes: ADR 0081's whole-image fitting for long references

## Context

[Issue #188](https://github.com/yuxino/Kiri/issues/188) shows a long screenshot
shrunk into a narrow reference window until its text is unreadable. Enlarging
the entire window would move much of the image off screen. The same report asks
to pin a scrolling screenshot directly from its capture controls.

## Decision

### Readable reference windows

- Give the flattened image its own scrollable viewport. Long references open
  from the top at a readable width instead of fitting the whole image's height.
  Recent ordinary screenshots keep their capture position and logical size;
  existing references keep their user-adjusted frame when pinned again.
- Reuse the editor's view geometry and input model with zero image padding.
  Wheel and trackpad scrolling browse the image. Pinch or Ctrl/Command-wheel
  zooms around the pointer without changing the window frame. One source pixel
  maps to one device pixel at actual size.
- Plain image dragging continues to move the window. Space-drag and middle-drag
  pan the image. A view gesture must not also move the native window. The
  lower-right grip retains proportional window resizing and existing platform
  constraints.
- Hover or keyboard focus reveals compact zoom controls. The percentage menu
  offers Fit width, Fit image and Actual size. Small references keep reachable
  controls without forcing a permanent header onto the image. Ctrl/Command
  +/− zooms, 0 fits the image, and 1 restores actual size; Esc and
  Ctrl/Command+W keep closing the reference.
- View changes do not modify the saved image, export resolution or annotations.
  Image content updates with unchanged dimensions retain the current view;
  display-density changes preserve the current reading center.
- Source placement for recent scrolling results uses the source selection frame
  and saved image dimensions. Missing or invalid source geometry uses a bounded,
  readable fallback. Screen positions stay in the bounded in-memory registry,
  not in the asset library or image files.

### Direct pinning from scrolling capture

- Add Pin between Cancel and Done. Done remains the primary action; compact
  controls retain a labeled, accessible pin icon. The source application keeps
  ownership of Enter and scrolling.
- Pin requests the same complete-image settling, save and clipboard path as
  Done. The first accepted finish request owns its destination; repeated or
  competing actions cannot save duplicate assets or change that request.
- Stop capture, destroy its windows and restore the source application before
  opening the saved image's reference. Successful pinning omits the ordinary
  completion card. A pin-opening failure keeps the saved image and shows the
  completion card with its existing retry action. Clipboard failure remains
  visible without discarding the saved reference.
- Pin never silently authorizes a partial result. When the panel offers only
  Save captured area, save that explicit partial result first and pin it from
  its completion preview. Saving failures preserve the document for retry;
  cancellation and the final noncancellable save boundary retain their existing
  semantics. CLI finish remains a normal complete-save request.

## Verification boundary

Geometry and component checks cover zoom anchoring, scrolling, gesture ownership,
tiny controls, content updates and finish-request races. Layout review includes
compact controls and all seven languages. These checks do not establish native
topmost behavior, physical trackpad feel, mixed-DPI display movement or Windows
10 dual-display acceptance. Scrolling capture retains ADR 0112's platform and
matching limits; this decision does not assert that native checks have passed.
