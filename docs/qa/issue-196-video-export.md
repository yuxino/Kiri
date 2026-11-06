# Issue #196 video export investigation

Date: 2026-11-06. Local branch: `fix/196-video-export`.
Initial base: `193977d273c549c070b3274ba3971f77c523d05e` (Kiri 1.6.37).
The branch was then synchronized with main at
`0811daf87e81cfd78989832ff6e9d01f422f738f`, which includes #197's annotation
history and OCR correction fixes. Its ADR 0129 is preserved; the video export
decision is ADR 0130. The initial evidence below predates that integration;
the combined branch is checked again by #198's CI before merging.
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
- Update all seven languages and record the boundary in ADR 0130.

## Initial local validation

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
  asset/GIF timing models. That focused harness compiles the Windows regression
  tests without running them or checking Tauri commands/the full Windows app;
  the actual Windows runtime results are recorded separately below.
- Actual React export/settings components with product CSS in isolated
  Chromium: 140 cases passed (seven languages, ten failure states, 320/800 px).
  No horizontal/text overflow; narrow German/French/Chinese images reviewed.
- Independent complete-diff review found no blocking issue. Diff whitespace
  check passed.

Generated layout metrics, screenshots, the Windows compile harness and test
logs are retained under `src-tauri/target/qa/video-export-review/`; they contain
only generated fixtures, code and test results. No release or deployment was
performed. Intrusive native desktop testing remains paused.

## Windows runtime validation before integrating #197

[Windows Server 2025 CI](https://github.com/yuxino/Kiri/actions/runs/42211750439/job/127871852962)
passed 504 tests, with 4 ignored and no failures. It actually exercised the old
writable snapshot's sharing-violation HRESULT `0x80070020`, successful decoding
after closing that handle, and the prepared snapshot through the complex native
export smoke test. A generated MP4 also passed real import probing, decoding,
source/byte preservation and temporary cleanup. Numeric failure classification
and export cancellation/cleanup regressions passed.

[Generated media evidence](https://github.com/yuxino/Kiri/actions/runs/42211750439/artifacts/13500240785)
was retained. This run tested PR preview `2d62f69` (head `5efca02` with initial
main `193977d`); both had tree `c649ae16c43fba096a069570fe20651f2ff6c78f`.
It is evidence for the video fixes before integrating #197, rather than the
final combined tree. Package, install and native desktop interaction steps were
skipped. The build quality gate and separate shortcut-layout workflow passed.

## Combined local validation after integrating #197

With main `0811daf` incorporated, the complete frontend suite passed 1006 tests
with 3 skipped and no failures. The frontend production build, Linux Cargo
suite (546 passed, 13 ignored), full Cargo check and diff checks passed.
An independent combined component run passed 291 annotation, editor, OCR and
video-export regressions. All nine non-index files from #197 match that main
commit byte for byte; video export implementation files remain unchanged from
`5efca02`. The index conflict retained both decisions, with video ADR 0130.

The final combined branch's platform CI is tracked on
[PR #198](https://github.com/yuxino/Kiri/pull/198) and must pass before merging.
The earlier Windows run above is not substituted for this integration check.

## Remaining verification and limits

The Windows Server 2025 fixture results establish the handle conflict and its
repair. They do not establish every codec/driver or the reporter's Windows 10
case. The Linux suite and cross-compilation do not extend that runtime scope.

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
