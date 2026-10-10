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

`pnpm build`, `pnpm test:release-tools` (356 tests), `cargo check`, and
`git diff --check` passed. The complete macOS 27.0.1 Rust run had 331 passing tests,
one ignored test and one failure in the pre-existing
`native_annotations_follow_live_frames_and_independent_time_ranges` test at its
post-annotation blue-channel pixel-difference assertion. The same assertion
failed when that test was run alone. The new label serialization test passed.
No native video-renderer or pixel-threshold change is part of this feature.

A local app bundle was built before the final dependency merge, but packaging
failed at updater signing because no updater private key was configured. That
bundle is not the final candidate. The coordinating test slot builds and tests
the integrated app at `/Applications/Kiri.app`; this task does not replace
another chat's running app. Browser checks do not
establish macOS WebKit IME, native focus/clipboard, Windows, or installed Ubuntu
acceptance. Those results must be recorded before promoting the integrated app.
