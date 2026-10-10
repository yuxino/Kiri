# Directional label verification

The isolated browser surface is `scripts/qa/annotation-harness.html?labels`.
It uses generated source pixels and the real annotation canvas, toolbar, text
menu and label controls. It does not call native capture or touch a user library.

## Covered

The feature includes the numbered-callout gesture fix from `f5e14e2`. Selecting
a label while its inspector changes the stage mid-click does not move it;
browser retesting also verified Space activation after this integration.

- Text menu contains ordinary text, numbered callouts and label bubbles.
- Chinese multiline typing, flipping while the textarea owns focus, and Return
  commit preserve text and geometry.
- Clicking a committed dot and activating it with Enter flip exactly once;
  undo and redo restore its direction. The dot does not start a canvas gesture.
- The real PNG export retains the neutral body, white text, tip and colored dot
  without selection handles. [Export comparison](label-export.png).
- All seven languages keep the wrapped toolbar, direction controls, font slider,
  color swatches and hint inside a 480×640 browser viewport at 2x. Measurements
  are in [label-layout-results.json](label-layout-results.json), with a
  [German narrow-layout example](label-de-480.png).
- Unit regressions cover native/frontend direction validation, legacy documents
  and preferences, dot selection, flipping/history/export/reopen, live font
  changes, movement bounds, scaled rendering and crops containing only the dot.

## Local checks and limits

The branch incorporates numbered-callout merge `4225a50`, including main
`eb3a8c9` (hover colors and Windows confirmation dispatch). Only the three
README feature paragraphs required conflict resolution; both descriptions are
retained. Label annotation source, rendering and styles match the previously
validated implementation, and ADR 0084 remains intact.

`pnpm build`, `pnpm test:release-tools` (362 tests), `cargo check`, and
`git diff --check` passed after this integration. The complete macOS 27.0.1 Rust run had 334 passing tests,
one ignored test and one failure in the pre-existing
`native_annotations_follow_live_frames_and_independent_time_ranges` test at its
post-annotation blue-channel pixel-difference assertion. The same assertion
failed when that test was run alone. The new label serialization test passed.
No native video-renderer or pixel-threshold change is part of this feature.

The coordinating test slot reported native macOS acceptance for integrated
candidate `09b62e7`, installed at `/Applications/Kiri.app` with the existing
signing certificate. A generated image in the real editor covered Chinese
multiline entry, actual mouse-dot switching while editing with textarea focus
retained, committed-dot switching, undo/redo, and save/reopen preserving both
text and direction. The saved label also rendered correctly in the borderless
pin window while resizing proportionally from 1360×850 to 1160×726.

This task does not replace that fixed-path application. The editor/pin results
do not establish screenshot-overlay completion/clipboard/focus, physical IME
composition, or installed Windows/Ubuntu label interaction. The coordinating
test slot owns broader combined native acceptance and the merge decision.
