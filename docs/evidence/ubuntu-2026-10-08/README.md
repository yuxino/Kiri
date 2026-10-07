# Kiri Ubuntu acceptance evidence — in progress

Date: 2026-10-08 (Asia/Shanghai).

This evidence-only branch intentionally stays separate from product main. It contains real screenshots and sanitized observations, with no runner, credentials, transcript, audio recording, installation package or product-code change.

Kiri 1.6.11 was downloaded, hash-checked and installed in Ubuntu. It was not launched. The installation screenshot and GNOME desktop screenshot are environment evidence, not Kiri capture/OCR/recording acceptance.

Desktop work is paused at a browser microphone permission prompt. The human must deny it for this system-audio-only task and explicitly return control. The prompt origin is unproven. It is not classified as an application defect.

The cloud desktop was last observed running. For Mimi, test-credential cleanup and stopping/releasing the desktop remain pending; no cleanup or final shutdown is claimed.

- [Sanitized observations](observations.json)
- [Screenshot manifest](screenshot-manifest.json)

| Screenshot | Pixels | SHA-256 |
| --- | --- | --- |
| [gnome-desktop.png](screenshots/gnome-desktop.png) | 1500×768 | `14f8dfaa7f904beb71c9ee7b52e1677fe980c77d2c7c8533bd9a2b0cb2e7bc25` |
| [ubuntu-installed-packages-crop.png](screenshots/ubuntu-installed-packages-crop.png) | 680×420 | `35a588fce70a47281b8c4729fe0078111c55ed05075adf3517c0138cc8b8149e` |

Screenshots are real captures. The installation image is a lossless pixel crop of the existing terminal screenshot; its title and account-bearing prompt are excluded. Application screenshots were clipped at capture time. Nothing is AI-generated or retouched. No Kiri feature screenshot exists because Kiri had not been opened before the shared desktop was paused.
