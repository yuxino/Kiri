# ADR 0112: Free bidirectional scrolling capture

- Status: Accepted; native acceptance is recorded separately
- Date: 2026-10-20
- Replaces: The abandoned implementation approach in draft PR #161

## Context

A long screenshot should follow ordinary browsing. Users can begin in the middle,
reverse direction, pause to read, and revisit earlier content without creating
repeated sections. A downward-only append pipeline cannot express this contract.
The user explicitly discarded the former draft and authorized a fresh design.

The new implementation uses Kiri's platform capture boundaries and a new portable
Rust document matcher. Open-source research informed the interaction and failure
requirements; no scrolling-capture implementation from a GPL project is copied
or linked into Kiri. Draft #161 remains historical, not an implementation source
or acceptance baseline.

## Interaction

The screenshot toolbar offers Scrolling Screenshot after a region is selected.
Committed annotations and live text drafts disable entry; starting must not
silently discard them. The source application regains focus. Kiri neither
intercepts nor synthesizes scrolling, and does not reserve Enter. Wheel, trackpad,
source-app keyboard navigation and direction changes retain their native behavior.
A separate nonactivating region window stays visible until teardown. It dims only
outside the selection and marks its outer boundary; the interior remains clear.
Native pointer-event passthrough sends clicks, wheel input and trackpad gestures
to the source. The guide neither moves the crop nor contributes pixels to it.
On X11 every painted mask, border and hint stays outside the selected pixel grid;
macOS/Windows also apply their native capture exclusion.

The result grows above or below its initial frame. Returning through known
content moves the preview without adding that content twice. Pausing does not
end capture. The nonactivating panel shows one live preview, Done and Cancel.
The preview uses a bounded region of accepted original pixels, fitted to the
panel width without enlarging beyond the source display size. Its scale does
not shrink as the screenshot grows. It follows the accepted viewport in both
directions without changing source scrolling. Scrolling inside the preview
holds that region for inspection; moving the pointer away resumes following.
Drag the title row to move the panel; compact controls use their status row.
Moving the panel keeps the source application focused and does not change the
capture selection. Each move stays on the source display; X11 constrains every
position write outside the selected pixels, before moving the native window.
Preview scrolling and action buttons are not drag handles.

Controls prefer a position outside the capture. macOS and Windows can use their
native capture exclusion for compact placement inside the selection when no
outside position fits. X11 requires an outside 220 × 76 logical-pixel rectangle
plus a 10-point gap, because it cannot exclude the panel from capture. The normal
preview is 320 × 400, with a 280 × 360 fallback where space is narrower. Wayland
remains unavailable; do not claim that portal recording support establishes
scrolling-capture support.

An unmatched view keeps the confirmed document and last confirmed position.
Return to captured content and traverse the missing area to recover. Unknown
frames are not appended as a disconnected island. A jump that skips unseen
content cannot be repaired without showing the skipped content. When offered,
Save captured area explicitly saves only the connected result; normal Done must
not quietly authorize that fallback. Esc cancels before the saving commit begins.
The temporary Escape registration is released with the session.
The local commands `--finish-scroll-capture` and `--cancel-scroll-capture` expose
the same completion and cancellation flow for desktop shortcuts and automation.
They bind the active session at dispatch, do not start capture or open the library,
and finish never authorizes partial saving. They add no renderer IPC authority or
synthetic frame source.

## Capture and matching

- `capture/scroll.rs` starts native-resolution BGRA sources independently of the
  recording encoder and audio pipeline. Selection edges are snapped once to the
  frozen display's physical grid; odd pixel dimensions remain valid.
- macOS binds a normal application window that fully contains the selected area.
  `SCContentFilter(display:includingWindows:)` includes only that window, keeping
  the display-local crop unchanged. External timer/pointer windows and other
  windows of the same app are excluded, including newly created windows. No
  application-wide inclusion or silent display-capture fallback is used. The
  window ID, owner PID and global frame remain bound across source restarts.
  Main-thread SCK lookup is asynchronous; each complete frame, periodic idle
  check and final stop validate the window. Movement, resize or unavailability
  stops capture and preserves progress. This does not remove overlays drawn
  into the selected window's own pixels.
