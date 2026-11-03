# ADR 0126. Offline recognition of small Chinese selections

## Problem

On the dark Chinese toolbar in [issue #193](https://github.com/yuxino/Kiri/issues/193#issuecomment-6594628698),
Windows.Media.Ocr returned some text but recovered only two of eight labels
at the original size. The empty-result recovery in ADR 0125 never ran in this
case. Enlarging the same crop was also insufficient.

## Recognition

On Windows, a Chinese system OCR language selects PP-OCRv6 small first for
small blocks and narrow strips. The shorter side must be at most 128 source
pixels, or at most 256 with an aspect ratio of at least 3:1. The longer side
must fit within 4096 pixels. The larger strip limit accommodates higher display
scales. When Windows cannot create its recognizer, qualifying crops can still
use the model. Other installed recognition languages retain their system path.
Screen OCR and saved-screenshot OCR share the same decision.

The helper runs locally with the bundled detection and recognition weights.
Kiri bounds its time and result size, reads text in row order, and falls back
to the available system recognizer after an error or empty model result.
Single-character results are valid, including labels next to toolbar icons.
The original crop is saved with history.

The Windows build pins the archive, executable, model weights and character
dictionary by SHA-256. The NSIS installer and portable ZIP include the same
files and attribution. The app opens all three model files with read-only sharing
before starting the helper and holds them until it exits. A missing file
returns control to the system recognizer. The
build requires network access once. Recognizing text never downloads a model
or sends pixels to Baidu. [PP-OCRv6](https://github.com/PaddlePaddle/PaddleOCR/tree/main/docs/version3.x/algorithm/PP-OCRv6) · [Pinned helper](https://github.com/zibo-chen/newbee-ocr-cli/tree/v0.2.3).

## Result panel

Recognition starts when the user finishes selecting a region. The result
panel puts selectable text above the history status and copy action. The user
can select another area on the same frozen screen after success, empty input,
or failure. A clipboard error leaves the result available for another attempt.
Remote profiles still require explicit consent for every request.

## Verification boundary

In the initial Windows trial, PP-OCRv6 tiny recovered all eight toolbar
labels on a fixed crop, but only seven and six on two hand-drawn selections
in Kiri. It also misread several icons as characters. The app offered another
selection after an empty result and copied text from both nonempty results.

On those exact two saved crops, the small MNN model recovered all eight labels
in both cases on macOS CPU. Comparing the same crop bytes distinguishes model
accuracy from changes in geometry. Toolbar icons can still produce spurious
letters. An issue screenshot cannot establish performance on the reporter's
original display.
