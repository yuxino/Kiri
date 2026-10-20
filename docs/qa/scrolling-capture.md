# Scrolling-capture acceptance

This is an acceptance procedure, not a record of passing native verification.
The contract is [ADR 0112](../adr/0112-free-bidirectional-scroll-capture.md).
Record the exact revision/package, OS, display scale, input device, sample,
sequence, result and evidence location. Repeat the same failing sample after a
fix; an isolated renderer or synthetic core fixture cannot establish native
capture quality.

## Portable and renderer checks

```bash
cargo test --manifest-path src-tauri/Cargo.toml scroll_document::tests
cargo test --manifest-path src-tauri/Cargo.toml scroll_frames::tests
cargo test --manifest-path src-tauri/Cargo.toml scroll_capture::tests
# macOS source identity and geometry checks:
cargo test --manifest-path src-tauri/Cargo.toml scroll_window::tests
node --test scripts/scroll-capture.test.mjs scripts/overlay-window-selection.test.mjs scripts/i18n.test.mjs
```

The source tests own the exact cases and assertions. Verify that a route starting
in the middle, extending down, extending up, revisiting and extending again
produces the same original-pixel crop as a monotonic route over the same range.
Check one-pixel/odd-size movements, stale frames, small dynamic disturbances,
ambiguous repeated content, blank areas, fixed edges and limits. Include rendered
text with a fixed composer and translucent shadow, both scroll directions, and a
newly appended strip with contradictory pixels. Fixed-edge detection must remove
confirmed chrome while preserving scrolling blank margins. Recovery requires
independent displaced observations; repeating an unchanged viewport must not
resolve a contradiction. Rejection must leave the accepted placement unchanged.
Queue overload must preserve ordered samples, the newest view and its byte budget
without blocking the producer.

Exercise the real panel with native IPC substituted only in an isolated harness.
Check all seven languages at 320 × 400, 280 × 360 and 220 × 76, including starting,
reconnecting, failed-save, stopped-source and explicit partial-save states. Check
actual text/action geometry, current-view positioning, preview scrolling across
prepends, single-flight status polling and StrictMode/unmount cleanup. Existing
annotations and live drafts must block entry without mutation. A focused button
uses native activation; the source application's Enter must not complete capture.
Verify that the single live preview uses original-pixel crops fitted to its
width, never enlarges beyond the source display size, and keeps the same scale
as the screenshot grows. Inspect text clarity at the actual panel size. Check
both following directions when a crop arrives after its status, including
prepends and revisits that do not change the document revision. Hold the
displayed region while scrolling inside it; an omitted image must retain its
geometry atomically. Moving the pointer away must restore following even when
the source is paused. These actions must not affect source scrolling or finish
capture.
Check title-row dragging and compact status-row dragging, including a short
gesture released before its native origin read completes, rapid reverse moves,
interrupted pointer capture and window teardown. Preview scrolling and buttons
must not move the panel. Check the persistent region guide at fractional scales
and all display edges: masks, borders and hints stay outside captured device
pixels, the selected interior remains clear, and native pointer passthrough
preserves source clicks and scrolling. The guide must survive pauses, recovery
and panel dragging, then close on cancel, completion or failed startup. Record
screenshots and geometry separately from any aesthetic assessment.

## Fixed desktop samples

Use nonprivate local fixtures or public pages with stable content. Prepare a
numbered article, a chat-style list with repeated shapes but distinct text, a
nearly blank page, a repeated-pattern page and a page with fixed top/bottom bars.
Use the same data and selected rectangle before and after every fix. Keep native
captures in the normal managed library only when the UI requires it; move only
agent-created test assets to recoverable Trash after review. Never empty Trash
or manipulate unrelated library files.

For repeatable local QA, start the normal overlay with the installed executable's
`--capture` command (on macOS, `/Applications/Kiri.app/Contents/MacOS/kiri --capture`).
This entry works for the running instance and first launch without synthetic
keyboard input. Use the real overlay, source application and selected pixels for
the remaining steps. CLI entry verification does not substitute for testing the
physical global shortcut.
After starting scrolling capture through its real toolbar, the installed executable
also accepts `--finish-scroll-capture` and `--cancel-scroll-capture`. Finish uses the
normal complete-result checks; exercise an unmatched view and confirm it stays in
recovery without silently saving a partial image. Cancel uses the same cancellation
gate as the panel and cannot interrupt the persistence commit. Verify completion
through the panel, normal saved result and application log, not merely the forwarding
process's exit status. Check that no-session control commands do not open the library
or start a new capture, and that a delayed command cannot affect a replacement session.

The standalone macOS fixture in `scripts/qa/scroll-fixture-macos.swift` renders
80 fixed, numbered English/Chinese blocks in a real native scroll view. It has no
Kiri IPC or capture substitution. Select below its header and inside its scrollbar;
start at Middle to exercise both directions. Up/Down in the header move the real
scroll view by 200 logical pixels while keeping any automation pointer indicator
outside the selected body. This validates captured content and matching, not
physical wheel/trackpad behavior. Build instructions are in the source.

