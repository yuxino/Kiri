# Kiri repository guide for agents

This file is the first source of truth for agents working in this repository.
Read it before editing, then read `docs/architecture.md`.

## Start here

1. Run `git status -sb` before making changes.
2. Read `README.md`, `ROADMAP.md`, and `docs/architecture.md`.
3. For capture-selection behavior, also read
   `docs/adr/0003-manual-region-selection.md`.
4. Treat every pre-existing modification and untracked file as user-owned.
   Never reset, discard, overwrite, or reformat unrelated work.
5. Completed implementation plans and the former Swift migration specs live in
   Git history, not the working tree. Do not reconstruct an old parallel
   project from them; current source, tests, this file, and accepted ADRs win.

## Product contract

Kiri is a local-first capture utility for macOS, Windows, and
Linux. Preserve these decisions:

- The default global capture shortcut is `⇧⌘A` on macOS and `Shift+Ctrl+A` on
  Windows and Linux X11. These use native global-hotkey registration; the shortcut does
  not require Input Monitoring permission. Settings may replace the binding
  with a modified letter or digit and restore this default (ADR 0046).
  On Wayland, the user configures `kiri --capture` in desktop settings, or opts
  in to GlobalShortcuts Portal setup where the actual interface is available.
  Preserve command guidance and truthful session/binding state (ADR 0075). Never
  install compositor bindings or FIFOs automatically (ADR 0051).
- The initial overlay offers Screenshot, Record, and OCR. The screenshot toolbar
  and saved-image editor offer Recognize QR Codes. QR recognition
  stays local; multiple codes keep their clickable image positions. Copy, open,
  and save are explicit actions after viewing content (ADR 0061).
- Window hover shows exactly one restrained monochrome outline without handles,
  dimensions, or stacked borders. Screenshot mode also offers a monochrome
  pixel/color loupe on idle hover (ADR 0082); dragging and annotation hide it.
  A click selects that
  window; a drag creates a custom region. Both selections remain movable and
  resizable with eight handles. Linux X11 supplies window bounds; Wayland uses
  region drag and currently rejects multiple connected displays before capture.
- Screenshot completion is clipboard-first and returns focus to the original
  application. Do not open the Kiri library after every capture.
- Escape cancels capture and countdown; Return confirms a screenshot.
- Annotation tools appear immediately after region selection. Existing text
  and shapes remain selectable and editable; size controls update live.
- Text backgrounds default to transparent. Mosaic is a continuous brush with
  adjustable diameter and intensity.
- Recording is Retina/DPI-scale, high-quality MP4. Kiri's recording controls
  and paused time must not appear in the exported video.
  Linux MP4 recording can include system audio and microphone through the local
  PulseAudio/PipeWire audio service and hides the floating control panel; use tray
  actions or `kiri --toggle-recording-pause` / `kiri --stop-recording`. ScreenCast
  consent must select the same display as the frozen screenshot.
- The optional high-contrast red click ripple is visible live and is also captured.
- The 3-2-1 countdown is centered and compact; it must not dim the selected
  recording region.
- User-facing UI supports English, Simplified Chinese, Traditional Chinese,
  Japanese, German, Korean, and French. It follows the OS preferred language
  until the user chooses a language in Settings; that choice persists and
  applies to every open window.
- Captures stay local. Never add uploads, analytics, accounts, or network
  behavior without an explicit product decision and privacy documentation.
  Recording, merging, thumbnails, and GIF conversion use platform media APIs
  and must not download or launch a third-party media executable. On Linux that
  means system GStreamer plugins, not a downloaded FFmpeg binary.
- macOS and installed Windows application updates are manual and signed. Check, download, install, and the
  macOS relaunch are separate user actions; Windows explicitly offers Install
  and Restart, then exits into its passive NSIS installer and reopens afterward.
  GitHub Releases is an error-recovery link, not the normal updater.
  Linux uses replacement `.deb` packages downloaded and installed by the user;
  it does not expose the signed in-app updater. Ubuntu 24.04 / GNOME is the
  initial Linux target, with X11 compatibility. Do not claim AppImage delivery.
- Linux local OCR uses system Tesseract with `eng`, `chi_sim`, and `jpn` data.
  Linux videos support playback, GIF conversion, normal-speed cuts/reordering and
  MP4 export with source audio. Independently gated speed, effects, masks,
  annotations and stickers remain unavailable; never silently drop saved content.

## Repository map

- `src/` — React frontend: capture overlay, annotation canvas, library,
  editor, countdown/control/ripple windows, i18n (en/zh-Hans/zh-Hant/ja/de/ko/fr), design tokens.
