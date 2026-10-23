# Background interaction review — 2026-10-23

Source baseline: `981721c2f870f7c0a8a95dd067915fe2c41b4d4d` on `main`, plus
the initial interaction fixes. The checkout was clean and matched the live
remote main. The initial review did not commit, push, install or release;
the subsequent release preparation is recorded below.
See [ADR 0116](../adr/0116-pending-library-and-editor-actions.md).

## Fixed and reproduced

- Library/Trash and search navigation no longer display an older scope's cards
  with the new scope's actions. Deferred and out-of-order results, quick returns
  and same-scope refreshes have component regressions.
- Favorite, Move to Trash and Restore failures produce localized feedback.
  Pending favorites reject duplicate submissions; double-click does not submit
  an additional third request.
- Text corrections survive in-view selection/search attempts and asynchronous
  record refresh or failure. Pending saves protect the submitted text and permit
  retry after failure. Input-method Escape preserves corrections and OCR profile
  forms; ordinary Escape still cancels.
- Video playback shortcuts yield to focused controls, dialogs, input methods,
  modified keys and previously handled events.
- Sticker decoding blocks premature export and document edits, reports loading,
  and participates in normal close/save. Rejected decoding can retry; late
  results cannot change an unmounted or replaced document.

## Initial verification

- `pnpm test:release-tools`: 860 tests, 857 passed, 3 skipped, 0 failed. The
  baseline had 837 tests; this change adds 23 behavioral regressions.
- `pnpm build`: passed, including TypeScript and icon checks. The existing
  warning about a minified chunk larger than 500 kB remains.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml -j 2`:
  492 passed, 3 ignored; binary and documentation test targets passed.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets -j 2`:
  passed. No Rust sources or native build configuration changed.
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -j 2 -- -D warnings`:
  blocked by existing warnings in unchanged Rust files: unused platform helpers,
  argument count and style lints in commands, video export, QR, session state and
  GIF timing tests. This is not a passing strict-lint result.
- `git diff --check`: passed. Independent reviews covered library snapshot
  ownership, mutation feedback, OCR composition and pending video imports.

## Evidence limits and cleanup

All renderer tests use generated assets, mocked IPC and deferred promises; they
are component/state tests, not browser screenshots or native WebView acceptance.
The user was using the computer, so no app windows, browser windows, screen
capture, input automation, capture library access or installation was performed.
Native macOS IME/focus/layout and Windows/Linux acceptance remain untested.
Text History drafts remain in memory only while that editor is mounted; leaving
the main destination or closing the library does not persist an unsaved draft.

Verification reused the canonical build directories at low build priority.
Two incomplete incremental slots left by failed Clippy were checked for active
compilers and open handles, then removed (102,938,265 bytes). Completed current
builds and dependency caches were retained for the next native acceptance build;
no shared cache, installed app, source, credentials or user data was removed.


## Authorized v1.6.28 release preparation

The user subsequently requested pushing and releasing after verification. The
candidate version is `1.6.28`. An additional regression covers a sticker import
started while viewer close is waiting for a project save: close waits for that
import and flushes the updated document before it completes.

The earlier strict Clippy failures were repaired with equivalent Rust changes:
platform/test-only helper gating, the calling window's existing app handle, and
standard condition/slice idioms. The IPC business arguments and production media
paths remain unchanged. Independent review checked Linux/non-Linux compilation
boundaries and the declared Rust 1.88 minimum.

Final local candidate checks:

- `pnpm test:release-tools`: 861 tests, 858 passed, 3 skipped, 0 failed; 24 new
  behavioral regressions compared with the initial baseline.
- `pnpm build`: passed, including TypeScript and icon checks.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml -j 2`: 492 passed,
  3 ignored; binary and documentation test targets passed.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets -j 2`:
  passed.
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -j 2 -- -D warnings`:
  passed. The vendored Wry dependency still emits 17 non-fatal warnings.
- `node scripts/release-version.mjs v1.6.28` and `git diff --check`: passed.
- Whole-tree formatting remains a pre-existing issue: the same 35 files fail
  `cargo fmt --check` before and after the cleanup; no unrelated reformatting
  was included. Formatting is not a passing result.

These checks do not establish installed-app desktop acceptance. The initial
no-interruption constraint remains in force; no installed application, privacy
permissions, capture library or signing identity was changed during these
checks. Platform package CI and final signing/asset verification must succeed
before the draft release is made public; this preparation report does not
claim that publication or those later gates have completed.
