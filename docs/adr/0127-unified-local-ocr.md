# ADR 0127. One default local OCR model on desktop

Kiri ships Baidu PP-OCRv6 small for local recognition on macOS, Windows and
Linux. A screen selection and a saved screenshot use the same detector,
recognizer and dictionary, independently of the interface language. Ordinary
full-image requests use this path too. Recovery stays on the device. The
existing explicit consent still applies to every remote request.

The bundled dictionary covers Chinese and Japanese but omits several other
scripts. On macOS and Windows, a system recognition language associated with
one of those scripts can prompt a local compatibility pass. Kiri keeps the
native result when it contains corroborating letters from that script. This
hint does not identify every language in arbitrary images.

Windows previously selected the model only for small Chinese regions.
Testing against the public image in [issue #193](https://github.com/yuxino/Kiri/issues/193)
showed that the model could recover labels missed by the system recognizer.
Nearby selections can still lose a character, and toolbar icons can produce
extra text. Both the triggering crop and ordinary images should be tested when
changing the bundled model. See [the initial comparison](0126-offline-chinese-ocr.md).
