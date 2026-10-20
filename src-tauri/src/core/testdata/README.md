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
