# Numbered screenshot callouts (#120)

## Candidate and checks

2026-10-10, based on `f9db76c6df8ce688e196809b30ce43d74d7722bb`.
This feature adds editable numbered circles with optional description labels,
sharing the Text toolbar slot in the capture overlay and saved-image editor.

- `pnpm test:release-tools`: 345 passed. The new canvas/project tests cover
  click/drag placement, independent handles, bounded geometry, automatic
  numbering, description edit history, undo/redo, crop, strict document
  validation, preview/export layout and Retina scaling. Empty live drags show
  a label guide; empty saved notes export only their circle.
- `pnpm build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
  `git diff --check`: passed. Cargo check reports four existing warnings.
- `cargo test --manifest-path src-tauri/Cargo.toml` on this Mac: 330 passed,
  one failed, one ignored. The failing native video test is
  `video_export::tests::native_annotations_follow_live_frames_and_independent_time_ranges`;
  it also fails when run alone, at the blue-channel contrast assertion in
  `video_export.rs` (difference must exceed 80). That file is unchanged by
  this feature. This is not a fully passing Rust suite.

## Isolated renderer acceptance

The QA harness uses generated source pixels and the actual annotation canvas,
capture Toolbar, TextToolPicker and CalloutControls. It does not request native
capture permissions or access a user library.

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

Fixed-path installation and native capture/editor acceptance are pending while
another Kiri task uses the shared installation. No Windows or Linux native
acceptance is claimed by the renderer checks above.
