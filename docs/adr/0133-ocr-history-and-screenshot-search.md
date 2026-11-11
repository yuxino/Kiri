# ADR 0133: OCR history actions and screenshot text search

- Status: Accepted
- Date: 2026-11-11
- Extends: ADRs 0007, 0030, 0055 and 0129
- Issue: [#199](https://github.com/yuxino/Kiri/issues/199)

## Text History

The detail pane offers **Move to Trash** directly. It uses recoverable library
Trash and reports failures in the detail pane. The record and its PNG snapshot
move together.

**Recognize Again** reads the saved source snapshot with the active OCR
engine. A corrected record requires explicit approval to replace the correction.
A remote profile requires a separate per-image Send action that names the
destination and model and shows image dimensions and size. For a corrected
record with a remote engine, one dialog discloses both consequences. The
approved, bounded PNG is held by the existing expiring request controller
and each Send consumes a request. The backend checks the selected profile's
revision before sending.

An accepted nonempty result replaces the OCR text on the existing record and
becomes its new original recognition. Empty results, recognition errors, and
failed index writes preserve both saved text versions. The backend validates
the library identity and generation, source file and OCR revision before
recognition and again before saving. A correction, source replacement, or
Trash transition invalidates older requests. The reader refreshes after an
ambiguous IPC failure and reports the failure for retry.

## Screenshot search

**Settings → Text Recognition → Search text in new screenshots** is off by
default. When enabled, a successful standard or scrolling screenshot save
offers its asset ID to a single background worker with an eight-item queue.
The worker uses the bundled offline PP-OCR model. It bounds input to 20 MiB
and 64 million pixels and stores at most 32 KiB of recognized text per image.
Capture, clipboard and feedback run independently of recognition.

The optional text is stored on the screenshot in the managed library's index
and matched by the existing capture search. Manual Text History still contains
only explicit recognition records. The index travels with the library and
follows the screenshot through Trash. Kiri clears indexed text when an image
is changed in the editor or its missing file is replaced. The worker checks
the current library generation, image revision, file and preference before
writing. Disabling the setting invalidates pending work and retains previously
indexed text for search.

Indexing applies to screenshots saved after enabling the setting. Older
screenshots can be recognized manually into Text History. Imports, prior
captures, and later image edits are outside automatic indexing. Items can
be skipped when the queue is full, recognition fails, or the app quits before
processing. External changes to previously indexed files are outside Kiri's
editor invalidation path.

## Verification

Library tests exercise persisted search, recoverable Trash, stale source and
text revisions, empty results, and failed writes. UI regression tests exercise
direct Trash, confirmed replacement, remote consent, retry, and late list
responses with controlled IPC. A browser check exercises the real settings
layout in eight languages at 820, 1020 and 1280 CSS pixels, plus the detail
toolbar and remote dialog at minimum width. It uses synthetic records and
checks focus return on Escape. Native desktop and live remote-provider
acceptance remain integration checks.