`scripts/qa/scroll-chat-fixture-macos.swift` adds real WKWebView text, tables,
large paragraph gaps, a fixed header, a composer with a translucent shadow, and a
separate floating timer window owned by the same application. Select the
conversation rectangle including its fixed edges. Check that verified scrolling
removes the fixed chrome from the saved body and that macOS window filtering
removes the timer even while it visibly covers the selected text. Also introduce
an external pointer/highlight window during the same route. Do not merely move
obstructions outside the region to obtain a passing capture. Keep UI clicks
separate from wheel/trackpad acceptance, and compare original-pixel crops against
the unobstructed body at the logged source offsets. This script is a source
application fixture, not a synthetic capture mode in Kiri.

For each supported native platform, test:

1. Begin halfway down a document. Scroll down, up beyond the starting point,
   down through known content, stop to read, reverse quickly, then extend both
   ends. Compare the saved range with the monotonic control capture. There must
   be no repeated, omitted or reordered text and no resize of native pixels.
2. Repeat with wheel and trackpad/inertia where available. Include slow and fast
   movement, source-app keyboard scrolling and a long pause. Kiri must preserve
   the source's scrolling/focus behavior and remain active during the pause.
3. Make a jump beyond overlap. Confirm the prior result is preserved, normal
   Done cannot silently save a gap, returning through known content recovers,
   and Save captured area requires its explicit action when offered.
4. Stop at a partly revealed last line and immediately choose Done. Check the
   final screen's inclusion, settling response, no duplicate completion and
   recoverable save failure/retry. Test Esc before final persistence begins and
   window destruction during capture; the source and temporary shortcut must
   stop without stranding the next session.
5. Capture near all display edges, with negative-origin/mixed-scale displays,
   odd physical dimensions and a large selected region. Inspect output around
   the controls. macOS/Windows placement inside the selection must demonstrate
   native exclusion with no panel, blank replacement or stale source pixels.
   X11 must keep the whole panel outside the selected pixels and reject a
   selection with no outside compact-panel space. Verify nonactivation and
   source focus restoration independently. Drag both panel sizes by their title
   or status row, reverse direction and drag toward all display edges. Confirm
   real native window movement, source focus and continued capture. For X11,
   inspect movement across the selection boundary, not only its final position;
   the panel must never enter the captured rectangle.
6. Include fixed headers, footers and shadows in the selection. Scroll both
   directions and compare the saved body against an unobstructed reference:
   detected fixed chrome must be stripped rather than repeated between sections.
   Compare from the first visible body row, not a crop chosen from the resulting
   origin: every initially visible text line must remain covered. A retained
   provisional shadow is allowed only at the outermost never-revisited edge;
   interior rows must recover clear original pixels.
   Preserve blank paragraph margins. Introduce a conflicting new edge, revisit
   it from different offsets, and verify that normal Done waits for recovery;
   explicit partial saving must not be reported as complete repair. On macOS,
   place an external floating window and a same-app timer over the selected
   body, then create another same-app window mid-capture. None may enter the
   output. Move, resize, minimize or close the bound source and confirm a stop
   with progress retained and no replacement-window selection. On Windows/X11,
   external-window exclusion is not implemented; keep the limitation explicit.
   Also test large blank areas, repeated patterns, horizontal motion, unknown
   jumps, zoom and reflow. Require recovery or stop on uncertainty and inspect
   for false matches; never claim invisible-content recovery.
7. Exercise sustained scrolling and queue pressure. Record CPU, memory,
   queue drops/frame age and export dimensions. On macOS, collect the debug
   source binding and periodic native geometry/copy timings; correlate these
   with stitch timings rather than attributing stutter to frame rate alone.
   Confirm that a changing excluded timer does not contaminate the body.
   Growth must stop at configured limits without losing the connected result or
   freezing controls. A fast
   passing sample is not evidence of unlimited-speed capture.
8. Start a new ordinary Screenshot, Record and OCR after cancellation, failure
   and completion. Confirm no leftover scroll source, Escape grab, stale panel,
   frozen capture buffer or disabled action. Preserve existing privacy grants
   and the stable application identity; do not reset permissions for QA.

## Platform evidence boundaries

- macOS: package/install the stable signed `/Applications/Kiri.app` and test
  existing Screen Recording permission, normal and full-screen Spaces, Retina
  pixels, source focus, region-guide passthrough, in-selection control exclusion
  and the one-window filter with external and same-app floating obstructions.
  Verify that source restart retains the exact window binding. Isolated geometry
  tests do not establish actual ScreenCaptureKit filtering or frame timing.
- Windows: run the build workflow, then test the produced native package with
  actual WGC timing, DPI/text scaling, focus, final-frame drain and panel
  exclusion and region-guide passthrough. This remains display-region capture;
  do not report macOS's external-window filtering as Windows functionality.
  A cross-compile or macOS browser fixture is not Windows acceptance.
- Linux X11: require the Ubuntu `.deb` build/install and isolated X11 check;
  extend evidence with actual scrolling samples. This remains display-region
  capture; inspect guide transparency and keep all painted controls and external
  floating obstructions outside the selected pixels. Xvfb does not establish
  physical display, compositor, trackpad or mixed-scale behavior.
- Wayland: verify the action is unavailable and ordinary Screenshot/Record/OCR
  remain unchanged. Portal video capture is not evidence of this feature working.

Passing counts and native results belong to a dated run record for the exact
candidate. Leave unexecuted items explicitly unverified.
