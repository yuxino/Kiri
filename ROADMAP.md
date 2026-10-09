# kiri roadmap

kiri grows from a reliable still-capture tool into a local visual capture
workspace. Dates are intentionally omitted until each milestone is stable.

## v1.3 — Tauri multi-platform rewrite

The macOS + Windows rewrite in Tauri 2. The current runtime structure lives in
`docs/architecture.md`; completed migration plans remain available in Git
history.

- [x] Tauri 2 + Rust + React project skeleton
- [x] Platform-independent core (geometry, recording policy, shortcut, library)
- [x] Frozen-display capture (macOS ScreenCaptureKit, Windows xcap/WGC)
- [x] Exclusive global shortcut (⇧⌘A / Shift+Ctrl+A)
- [x] Overlay: mode selector, window hover outline, region drag, 8 handles
- [x] Annotation canvas: pen, rectangle, line, arrow, text, mosaic
- [x] Annotation history (undo/redo), inline text editing, live sizing
- [x] Local library with search, favorites, and recoverable trash
- [x] Direct-open library cards with rubber-band-only batch selection
- [x] Clipboard-first screenshot completion with focus restoration
- [x] Local OCR (macOS Vision, Windows.Media.Ocr)
- [x] Region recording (SCK / WGC) with native H.264 + AAC pipelines
- [x] Optional system audio, pointer, and click highlights
- [x] Neutral, non-dimming 3-2-1 countdown and multi-segment recording pipeline
- [x] GIF export for any positive known duration (12 fps, 720 px long edge)
- [x] Seven UI languages, following the OS language or a persisted Settings choice

## v1.4 — Secure remote OCR and release reliability

- [x] Local OCR remains the default and requires no account or network
- [x] Multiple optional Alibaba Cloud, OpenAI, and image-capable OpenAI Chat Completions-compatible profiles
- [x] Per-selection confirmation showing destination, model, and image details
- [x] Explicit Send/Retry only, with no automatic retry, provider switch, or fallback upload
- [x] API keys stored in macOS Keychain or Windows Credential Manager
- [x] Settings view for language and OCR profile management
- [x] Escape cancellation remains reliable when an overlay control has focus
- [x] Correct selection dimming without stacked capture masks
- [x] Stable macOS development identity for persistent privacy permissions
- [x] One transparent desktop icon source with dev, production, and CI validation
- [x] Release jobs verify release tools and app icons before packaging
- [x] Release CI verifies tags and produces Windows drafts without an intentional macOS policy failure
- [x] One maintainer-signed Universal macOS DMG supports both Apple silicon and Intel
- [x] Native macOS and Windows media pipelines require no downloaded encoder
- [x] Signed, user-initiated in-app updates with real progress and no background checks
- [x] Interactive screenshot and recording completion preview with open, copy, recoverable Trash, and Undo actions
- [x] Re-editable local screenshot annotations with completion-card and library editor entry points
- [x] Shared last-used annotation styling across capture and editor windows
- [x] Destructive screenshot cropping with editable-mark translation and export-only Save As
- [x] Explicit MP4/GIF recording output choice; direct GIF is silent and preserves the MP4 when GIF finalization fails
- [x] One managed library that can move to another local directory or external disk
- [x] Offline-library, missing-asset, and interrupted recording-import recovery

Release validation still open:

- [ ] macOS packaged-app acceptance (capture, permissions, focus, and recording export)
- [ ] Windows acceptance testing (capture, recording, audio, OCR, ripple)
- [ ] Pause/resume and exported-control exclusion acceptance on both platforms
- [ ] Mixed-scale multi-display acceptance testing
- [ ] The maintainer-packaged Universal macOS DMG retains one stable local signing identity and passes manual Gatekeeper install/launch acceptance
- [ ] Verify each release's final arm64 and x86_64 slices plus the Windows installer

## v1.6 — Linux capture workspace

Kiri supports Ubuntu 24.04 / GNOME, with X11 compatibility.
See [Linux setup and acceptance](docs/linux.md) for installation and verification details.

- [x] X11 frozen capture and window bounds through `xcap`
- [x] Single-display Wayland capture (`grim` where supported; Screenshot portal on GNOME)
- [x] Configurable native X11 capture shortcut and explicit Wayland desktop shortcut commands
- [x] Opt-in GlobalShortcuts Portal backend with truthful current-binding state
- [ ] Installed supported-desktop Portal shortcut acceptance (#47)
- [x] Region recording via ScreenCast/PipeWire and system GStreamer, with optional MP4 audio and silent GIF output
- [x] Recording controls through the tray and commands, without a captured floating panel
- [x] Offline Tesseract OCR using system English, Simplified Chinese, and Japanese data
- [x] Secret Service credentials for remote OCR profiles
- [x] `.deb` configuration and Ubuntu build, install, and isolated X11 CI workflow
- [x] Verified Linux CI candidate: Rust/media checks, `.deb` installation, and X11 capture, clipboard, OCR, recording, and persistence ([Ubuntu/X11 evidence](https://github.com/yuxino/kiri/actions/runs/36295511436/job/108553499500))
- [ ] Installed Ubuntu GNOME Wayland acceptance, including portal cancel/retry, clipboard, OCR, and recording
- [ ] Installed Ubuntu X11 acceptance beyond the virtual CI desktop
- [ ] Wayland multiple displays and fractional-scale acceptance
- [ ] Window hover outlines on Wayland where the compositor exposes bounds
- [x] Linux system audio, microphone, mixed AAC recording and explicit microphone-check backend
- [ ] Installed Ubuntu/GNOME real-device audio acceptance (#73)
- [ ] Linux click-highlight parity
- [x] Linux normal-speed cuts/reordering and source-audio-preserving MP4 export backend
- [ ] Installed Ubuntu/GNOME basic-video-editing acceptance (#74)
- [ ] Linux advanced video effects, annotations and speed editing
- [ ] AppImage packaging and desktop acceptance
- [ ] Signed Linux updater artifacts

## Later

- [ ] Blur annotation
- [ ] Full-display recording
- [x] Thumbnail video timeline with draggable clip edges, split/delete, undo/redo, and non-destructive library copies
- [x] Timed zoom regions and opaque privacy masks in preview and native MP4 export
- [x] Native MP4 export size presets and explicit five-second microphone checks
- [x] Local video projects with autosave, reopen-to-resume, and protected close
- [x] Native video export progress and cancellation before final library saving
- [ ] Multiple video and image sources in one editable timeline
- [ ] Inline video and GIF playback
- [ ] Recording duration and file-size safeguards
- [ ] Smart collections
- [ ] Adopt an existing managed library after local settings are reset
- [ ] Flatpak packaging for Linux
