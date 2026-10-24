# 0118 — System-command Linux OCR

Status: accepted. The packaged Ubuntu/X11 and Kali rolling container checks
passed; the reporter's VMware desktop retest remains open.

## Context

[Issue #187](https://github.com/yuxino/Kiri/issues/187) reports a Kiri binary
requiring `liblept.so.5` failing to start on Kali with `libleptonica.so.6`.
The previous Rust Tesseract binding directly used Leptonica to decode PNGs.
Its linked library ABI came from the Ubuntu build host, making OCR libraries
a startup requirement even when the user did not invoke OCR. Changing package
dependency names or aliasing different library ABIs cannot fix that binary.

## Decision

Use the distribution's `/usr/bin/tesseract` executable directly, without a
shell, PATH lookup, downloads, or network requests. Remove the Rust Tesseract
binding and declare `tesseract-ocr` plus the existing language data as package
dependencies. The distribution supplies the executable's matching libraries.

Preserve the configured `TESSDATA_PREFIX` directory, the installed supported
`eng`, `chi_sim`, and `jpn` model selection, sparse-text segmentation (`--psm
11`), line trimming, and successful empty results. Pass the model directory
as one native argument. An explicit model directory never silently falls back.

Send PNG bytes through stdin and read UTF-8 text from stdout concurrently.
Do not write intermediate screenshots or text files. Discard native stderr,
which can contain paths or recognized content. Limit output to 1 MiB, and
stop and reap the child after 60 seconds or a pipe failure. Nonzero exit,
invalid text, oversized output, and incomplete input fail without returning
partial recognition. Keep the existing background-worker and localized
failure/retry paths.

## Consequences and acceptance

Missing or incompatible OCR libraries no longer prevent the Kiri executable
from loading. OCR still requires a working system command and supported
installed models. macOS Vision and Windows.Media.Ocr remain unchanged.

Test concurrent large input/output, timeout and process reaping, early exit,
missing executable, invalid/oversized text, model selection, and empty results.
Retain the real Linux PNG recognition test. Package CI rejects direct ELF
dependencies on Tesseract or Leptonica and retains its installed X11 OCR test.

The Ubuntu package build/install and X11 checks must pass for the candidate.
Kali additionally needs installation, linked-library inspection, startup and
local OCR checks with Leptonica 6. This removes the reported OCR ABI coupling;
it does not establish support for every Kali desktop, capture backend, or
hardware configuration.

See the [candidate acceptance record](../qa/linux-ocr-compat.md) for the exact
package checksum, source revisions, successful runs and remaining limits.
