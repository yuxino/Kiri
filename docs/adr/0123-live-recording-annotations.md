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
- `AnnotationTools` defines the shared tool order, icons, names, shortcuts and
  grouped buttons for capture, saved images, live recording and video editing.
  Capture, saved images and live recording also reuse its history buttons and
  `AnnotationStyleControls`. Each window selects its supported tools and owns
  its layout and actions. Video editing retains its timeline history and
  property inspector, including conversion between display and source sizes.
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
  Recording cancellation and recording failure release annotation input and close
  both windows after native capture stops. A new recording starts empty.
- Stopping a recording that used annotations first freezes the input document,
  commits text where possible and retains an in-flight drawing draft. It drains
  the latest vector update without waiting for the normal 34 ms publication
  timer. The ink renderer acknowledges that revision after a browser paint.
  This handoff has a 600 ms deadline, including blocking-pool queue time; a
  failed or unresponsive renderer cannot prevent stopping. An acknowledged
  handoff gets a further 34 ms capture interval before native stop. Recordings
  that never entered annotation mode skip this handoff. Input is released while
  the last ink remains visible until the native recorder and encoder finish;
  teardown then discards the transient document and both windows.
- Live marks are captured as video pixels, including GIF recordings produced
  from that video. They are not a saved editable video-annotation project and
  cannot later be removed independently. Editing chrome and the text caret
  never belong to the recorded ink layer.
- Linux keeps its existing tray, shortcut and command controls. Its portal
  cannot reliably exclude annotation controls, so live annotation is unavailable.
  Long screenshots retain their existing post-capture editor workflow.

## Verification boundary

Unit and renderer checks cover session ownership, bounded updates, publication
ordering, bounded stop handoff, undoable clear, local keyboard handling and
toolbar layout. A browser-paint acknowledgement does not prove that a native
video frame contains the final mark. These checks do not establish native capture
exclusion, focus restoration, DPI alignment or exported video content.

Native acceptance must record real marks and inspect exported frames for ink
with no toolbar, selection handles or text caret. It must also exercise desktop
input after returning from annotation mode, pause/resume, stopping and a second
empty recording. macOS and Windows need their own evidence; success on one
platform does not establish the other.