- Windows and X11 retain display-region sources. Their external floating windows
  are not automatically excluded by the macOS implementation. Kiri's own
  Windows controls use checked capture exclusion; X11 controls stay outside.
- `capture/scroll_frames.rs` owns a separate bounded raw-frame queue. It never
  waits for stitching in the native callback. Under pressure it retains the
  oldest unread and newest views when the byte budget allows, thinning interior
  samples while preserving chronology. Sequence, capture time and dropped-frame
  counts remain explicit. This does not guarantee overlap at unlimited speed.
- `core/scroll_document.rs` stores original-pixel strips at signed document
  positions. Multi-band row fingerprints propose positions across the existing
  document. A candidate must pass native-pixel overlap checks, informative-row
  coverage and ambiguity rejection before any new strip is committed.
- Verified scrolling motion identifies a contiguous moving body and removes
  detected opaque fixed top/bottom bars. The clean matching area is distinct
  from visible edge rows: an unproven shadow must not erase already visible
  text. Those provisional edge rows remain until a clean displaced observation
  replaces them; a never-revisited gradient can remain at the outermost edge. Stationary screen coordinates alone are insufficient evidence:
  blank paragraphs must remain eligible scrolling content. A still first frame
  cannot establish fixed edges. Removed chrome is not repeatedly stitched into
  the body, and body-origin changes update the preview's signed coordinates.
- New strips retain provisional row observations. A later displaced view that
  contradicts those pixels marks unresolved content; independent agreeing views
  can repair it using original pixels. Repeating the same viewport cannot prove
  recovery. Normal Done requires those known contradictions to be resolved;
  explicit partial saving does not claim to repair them.
- Multiple plausible matches, insufficient overlap and unverified changes leave
  the accepted placement unchanged. A previous displacement is not reused to
  guess through missing content. There is no seam blending or rescaling of saved
  pixels, nor a general-purpose reconstruction of arbitrary overlays.
- Matching does not reconstruct the entire long image on every frame. A crop of
  at most 4 Mi pixels is encoded by one preview worker. Saving materializes the
  accepted strips once; document and raw-queue budgets bound growth.

`scroll_capture.rs` owns the session, commands, worker, panel placement and save
transition. Commands validate the owning overlay or session panel. Capture,
stitching, preview encoding and status polling do not share a renderer-driven
frame loop. Done waits for settled frames, stops and drains the native source,
then rechecks connectivity and unresolved pixel contradictions. If the last view
cannot be verified, normal completion returns to recovery rather than saving a
misleading result. A restarted macOS stream uses the same bound window identity.
Saving uses the existing local library, clipboard and completion feedback path. A failed save
retains the same document for retry; cancellation cannot interrupt the final
persistence commit.

## Current limits

This is vertical matching of one stable selected surface. Fixed-edge removal
requires verified motion and suitable pixel evidence; it is not a promise to
remove every sticky element or animated overlay. macOS isolates one normal
application window, while Windows/X11 require external floating windows to stay
outside the selected region. Large blank regions, repeated patterns, horizontal
movement, zoom and layout reflow can prevent reliable matching. Moving or
resizing the bound macOS source requires a new capture. Unknown jumps cannot
recover unseen content, and unresolved contradictions require revisiting the
area before a complete save. An internal transient overlay seen only once cannot
be proven clean from pixels alone. Review the result if the source content changed.

The implementation does not cache disjoint page sections, infer a hidden page
length, inject automatic scrolling or request application/DOM access. Broader
support needs new evidence and an explicit extension of this decision.

## Verification

Use [the scrolling-capture checklist](../qa/scrolling-capture.md). Core fixtures,
queue tests, renderer behavior and browser geometry are separate evidence from
installed native capture, focus, permissions, source frame timing and exported
control exclusion. Record the exact package, platform and sample for each native
result; this ADR does not assert that those checks have passed.
