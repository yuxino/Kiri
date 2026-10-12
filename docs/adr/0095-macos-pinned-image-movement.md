# ADR 0095: Reliable macOS pinned-image movement

- Status: Accepted
- Date: 2026-10-12
- Extends: ADR 0081

## Context

Native regression of the signed macOS app found that dragging a reference image
could leave its window stationary, both before and after unpinning. The WebView
called `startDragging()` asynchronously. AppKit's `performWindowDragWithEvent`
requires the mouse-down event; the event can already be a move or mouse-up when
Tauri handles that request.

## Decision

On macOS, capture the image's left-button pointer and move the window from its
initial physical position plus the pointer's screen-coordinate delta converted
using the window's scale factor. Serialize native position requests and coalesce
intermediate movement, retaining the release position even when the initial
position read is pending. Pointer cancellation, a replacement gesture, and
unmount cancel pending movement. Controls and the resize grip keep their existing
handlers and never start image movement.

Windows and Linux retain native dragging, including their window-manager
behavior. Use existing scoped position permission; do not expand capabilities.

## Consequences

macOS reference dragging no longer depends on AppKit's current event surviving a
WebView IPC round trip. Focused regressions cover Retina coordinates, negative
origins, serial updates, short gestures, cancellation and the unchanged native
path on other desktops. Native acceptance must verify window-position changes,
as well as resizing and pin state; a correct cursor alone does not prove movement.
