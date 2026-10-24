# Linux OCR package compatibility — Issue #187

## Candidate

The 2026-10-24 candidate uses the system Tesseract command instead of linking
Kiri directly to Tesseract and Leptonica. See [ADR 0118](../adr/0118-system-command-linux-ocr.md).

- Application source: `f801e7b3675c7bf9319ab3b0aeaaec69df61b229`.
- Package: `kiri_1.6.29_amd64.deb`, from the
  [successful Ubuntu package build](https://github.com/yuxino/Kiri/actions/runs/40066734636).
- Debian package SHA-256:
  `03cea41d813cb1a0623581523c4fdcfa9591bcae4789896856af28b7a324a3d7`.
- Build artifact: [`kiri-linux-deb`, ID `12550206368`](https://github.com/yuxino/Kiri/actions/runs/40066734636/artifacts/12550206368), including `provenance.json`.

This is an unreleased candidate with the existing 1.6.29 version number.
The published v1.6.29 package has not been replaced. Both desktop checks reuse
this exact package; later harness changes do not rebuild the application.
The source verifier rejects changes to application code, Cargo dependencies
or package configuration.

## Automated acceptance

| Check | Result and evidence |
| --- | --- |
| Ubuntu 24.04 build, native tests, package installation and linked libraries | [Passed](https://github.com/yuxino/Kiri/actions/runs/40066734636) |
| Installed Ubuntu X11 app, including OCR and FIFO system-audio regression | [Passed](https://github.com/yuxino/Kiri/actions/runs/40068328375) |
| Same package on Kali rolling with Leptonica 6 | [Passed](https://github.com/yuxino/Kiri/actions/runs/40069197761) |

The installed package depends on `tesseract-ocr` and the existing English,
Simplified Chinese and Japanese models. ELF inspection finds no direct
Tesseract or Leptonica dependency in Kiri, and `ldd` finds no missing libraries.

Ubuntu's real X11 capture recognizes `SCREEN CAPTURE 123`, copies that text,
and saves its source in Text History. The same run verifies screenshot pixels,
native shortcuts, cancellation, recording pause/resume, video playback,
pinning and recoverable Trash; its normal and FIFO reports both succeed.

The focused Kali check uses the same public desktop fixture, OCR shortcut,
region drag, recognition, Copy and Text History. It requires Leptonica 6
without `liblept.so.5`, checks package identity and records the installed
versions, container digest, linked libraries, screenshots and result report.
The successful run uses Tesseract `5.5.0-1.1` and Leptonica `1.86.0-1+b1`,
recognizes `SCREEN CAPTURE 123`, and records both startup and OCR checks as
successful. Its harness source is `7f8cc79752fa30d37a2cd2c3443946ba6a8eea13`.
The official Kali rolling image digest is
`sha256:4be87f78671419c13dcf4f207ead1cfc0de178ea281b3f69c0f49b69ba4e79b1`.

## Limits and reporter retest

The desktops are Xvfb/Openbox at 1280×800, scale 1, with software painting and
WebKit compositing disabled for QA. Kali additionally disables WebKit's
namespace sandbox only inside its disposable Docker container. These runs
do not establish the reporter's VMware desktop behavior, GNOME Wayland,
physical-device recording/audio, multiple displays or fractional scaling.
The recognized fixture is English; installed models and selection policy do
not establish Chinese/Japanese recognition quality.

Download and extract the candidate artifact for a VMware/Kali retest. Quit
Kiri before replacing the installed package. Since its version matches the
old release, explicitly reinstall the local candidate:

```bash
sudo apt install --reinstall ./kiri_1.6.29_amd64.deb
kiri
```

Verify startup, OCR on an ordinary selected region, Copy and Text History.
Do not alias different Leptonica ABI versions with symbolic links. Issue #187
remains open for the reporter's environment; these checks do not publish a release.
