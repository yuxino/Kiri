# Numbered screenshot callouts (#120)

## Candidate and checks

2026-10-10, based on `f9db76c6df8ce688e196809b30ce43d74d7722bb`.
This feature adds editable numbered circles with optional description labels.
The original candidate shared the Text toolbar slot. Current capture and
saved-image toolbars expose Text (T), Numbered callout (N), and Label bubble (B)
as separate buttons ([ADR 0091](../../adr/0091-direct-text-annotation-toolbar.md)).
The dated checks below retain evidence from that original candidate; they do not
establish acceptance of the later toolbar change.

- `pnpm test:release-tools`: 348 passed. The new canvas/project tests cover
  click/drag placement, independent handles, bounded geometry, automatic
  numbering, description edit history, undo/redo, crop, strict document
  validation, preview/export layout and Retina scaling. Empty live drags show
  a label guide; empty saved notes export only their circle. Picker Enter/Space
  activate their native buttons without reaching capture completion. Selecting
  a callout retains the gesture's original coordinate mapping when the
  inspector changes the stage size.
- `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
  `git diff --check`: passed. Cargo check reports four existing warnings.
- `cargo test --manifest-path src-tauri/Cargo.toml` on this Mac: 330 passed,
  one failed, one ignored. The failing native video test is
  `video_export::tests::native_annotations_follow_live_frames_and_independent_time_ranges`;
  it also fails when run alone, at the blue-channel contrast assertion in
  `video_export.rs` (difference must exceed 80). That file is unchanged by
  this feature. This is not a fully passing Rust suite.

## Isolated renderer acceptance (original candidate)

The QA harness uses generated source pixels and the actual annotation canvas,
capture Toolbar and CalloutControls. Current toolbar acceptance selects the
three independent Text, Numbered callout, and Label bubble buttons directly.
The original candidate below exercised their shared picker. Neither harness
requests native capture permissions or accesses a user library.

Verified through browser pointer/keyboard input:

- Text/Numbered callout menu switching; menu Escape closes the menu.
- Filled circles, drag-positioned labels, multiline Chinese descriptions,
  next-number increments, selecting an existing circle and changing its number.
- Color, outline style, live badge/font sizes, independent badge/label dragging,
  undo/redo and PNG export.
- Description Escape blurs the field; input shortcuts remain in their fields.
- All seven languages at a 360×640 viewport have no horizontal overflow and
  keep the toolbar, inspector and menu within the viewport.
- Long multiline descriptions near the image edge fit within the document;
  font size may shrink to fit very small images or unusually long notes.

These checks establish renderer behavior. Native clipboard, focus restoration,
permissions and persistence need the separate installed-app checks below.

## Native application acceptance

The macOS app-only package is signed with the existing installation's original
certificate and `io.yuxino.kiri` identifier. Strict signature verification passes.
Updater artifacts are disabled only for this local packaging invocation; the
runtime updater configuration is unchanged. The development package is not
notarized.

Before packaging, inspect the installed designated requirement and explicitly
choose its existing certificate fingerprint. The package helper's automatic
choice may select a different valid Apple Development certificate; validity
alone does not preserve privacy identity. The installer correctly rejects that
mismatch; never bypass it or reset permissions for QA.

The final fixed-path app was installed and opened successfully with its original
designated requirement. Its executable SHA-256 is
`a6fbf6f161fc5c7dfe59750497e4bae351c681e4b05382d9dcd02ec3a6637eef`,
packaged from code at `f5e14e2577106cd1f956ee9981c79b1597a51450`.

The native saved-image editor was tested using one generated 640×360 source:
menu switching, dragged placement, Chinese multiline input, Escape blur,
live size, filled/outline styles, color, independent badge/label handles,
save, reopen, selection and a second description edit all worked. Appearance
defaults were restored after the test. Selection revealed that opening the
inspector could change the pointer coordinate mapping mid-gesture; this was
repaired and has an executable regression. In the final fixed-path retest,
clicking a reopened badge opens its inspector without moving it or enabling
Undo. Independent movement, changing the number to 3, editing its description,
saving and reopening again all passed.

The generated test asset was moved through the library UI into recoverable
Trash; the filtered library then showed zero matching assets. Search was
cleared and the shared installation released for combined native acceptance.
No existing capture or Trash contents were removed.

The native global capture overlay was observed, but reliable synthetic global
shortcut routing was not established. Full capture-to-clipboard, original-app
focus restoration, real IME composition and display-edge native checks remain
for the coordinated integration acceptance. No Windows or Linux native
acceptance is claimed by these renderer/editor checks.

## CI candidate

Code commit `f5e14e2577106cd1f956ee9981c79b1597a51450` passed the required
[PR run](https://github.com/yuxino/Kiri/actions/runs/38023991683): frontend,
renderer acceptance, macOS Rust, arm64/x64 macOS compile, Windows tests and
Ubuntu tests. CI macOS Rust passes despite the local contrast-test failure
recorded above.

The separate [full run](https://github.com/yuxino/Kiri/actions/runs/38023998131)
uses that same code commit and additionally builds installers, installs the
Debian package, and runs isolated X11/Windows desktop checks. It completed
successfully, including Windows installer/portable smoke checks and isolated
GNOME Wayland portal checks at scales 1, 1.25, 1.5 and 2. These isolated
checks do not establish physical hardware or mixed-display acceptance.

## Integration with main

2026-10-10: merged `origin/main` at `eb3a8c9`, including the screenshot hover
color picker and Windows confirmation repair. Conflicts were limited to the
ADR index and dictionary additions. Both features' strings remain present in
all seven dictionaries with identical sets of 728 keys, and the index keeps
ADR 0082 and ADR 0083. The shared keyboard handler and its executable test
context retain both the color-copy boundary and the numbered-callout picker.
The product design is unchanged.

- `pnpm test:release-tools`: 354 passed.
- `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
  `git diff --check`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`: 333 passed,
  one failed, one ignored on this Mac. The same native video annotation
  contrast assertion described above still fails; no test was weakened or
  ignored.

No fixed-path app was installed or restarted for this branch synchronization;
the shared installation remains owned by the coordinated integration check.
Current-head CI is tracked on PR #125 before merge approval.

## Initial text-focus timing

The combined renderer [run](https://github.com/yuxino/Kiri/actions/runs/38031534672)
at `d43f249` failed the saved-text assertion after a new capture. Its frontend
and renderer scripts were unchanged from the preceding passing `e2b037a` run;
the failed artifact did not record the textarea's value or saved document.

A controlled replay of that artifact delayed the actual initial focus frame
until after the first keyboard character. The callback selected the new `l`,
so subsequent input produced `ine one\nline two`. The saved document matched
the incorrect textarea value exactly. This reproduces a product input race
with the same assertion failure; it does not require a late IPC response.

The initial focus callback now preserves an editor that has already gained
focus. Two executable callback regressions cover early typing, an existing
caret and normal selection of untouched saved text. The renderer check keeps
its saved-text assertion and also checks the complete two-line value before
Enter and its exact equality with the exported text.

On this feature branch, the same delayed-frame replay retained
`line one\nline two` in both the editor and exported document. The entire
image-editing renderer sequence then passed, including undo/redo, both Escape
steps, close protection and Save As. All 356 frontend checks, build, Cargo
check and diff checks passed. The local Rust result remained 333 passed,
one failed at the previously recorded contrast assertion, and one ignored.
No fixed-path native app was installed or restarted for this repair.

## Integration with direct screenshot pinning

Merged `origin/main` at `1c7357c` after PR #123, preserving direct Pin,
hover color copying, ADR 0081/0082/0083 and the `58a0858` initial-focus repair.
No merge conflicts occurred. All 728 keys and shared values remain intact in
each of the seven language dictionaries. The isolated annotation harness now
supplies the toolbar's new Pin callback; it does not request a native pin.

All 362 frontend checks, frontend build, Cargo check, harness-inclusive
TypeScript check and diff check passed. Local Rust still reports 333 passed,
the same native contrast assertion failure, and one ignored. Current-head CI
is tracked on PR #125. The shared native app remains owned by the coordinated
combination acceptance; this synchronization did not install or restart it.
