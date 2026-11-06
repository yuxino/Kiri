# Issue #196 video export investigation

Date: 2026-11-06. Local branch: `fix/196-video-export`.
Base: `193977d273c549c070b3274ba3971f77c523d05e` (main, Kiri 1.6.37).
The report describes Windows Kiri 1.6.36 and has no source fixture, native error
or follow-up comment. Its generic message cannot establish a disk-space cause.
No existing issue-specific PR or export branch was found before editing.

## Changes

- Close export snapshots before native media reading, retaining `TempPath`
  cleanup. Apply the same boundary before video-import probing. Windows media
  readers that deny write sharing can conflict with an existing writable
  `NamedTempFile`, even when that handle permits reads.
- Keep typed errors through the command, then expose only a failure stage and
  safe I/O category or numeric HRESULT/transcode reason. Persistent export
  diagnostics never print the raw error chain, paths or media names.
- Keep progress registration, annotation rasterization, native export and
  opening a saved copy distinct. Preserve the edit and retry. Opening a saved
  copy can retry without exporting again.
- A declined cancellation does not invent a saving phase or permanently
  disable cancellation. Only actual saving progress locks cancellation.
- Skip annotation canvas allocation for ordinary cuts with no annotations.
- Update all seven languages and record the boundary in ADR 0129.

## Validation

- Frontend/release-tools suite: 979 passed, 3 skipped (982 total).
- New frontend error/cancellation/open/canvas regressions: 15 passed, including
  injected failures in the actual video editor and export panel.
- Final frontend build: icon verification, TypeScript and Vite passed.
- Linux full Cargo suite: 546 passed, 13 ignored, no failures. The ignored tests
  retain their existing explicit fixture/service/measurement requirements.
- Full Linux `cargo check --manifest-path src-tauri/Cargo.toml --locked`: passed.
- Windows focused `cargo check --tests --target x86_64-pc-windows-gnu`: passed.
  The harness directly references actual source files for export, annotation,
  speed conversion, failure classification, import, GIF and media reading, plus
  asset/GIF timing models. It compiles the new Windows regression tests, but
  does not run them or check the Tauri command/full Windows application.
- Actual React export/settings components with product CSS in isolated
  Chromium: 140 cases passed (seven languages, ten failure states, 320/800 px).
  No horizontal/text overflow; narrow German/French/Chinese images reviewed.
- Independent complete-diff review found no blocking issue. Diff whitespace
  check passed.

Generated layout metrics, screenshots, the Windows compile harness and test
logs are retained under `src-tauri/target/qa/video-export-review/`; they contain
only generated fixtures, code and test results. No merge, release or deployment
was performed.

## Remaining verification and limits

The Windows media regressions still need an actual Windows runtime. One
exercises the old writable snapshot and requires sharing-violation HRESULT
`0x80070020`, closes it and decodes it successfully, then passes a prepared
snapshot through the existing complex export smoke test. Another generates an
MP4 and verifies real import probing, decoding, byte preservation and cleanup.
Cross-compilation does not establish those runtime results. Neither does the
Linux suite establish Windows codecs, drivers or Windows 10 behavior.

The paused intrusive native desktop tests were not resumed. No app install,
capture, permission change, user-library manipulation or native interaction
acceptance was performed. macOS and installed Windows/Ubuntu acceptance remain
outside this validation. The original #196 root cause remains unconfirmed.

The audit also covered source reading, snapshot copying, native processing,
encoding, cancellation, single-flight ownership, final import and opening the
copy. No additional definite defect was found in the cancellation/import
atomic gate, permit release, output RAII cleanup or failed-index-write rollback.

Source replacement after playback remains a separate consistency risk. Project
revisions include document changes and cannot directly serve as source tokens;
the asset-scoped playback URL also reopens the current path for range requests.
Strictly binding the displayed media and export requires a media-session/source
identity design. This patch does not claim content-level source pinning or
elimination of every possible export failure.

## API evidence

- [Media Foundation file flags](https://learn.microsoft.com/en-us/windows/win32/api/mfobjects/ne-mfobjects-mf_file_flags)
  define explicit write-sharing permission.
- [CreateFile sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
  require requested access and sharing modes to agree with existing handles.

These rules support the handle-lifecycle repair. They do not identify the
reporter's actual failure without the corresponding runtime evidence.
