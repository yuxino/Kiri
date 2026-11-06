# ADR 0130: Video export failure boundaries

Status: accepted.

## Context

Issue #196 reports a Windows export failure. The existing message advised
checking library access and free disk space for every failure, including
annotation preparation and opening a copy that had already been saved. The
report contains no native error or source fixture, so it does not establish a
storage or encoder root cause.

Windows Media Foundation readers can deny write sharing. Export and video
import previously passed snapshots to native media while retaining the
temporary file's writable handle.

## Decision

- Finish writing and close source snapshot handles before native reading or
  probing. Keep path ownership for automatic cleanup on success, failure and
  cancellation. Do not modify the original video.
- Keep typed backend errors until the IPC boundary. Return and persist only a
  bounded failure stage and an I/O category, numeric HRESULT, numeric native
  transcode reason, or unknown code. Never include paths, media names, native
  error text or edit content in these export diagnostics.
- Distinguish source reading, temporary snapshot preparation, native rendering
  and library saving. Frontend progress setup and annotation preparation have
  separate recovery messages. All seven languages retain the edit and retry.
- A saved copy stays saved when opening its viewer fails. Open can retry
  without rendering another copy.
- Only a genuine saving progress event disables cancellation. A negative
  cancellation acknowledgement is retryable; it does not prove saving began.
- Ordinary cuts without annotations do not allocate an annotation canvas.

## Verification boundary

Portable unit tests exercise source bytes, closed handles, temporary cleanup,
copy failures, cancellation and path-free error classification. Real-component
frontend regressions inject preparation, rendering, saving, cancellation and
open failures. Windows isolated media tests exercise the old write-sharing
conflict, the closed snapshot through complex native export, and video import
through native probing and decoding. The [Windows Server 2025 CI run](https://github.com/yuxino/Kiri/actions/runs/42211750439/job/127871852962)
passed all of those runtime regressions (504 tests passed, 4 ignored), including
the old writable snapshot's `0x80070020` failure and successful decoding after
closing the handle. Cross-compilation alone is not this runtime evidence.

No desktop capture, installation, permissions, driver or mixed-display
acceptance is implied. The reporter's exact cause remains unconfirmed without
the corresponding source and native failure evidence. Source replacement
between playback and export is a separate consistency limitation: the current
playback URL is asset-scoped, rather than a pinned media session. Snapshot
isolation does not establish that externally replaced media matches an
already decoded preview.
