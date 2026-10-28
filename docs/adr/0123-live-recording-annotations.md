# ADR 0123: Live recording annotations

Status: accepted.

## Context

[Issue #189](https://github.com/yuxino/Kiri/issues/189) asks for annotations while
recording. Saved videos already support timed annotations in their editor.
Scrolling screenshots can already open in the image editor from the completion
preview. Live recording needs a way to mark the current desktop without putting
editing controls into the captured picture or preventing normal app interaction.

## Decision

- macOS and Windows recording controls offer **Annotate Recording** after both
  annotation surfaces are ready. Recording begins in desktop-operation mode.
  Pen, Arrow, Rectangle and Text share existing annotation appearance settings;
  Select can edit existing marks. Mosaic is excluded because a transparent
  annotation surface has no live source pixels to sample.
- **Operate Desktop** releases annotation input while retaining the visible
  marks. Escape first cancels active text editing or an in-flight gesture, then
  returns to desktop operation. Tool keys and Cmd/Ctrl+Shift+Backspace for
  clearing act only while the annotation surface has focus. They do not create
  new global shortcuts.
- Undo, Redo and Clear remain explicit controls. Clearing cancels unfinished
  drawing before removing marks and is undoable, so a later pointer release
  cannot restore a cleared draft. Paused recordings retain their annotation
  document; adjustments made while paused appear when recording resumes.
- The transparent `recording-annotation-ink` window contains only rendered
  marks and always ignores input. The separate
  `recording-annotation-input` window owns editing, selection handles and text
  input. That window and the control panel are excluded from capture. Both use
  the selected recording region's logical coordinates and native scale.
- Both surfaces are created before native recording starts. macOS explicitly
  includes the ink window in ScreenCaptureKit's filter alongside an enabled
  click ripple. Windows requires verified native capture exclusion for input
  and controls before enabling annotations. If that setup fails, ordinary
  recording can continue with live annotations unavailable.
- Commands validate the active recording session and caller window. Rust retains
  one bounded mark snapshot; monotonically increasing ink revisions reject
  obsolete publications. Renderers subscribe before hydrating state. Input and
  ink readiness are separate from platform support and setup availability.
  Stopping, cancellation and failure close both windows and discard transient
  marks; a new recording starts empty.
- Live marks are captured as video pixels, including GIF recordings produced
  from that video. They are not a saved editable video-annotation project and
  cannot later be removed independently. Editing chrome and the text caret
  never belong to the recorded ink layer.
- Linux keeps its existing tray, shortcut and command controls. Its portal
  cannot reliably exclude annotation controls, so live annotation is unavailable.
  Long screenshots retain their existing post-capture editor workflow.

## Verification boundary

Unit and renderer checks cover session ownership, bounded updates, publication
ordering, undoable clear, local keyboard handling and toolbar layout. They do not
establish native capture exclusion, focus restoration, DPI alignment or exported
video content.

Native acceptance must record real marks and inspect exported frames for ink
with no toolbar, selection handles or text caret. It must also exercise desktop
input after returning from annotation mode, pause/resume, stopping and a second
empty recording. macOS and Windows need their own evidence; success on one
platform does not establish the other.
