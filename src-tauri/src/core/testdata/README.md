`scroll-text.png` is a nonprivate test document rendered with CoreText at native
pixels. It contains original Chinese and English numbered paragraphs, repeated
body text, distinct numeric markers, and 240-pixel white gaps. Its grayscale
encoding was checked to decode to the same RGBA pixels as the original render.
Tests add fixed headers, composers, and translucent gradients to viewport crops;
the production application does not load this fixture or simulate capture.

`scroll-webkit-7701.png` and `scroll-webkit-8094.png` are lossless 1800×1394
ScreenCaptureKit frames of the independent generated page in
`scripts/qa/scroll-chat-fixture-macos.swift`. They were saved through normal Kiri
scrolling capture, at page offsets 7701 and 8094 CSS pixels on a 2× display:
the known native displacement is 786 pixels. Both contain only generated test
content and the page's fixed header/composer. They reproduce a large first
movement followed by a return, but do not represent every frame of a live
scrolling session or establish general native/cross-platform acceptance.

`scroll-notepad-dark.png` is a lossless 754×645 crop of numbered text generated
only for Windows cloud QA in Notepad. It contains no private capture content.
The regression inserts one or two stale top rows into a viewport crop, then
checks recovery from independent clean observations, including a return to the
original position. This models a transient repaint; it is not a saved sequence
of frames from the native capture backend and does not establish native
acceptance by itself.
