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
  without selection handles. [Clean export](label-export.png).
- Fresh checks against the real Toolbar and Canvas after Pin integration keep
  all seven languages' Pin button, wrapped toolbar, direction controls, font
  slider, color swatches and hint inside a 480×640 browser viewport at 2x.
  Every language also passes actual dot clicks during editing with focus/text/
  geometry preserved, committed switching and toolbar undo/redo. Measurements
  are in [label-layout-results.json](label-layout-results.json). Screenshots:
  [English](label-pin-en-480.png), [简体中文](label-pin-zh-Hans-480.png),
  [繁體中文](label-pin-zh-Hant-480.png), [日本語](label-pin-ja-480.png),
  [Deutsch](label-pin-de-480.png), [한국어](label-pin-ko-480.png),
  [Français](label-pin-fr-480.png).
- Reopening the inline editor also preserves text/focus/geometry while flipping.
  Enter and Space activate its committed dot once and do not bubble to a window
  key listener. [Interaction data](label-interaction-results.json) records the
  real clean PNG export (18,095 bytes). The editor's initial focus runs on an
  animation frame; comparisons wait for `activeElement === textarea`. An early
  probe saw the expected transition from not-yet-focused to focused, rather than
  a loss of editing focus.
- Unit regressions cover native/frontend direction validation, legacy documents
  and preferences, dot selection, flipping/history/export/reopen, live font
  changes, movement bounds, scaled rendering and crops containing only the dot.

## Local checks and limits

The branch incorporates main `f640c48` (numbered callouts), including Pin at
`1c7357c`, hover colors and Windows confirmation dispatch. The fresh browser
checks use renderer source tree `da7311168e3846c3b85f412ac592ebbda8316ce2` and
harness blob `9e0fb3889806750ca2c0dd7450e41030b6920624`, from numbered base
`feef86c` plus the label feature. Main's squash tree was verified identical to
that base, so adopting main preserves the exact tested sources. All seven language
key sets and the paired READMEs retain the three features; ADR 0084 remains
intact. Label geometry, rendering and styles match the previously validated
implementation.

The shared TextEditor now preserves an editor already focused before its
initial animation frame. All 14 text/composition checks passed, including
execution of the actual delayed focus callback against early multiline input
and an existing caret; untouched reopened text retains its initial selection.
This dependency merged without conflicts and leaves only the label feature
and its tests/documentation in this stacked PR's diff.

`pnpm build`, `pnpm test:release-tools` (370 tests), `cargo check`, a separate
TypeScript check including the isolated QA harness, and
`git diff --check` passed after this integration. The complete macOS 27.0.1 Rust run had 334 passing tests,
one ignored test and one failure in the pre-existing
`native_annotations_follow_live_frames_and_independent_time_ranges` test at its
post-annotation blue-channel pixel-difference assertion. The same assertion
failed when that test was run alone. The new label serialization test passed.
No native video-renderer or pixel-threshold change is part of this feature.

The coordinating test slot reported native macOS acceptance for integrated
candidate `0ac2473`, installed at `/Applications/Kiri.app` with the existing
signing certificate. A generated image in the real editor covered Chinese
multiline entry, actual mouse-dot switching while editing with textarea focus
retained, committed-dot switching, undo/redo, and save/reopen preserving both
text and direction, complete two-line keyboard entry, and Clipboard PNG. The
earlier `09b62e7` candidate also rendered the saved label correctly in the
borderless pin window while resizing proportionally from 1360×850 to 1160×726.

The coordinator's product-equivalent `97d83a5` tree additionally passed the
actual macOS overlay's Direct Pin action during text editing, proportional
1360×816 → 1160×696 resizing, unpin/repin/close and native PNG clipboard output.
Decoded clipboard and saved-asset RGBA pixels matched exactly. Its `src` and
`src-tauri` trees were verified identical to the tested label/Pin combination.

This task does not replace that fixed-path application. Physical IME composition
and installed Windows/Ubuntu label interaction remain outside this task's
evidence. The coordinating test slot owns combined native acceptance and the
authorized merge sequence.
Pin/QR/native completion callbacks in the isolated harness are explicit no-ops;
the browser results establish layout and annotation behavior, not system IPC.