- `src-tauri/src/core/` — platform-independent models: geometry, recording
  policy, shortcut model, asset library (byte-compatible with the Swift
  version's `library.json`).
- `src-tauri/src/capture/` — per-platform capture backends (macOS:
  ScreenCaptureKit via objc2; Windows: xcap WGC + windows-capture + cpal;
  Linux: X11 `xcap`, Wayland `grim` or xdg-desktop-portal Screenshot;
  ScreenCast + PipeWire for recording).
- `src-tauri/src/platform/` — per-platform helpers: global shortcut, focus
  restoration, file reveal, click monitoring, capture exclusion.
- `src-tauri/src/record.rs` — platform-native encoding coordination (H.264 +
  AAC → MP4); macOS bridging lives in `src-tauri/src/macos_media.{rs,m}`;
  Linux bridging lives in `src-tauri/src/linux_media.rs`.
- `src-tauri/src/commands.rs` — the AppModel-equivalent command surface.
- `src-tauri/src/{ocr,gif,thumbnail,protocol,state}.rs` — OCR, GIF export,
  thumbnails, `kiri://` protocol, shared state.
- `scripts/` — packaging, stable development signing, and app-icon validation.
- `docs/architecture.md` — current runtime structure and platform boundaries.
- `docs/README.md` — index of current documentation and accepted decisions.
- `docs/adr/` — accepted architecture/product decisions.

## Architecture boundaries

- `AppState` (state.rs) coordinates capture, library operations, recording
  state, and transient feedback. Synchronous Tauri commands run on the main
  thread (mirroring the Swift @MainActor design); heavy work spawns
  background threads.
- `capture::macos` runs the SCK stream on a dedicated thread; control flows
  through channels. `SCShareableContent` is main-thread-only — resolve it on
  the main thread.
- The recording pipeline is: platform capture (BGRA frames + PCM audio) →
  AVFoundation on macOS or Media Foundation on Windows → H.264/AAC MP4.
  Linux uses portal ScreenCast/PipeWire and system GStreamer for H.264 MP4,
  with optional PulseAudio monitor/input capture mixed into AAC on the same clock.
  macOS pause/resume segments are merged with AVFoundation.
- `AssetLibrary` is the persistence boundary. It shares the Swift version's
  storage layout (`~/Library/Application Support/kiri` on macOS,
  `%APPDATA%\kiri` on Windows, `$XDG_DATA_HOME/kiri` or `~/.local/share/kiri` on
  Linux) so existing libraries keep working. Preserve
  recoverable Trash and never manipulate a user's library directly during QA.
- Frontend windows render by `?window=` query param; the frozen capture is
  served through the `kiri://` protocol from memory.

## Required verification

Run the smallest relevant check while editing, then all of the following
before handoff:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm build
git diff --check
```

`src-tauri/target` is disposable Cargo build cache, not application or user
data. Keep it after builds by default so later verification does not require a
full multi-gigabyte rebuild. Remove it only when the user explicitly requests
cleanup or disk pressure makes cleanup necessary. Never remove the shared
Cargo registry as part of repository cleanup.

Do not add a runtime synthetic-capture mode to the user-facing application.
Capture QA must use unit-level injected data or an isolated test harness, never
replace the visible desktop with a mock screen inside normal dev or prod Kiri.

For changes to capture, recording, permissions, focus, keyboard handling, or
overlay windows, also package and test the fixed-path app:

```bash
./scripts/install-app.sh
open /Applications/Kiri.app
```

Use a stable signing identity (`KIRI_SIGNING_IDENTITY`). Do not silently use
ad-hoc signing because it changes the privacy identity and can invalidate
Screen Recording/Input Monitoring permissions. Windows builds are verified
through GitHub Actions (`.github/workflows/build.yml`).

Linux changes also require the Ubuntu job's `.deb` build/install and isolated
X11 desktop check (`bash scripts/qa/linux-native.sh /usr/bin/kiri`). Its
temporary HOME/XDG directories contain only test assets. The Xvfb result does
not establish GNOME Wayland portal, hardware, or mixed-scale acceptance; use
the separate checklist in `docs/linux.md` and report those limits explicitly.

## UI acceptance checklist

- Verify Screenshot, Record, and OCR from the initial overlay, and QR recognition
  from the screenshot toolbar and saved-image editor.
- Verify the single-outline window hover and click selection, plus manual
  region drag, move, and all eight resize handles.
- Verify Escape and Return behavior and original-app focus restoration.
- Verify the toolbar at narrow regions and near every display edge.
- Verify text creation, IME input, second edit, live font sizing, and
  background styles.
- Verify mosaic brush diameter/intensity and editing of existing annotations.
- For recording, inspect extracted frames around start, click ripple,
  pause/resume, and stop. Confirm clarity and absence of all Kiri controls.
- Avoid leaving QA captures in the user's library. Move only agent-created
  test assets to Kiri Trash, which is recoverable; never empty Trash without
  consent.

## Localization and documentation

- All user-facing strings go through `t()`/`fmt()` in `src/i18n`; the English
  string is the key (matching the Swift L10n behavior).
- Keep all seven dictionaries identical in key set and formatting placeholders.
- Update `README.md` and `README_ZH.md` together for user-visible behavior.
- Record durable interaction changes as a new ADR instead of rewriting old
  history without explanation.

## Git and release safety

- Current work may be intentionally dirty. Do not create a new branch, commit,
  merge, push, tag, or publish a release unless the user asks.
- When asked to commit, inspect the exact diff and keep unrelated user work
  out of the commit when possible.
- Do not delete capture data, reset privacy permissions, or replace signing
  identities as a troubleshooting shortcut.
- Never include private captures, credentials, personal absolute paths, or the
  contents of `~/Library/Application Support/kiri/` in commits.

## Release language

- Write public release notes in English first, followed by Simplified Chinese, using `## English` and `## 中文` sections. Translate the same changes, installation/update requirements, and verification limits; keep links, filenames, version numbers, and checksums exact.
- Keep release titles concise: product and version, with any descriptive subtitle in English and Chinese. Do not publish Chinese-only or English-only release descriptions.
- Use the same reviewed bilingual notes for GitHub Releases and updater metadata. Check generated release text before publishing; autogenerated commit lists alone are not bilingual release notes.
- Credit contributors for work first shipped in that release with plain `@username` mentions, then verify GitHub's native Contributors avatars on the public release page. Do not repeat historical credit on later releases merely because they bundle the same existing work.
