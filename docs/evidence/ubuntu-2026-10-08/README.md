# Kiri Ubuntu acceptance evidence

Date: 2026-10-08 (Asia/Shanghai). Kiri 1.6.11, source `7341f7195642f4befeecf3f4a6b99739d945cadb`. Ubuntu 24.04.4 / GNOME 46 / X11; PulseAudio `fifo_output` / `fifo_output.monitor`.

The official .deb was hash-checked, installed and launched. A public 51.9-second Sintel trailer imported, played and sought correctly. A 20–24 second range exported as a separate MP4, reopened and played for 4.0 seconds. GStreamer reported H.264 High, 854×480 at 24 fps, with stereo AAC at 48 kHz. The four-second MP4 converted to a 720×404 GIF (6,658,390 bytes), and two distinct native preview frames were observed. Full GIF timing and audio/video synchronization were not audited.

X11 region screenshot, rectangle annotation, save/reopen, saved-image local OCR and screen OCR passed on a short public English/Chinese/Japanese fixture. The saved screenshot has the intended pixels and annotation; an initially blank-looking selection frame was a remote-frame delay, not a confirmed capture defect. English→Simplified Chinese UI switching passed. OCR is a short functional sample, not an accuracy benchmark.

## Recording failure and control

With system audio ON and microphone OFF, two recording attempts failed immediately with `AudioRecordingStopped`, at 03:49:29Z and 03:58:15Z. Neither produced a new MP4. The second attempt did not use pause. A system-audio-OFF / microphone-OFF control saved a 6.065-second H.264 Constrained Baseline MP4, 1020×310 at 30 fps; native playback showed the moving counter. This isolates the observed failure to the audio-enabled path in this cloud setup; the root cause and behavior on other Linux audio devices are unproven. Pause/resume was not verified because the first recording had failed before the pause command.

## Cleanup and limits

Kiri quit normally. Exact process-name checks found neither Kiri nor Mimi running. Seven owned QA assets and seven indexed entries, plus their known annotation/video project files, were removed after matching the complete file set. Settings and the library marker were preserved; QA downloads were removed. After the user explicitly requested release, Ubuntu was released through the official console and identity verification. The refreshed resource list now shows no cloud desktops (“共有0条”); the final snapshot and screenshot were preserved. Windows had already been released. These desktops no longer accrue compute or system-disk charges. A new browser-control hard stop occurred while inspecting the remote page, so browser page/task-space closure remains unconfirmed. See the [release record](release-2026-10-08.json).

Wayland, physical Linux devices, Japanese UI and AppImage runtime remain untested. No new issue or product-code change is created. This evidence-only branch stays separate from product main. [Earlier observations](observations.json) are historical; use [current observations](serial-resume-2026-10-08.json).

Screenshots are real native captures or lossless crops, with no generated or retouched pixels. Public images exclude private accounts, cloud resource identifiers and paths. No OCR text log, audio/recording file or installation package is published.

- [Screenshot manifest](screenshot-manifest.json)

| Screenshot | Pixels | SHA-256 |
| --- | --- | --- |
| [gnome-desktop.png](screenshots/gnome-desktop.png) | 1500×768 | `14f8dfaa7f904beb71c9ee7b52e1677fe980c77d2c7c8533bd9a2b0cb2e7bc25` |
| [kiri-audio-recording-errors.png](screenshots/kiri-audio-recording-errors.png) | 685×106 | `4e03e1150d8d96f0672a6c4e9458241cf8465c5ef459f18ca84562591593b7d3` |
| [kiri-four-second-mp4-exported.png](screenshots/kiri-four-second-mp4-exported.png) | 570×380 | `bf7f244993deadd933dbd04db402c779830663120cb6d077d757211ec06049ad` |
| [kiri-four-second-mp4-playback.png](screenshots/kiri-four-second-mp4-playback.png) | 570×340 | `85e73a8a94123b02e227c14dceb340e6ea1cc4ff5c4367c7cf87a155241893c4` |
| [kiri-gif-preview-first.png](screenshots/kiri-gif-preview-first.png) | 570×340 | `6f1a87b9f0ef576ea7b97fca5c322f80de104953857d463a30d5dcaa0f788709` |
| [kiri-gif-preview-second.png](screenshots/kiri-gif-preview-second.png) | 570×340 | `5824ea0321757587b22e0a61e0d8e76468f467121d8fb9c91d4fcbff0c28ec30` |
| [kiri-library-with-screenshot.png](screenshots/kiri-library-with-screenshot.png) | 481×340 | `54cfd5f29d1bbd9e279239eef0825ce7c3bcf8b87f403d97df54a92450cca1e4` |
| [kiri-local-ocr-result.png](screenshots/kiri-local-ocr-result.png) | 441×330 | `291b9b6a0de35f3fd2c55f86668bd33a4502d03bb5791d2ed96db03883f39048` |
| [kiri-native-home.png](screenshots/kiri-native-home.png) | 481×340 | `ffa570a450df0a86817d4207b94c83f43d64656bb4a941147613c61bcf091e2c` |
| [kiri-screen-ocr-result.png](screenshots/kiri-screen-ocr-result.png) | 550×420 | `4f91b2358a0a9fd1ab5f980c7e6efd8d2d2d49f2ccea799a254791342ad111ca` |
| [kiri-screenshot-editor.png](screenshots/kiri-screenshot-editor.png) | 441×330 | `e31aa16f04a1adf6418ca2603cc33959a4c720dd6bb1b5d5e5063cd7e318c778` |
| [kiri-settings-zh.png](screenshots/kiri-settings-zh.png) | 481×340 | `6ac35864d09269a7e91e372583e3c5a3d9c76ba7f9b5462b79d4e7371c1d7cee` |
| [kiri-silent-record-metadata.png](screenshots/kiri-silent-record-metadata.png) | 650×88 | `758596b431757428ee3e73a1d43da61fa5afc034ddaa282bc043783db9e2ba81` |
| [kiri-silent-record-playback.png](screenshots/kiri-silent-record-playback.png) | 601×340 | `4a57f3e6af4352b418af622eebfc9865611488c3c795c9f1a1e228cde3fa0579` |
| [kiri-sintel-playback-seek.png](screenshots/kiri-sintel-playback-seek.png) | 570×340 | `311b5d5ac5ae25972bd1646848894a5b4cda445ce398bf2cbf19d05b2167f4f9` |
| [kiri-system-audio-mic-off-options.png](screenshots/kiri-system-audio-mic-off-options.png) | 550×410 | `8b4a26d601c7f93ae5ee753b587d363b7a063a089f5fe9dcb9ef6c0208e3948d` |
| [kiri-trim-four-seconds.png](screenshots/kiri-trim-four-seconds.png) | 570×380 | `a0a3d5261b079f44532c19886853dab644c725f9fd3ca937cbc8a7d1ca502c25` |
| [ubuntu-installed-packages-crop.png](screenshots/ubuntu-installed-packages-crop.png) | 680×420 | `35a588fce70a47281b8c4729fe0078111c55ed05075adf3517c0138cc8b8149e` |
| [ubuntu-released-empty-list.png](screenshots/ubuntu-released-empty-list.png) | 1202×303 | `ef635602961ab5e96fca42fedeeb3c2cae371c352ece20150991d93106fb9f31` |
