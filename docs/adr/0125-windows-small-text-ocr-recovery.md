# ADR 0125: Bounded recovery for small Windows OCR crops

Status: accepted implementation; native Windows acceptance pending.

## Context

[Issue #193](https://github.com/yuxino/Kiri/issues/193) shows readable Chinese
text in a 295 × 35 selection and a successful empty local OCR result on Windows.
The report does not include the original crop, Windows OCR language, or display
scale, so small input size is a plausible cause rather than a proven diagnosis.
The crop code already commits the final selection and respects backing scale.

Windows previously passed the crop to `Windows.Media.Ocr` unchanged. Its existing
command-level retry handles native errors only; successful empty results do not
reach that retry. Repeating the same empty input without a transformation would
not address this boundary.

## Decision

Keep the original first pass. Preserve any nonempty result exactly. If it is
empty and either image edge is at most 128 pixels, make one local recovery attempt
using the same installed OCR engine:

- Enlarge uniformly by an integer factor of two or three with Lanczos filtering.
- Add a 16-pixel margin matching the most common source corner color.
- Reserve that margin inside the runtime `OcrEngine.MaxImageDimension` limit;
  skip recovery if there is insufficient room for at least twofold enlargement.

The small-edge and scale limits bound extra pixels. A second empty result remains
a normal empty success. Native failures remain errors and retain the existing
command-level failure retry. No language/provider switching or network fallback
is added. Both overlay and saved-image local OCR use this implementation.
The recovery bitmap is temporary; saved history retains the original PNG.
macOS Vision and Linux Tesseract are unchanged.

The 128-pixel threshold and enlargement factors are conservative recovery policy,
not a claimed documented minimum text size for Windows OCR.

## Verification

Portable tests cover first-pass preservation, one transformed attempt, blank
pixels, source immutability, native errors, both strip orientations and the native
size limit. Windows-only tests reuse the generated local OCR fixture at 295 × 35
and check an empty narrow image with the actual Windows engine. They run in the
existing Windows Rust test job and require an installed user-profile OCR language
pack. These tests do not establish Chinese recognition quality.

Before claiming #193 resolved on Windows, run the native tests and compare the
same failing selection in the installed app at the reporter's display scale and
OCR language. Check a Chinese single line, a blank area and an ordinary multiline
selection through overlay and saved-image recognition. Confirm the original
history image dimensions. The available report screenshot is not the original
crop and cannot substitute for this comparison.
