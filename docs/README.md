# Kiri documentation

This directory contains only documentation that describes the current Tauri
application or a durable product decision.

## User guides

- [Setup and help](usage.md) · [使用与常见问题](usage.zh-CN.md) — installation, updates, permissions, and capture controls.
- [Video editing](video-editing.md) · [视频剪辑](video-editing.zh-CN.md) — import, trim, annotate, save, and export a local video.
- [Linux basic video export acceptance](qa/linux-video-export.md) — exact-package checklist for #74.
- [Linux](linux.md) — Ubuntu/GNOME setup, X11 compatibility,
  manual updates, feature limits, and separate CI/desktop acceptance.

## Read in your language

| Language | Overview | Setup and help | Video editing |
| --- | --- | --- | --- |
| 简体中文 | [Kiri](../README.md) | [简体中文](usage.zh-CN.md) | [简体中文](video-editing.zh-CN.md) |
| English | [Kiri](readme/en.md) | [English](usage.md) | [English](video-editing.md) |
| 繁體中文 | [Kiri](readme/zh-TW.md) | [繁體中文](usage.zh-TW.md) | [繁體中文](video-editing.zh-TW.md) |
| 日本語 | [Kiri](readme/ja.md) | [日本語](usage.ja.md) | [日本語](video-editing.ja.md) |
| Deutsch | [Kiri](readme/de.md) | [Deutsch](usage.de.md) | [Deutsch](video-editing.de.md) |
| 한국어 | [Kiri](readme/ko.md) | [한국어](usage.ko.md) | [한국어](video-editing.ko.md) |
| Français | [Kiri](readme/fr.md) | [Français](usage.fr.md) | [Français](video-editing.fr.md) |
| Русский | [Kiri](readme/ru.md) | [Русский](usage.ru.md) | [Русский](video-editing.ru.md) |

The user guides cover the same platform boundaries. Architecture, ADRs, detailed
Linux QA, and contribution records retain their original language.

## Current sources of truth

- [`qa/issue-196-video-export.md`](qa/issue-196-video-export.md) — export/import
  snapshot fixes, Windows runtime regressions and remaining platform/desktop limits.
- [`qa/scrolling-capture.md`](qa/scrolling-capture.md) — bidirectional result checks,
  recovery, localized controls and separate native scrolling-capture acceptance.
- [`qa/shortcut-settings.md`](qa/shortcut-settings.md) — actual settings geometry,
  localized editing states, renderer CI, and separate native shortcut acceptance.
- [`qa/issue-21-windows/README.md`](qa/issue-21-windows/README.md) — native
  Windows multi-display screenshot acceptance and remaining hardware limits.
- [`qa/issue-82-retest.md`](qa/issue-82-retest.md) — verified repair scope and
  the numbered editor, OCR, QR and Linux desktop retest checklist.
- [`qa/linux-ocr-compat.md`](qa/linux-ocr-compat.md) — exact Ubuntu/Kali OCR
  candidate, package provenance and remaining VMware desktop acceptance.
- [`architecture.md`](architecture.md) — runtime structure, data boundaries,
  and platform responsibilities.
- [`../AGENTS.md`](../AGENTS.md) — product contract and repository rules.
- [`roadmap.md`](roadmap.md) — completed capabilities and work that still
  needs product or platform validation.
- [Privacy](privacy/en.md) · [隐私说明](privacy/zh-CN.md) — network, credential, and local-data boundaries.
- [Security](../SECURITY.md) — reporting vulnerabilities.
- [`windows-capture-incident.md`](windows-capture-incident.md) — current
  Windows screenshot lifecycle failure, diagnostics, and native retest gate.
- [`releases/v1.6.44.md`](releases/v1.6.44.md) — latest bilingual release notes
  (full history in `docs/releases/`, starting from
  [`releases/v1.4.9.md`](releases/v1.4.9.md)).

## Decision records

Completed implementation plans and the former Swift migration specifications
are intentionally not kept in the working tree. Git history and release tags
preserve them without letting obsolete paths or constraints guide current
development.

- [`adr/0003-manual-region-selection.md`](adr/0003-manual-region-selection.md)
  — quiet single-outline window selection.
- [`adr/0004-kawaii-professional-visual-system.md`](adr/0004-kawaii-professional-visual-system.md)
  — the former kawaii-professional system and app-icon history.
- [`adr/0007-opt-in-remote-ocr-profiles.md`](adr/0007-opt-in-remote-ocr-profiles.md)
  — opt-in remote OCR and credential handling.
- [`adr/0008-stable-development-signing-identity.md`](adr/0008-stable-development-signing-identity.md)
  — stable macOS privacy identity during development.
- [`adr/0009-operation-local-feedback.md`](adr/0009-operation-local-feedback.md)
  — operation-local progress and completion feedback.
- [`adr/0010-single-action-screenshot-completion.md`](adr/0010-single-action-screenshot-completion.md)
  — one clipboard-first completion action without an overflow menu.
- [`adr/0011-movable-capture-mode-selector.md`](adr/0011-movable-capture-mode-selector.md)
  — a top-centered mode selector that can be moved for the current capture.
- [`adr/0012-interactive-completion-and-recording-output.md`](adr/0012-interactive-completion-and-recording-output.md)
  — interactive completion actions, explicit MP4/GIF output, and the neutral
  recording countdown.
- [`adr/0013-fail-closed-macos-release-signing.md`](adr/0013-fail-closed-macos-release-signing.md)
  — historical fail-closed signing rationale, superseded for release
  orchestration by ADR 0017.
- [`adr/0014-user-initiated-update-checks.md`](adr/0014-user-initiated-update-checks.md)
  — historical browser-only update checks, superseded by ADR 0025.
- [`adr/0015-monochrome-workspace-visual-system.md`](adr/0015-monochrome-workspace-visual-system.md)
  — the black, white, and neutral-gray application visual system.
- [`adr/0016-editable-screenshot-projects.md`](adr/0016-editable-screenshot-projects.md)
  — re-editable local screenshot annotations, flat-image compatibility, and
  completion/library editor entry points.
- [`adr/0017-maintainer-packaged-macos-releases.md`](adr/0017-maintainer-packaged-macos-releases.md)
  — developer-installable GitHub distribution with maintainer-packaged,
  stable self-signed macOS artifacts and no intentional CI red light.
- [`adr/0018-managed-library-location-and-recovery.md`](adr/0018-managed-library-location-and-recovery.md)
  — one managed library, whole-library migration, offline handling, and media
  recovery.
- [`adr/0019-direct-open-library-cards.md`](adr/0019-direct-open-library-cards.md)
  — direct card opening, rubber-band-only batch selection, and explicit editor
  completion wording.
- [`adr/0020-destructive-editor-cropping.md`](adr/0020-destructive-editor-cropping.md)
  — pending crop geometry, destructive library saves, and export-only Save As.
- [`adr/0021-hover-card-quick-actions.md`](adr/0021-hover-card-quick-actions.md)
  — hover-revealed card actions with Edit for images and View for media.
- [`adr/0022-persistent-annotation-appearance.md`](adr/0022-persistent-annotation-appearance.md)
  — shared last-used annotation styling without persisting the active tool.
- [`adr/0023-universal-macos-release.md`](adr/0023-universal-macos-release.md)
  — one verified Universal DMG for Apple silicon and Intel.
- [`adr/0024-native-media-pipelines.md`](adr/0024-native-media-pipelines.md)
  — AVFoundation/ImageIO on macOS and Media Foundation on Windows without a
  downloaded media executable.
- [`adr/0025-signed-user-initiated-updates.md`](adr/0025-signed-user-initiated-updates.md)
  — separately confirmed signed checks, downloads, installation, and
  platform-accurate restart behavior.
- [`adr/0026-recording-countdown-readiness.md`](adr/0026-recording-countdown-readiness.md)
  — visible, cancellable recording countdown readiness.
- [`adr/0027-compact-countdown.md`](adr/0027-compact-countdown.md)
  — compact countdown surface.
- [`adr/0028-ocr-committed-selection.md`](adr/0028-ocr-committed-selection.md)
  — committed OCR selection.
- [`adr/0029-macos-fullscreen-shortcut-overlay.md`](adr/0029-macos-fullscreen-shortcut-overlay.md)
  — preserve the frontmost macOS full-screen Space for shortcut capture.
- [`adr/0030-ocr-history.md`](adr/0030-ocr-history.md)
  — text history and saved screenshot OCR.
- [`adr/0031-windows-update-relaunch.md`](adr/0031-windows-update-relaunch.md)
  — Windows update completion and relaunch behavior.
- [`adr/0032-localized-kiri-installer.md`](adr/0032-localized-kiri-installer.md)
  — localized Kiri installer.
- [`adr/0033-shared-installer-source.md`](adr/0033-shared-installer-source.md)
  — shared installer source.
- [`adr/0034-local-video-trimming-and-input-check.md`](adr/0034-local-video-trimming-and-input-check.md)
  — local video trimming and microphone checks (historical microphone-test entry
  superseded by ADR 0105).
- [`adr/0035-video-timeline-and-timed-effects.md`](adr/0035-video-timeline-and-timed-effects.md)
  — video timeline and timed effects.
- [`adr/0036-video-annotation-tracks-and-playback.md`](adr/0036-video-annotation-tracks-and-playback.md)
  — video annotation tracks and playback controls.
- [`adr/0037-video-effect-styles-and-export-controls.md`](adr/0037-video-effect-styles-and-export-controls.md)
  — styled video effects and consistent export controls.
- [`adr/0038-output-timeline-and-clip-speed.md`](adr/0038-output-timeline-and-clip-speed.md)
  — output timeline, clip order and local speed.
- [`adr/0039-direct-annotation-and-local-media.md`](adr/0039-direct-annotation-and-local-media.md)
  — direct annotation, stickers and local media import.
- [`adr/0040-playback-scrubbing.md`](adr/0040-playback-scrubbing.md)
  — consistent playback scrubbing.
- [`adr/0041-single-canvas-video-editing.md`](adr/0041-single-canvas-video-editing.md)
  — single-canvas video editing.
- [`adr/0042-readable-tools-and-layer-order.md`](adr/0042-readable-tools-and-layer-order.md)
  — readable tools and explicit layer order.
- [`adr/0043-editable-video-annotation-objects.md`](adr/0043-editable-video-annotation-objects.md)
  — editable video annotation objects.
- [`adr/0044-video-editing-completion-and-selection.md`](adr/0044-video-editing-completion-and-selection.md)
  — completing an edit without losing the user's place.
- [`adr/0045-local-video-projects-and-cancellable-export.md`](adr/0045-local-video-projects-and-cancellable-export.md)
  — local video projects and cancellable export.
- [`adr/0046-configurable-capture-shortcut.md`](adr/0046-configurable-capture-shortcut.md)
  — configurable native capture shortcut.
- [`adr/0047-macos-fullscreen-space-parents.md`](adr/0047-macos-fullscreen-space-parents.md)
  — native panel parents for full-screen capture windows.
- [`adr/0048-windows-extract-and-run-release.md`](adr/0048-windows-extract-and-run-release.md)
  — Windows extract-and-run release.
- [`adr/0049-linux-screenshot-mvp.md`](adr/0049-linux-screenshot-mvp.md)
  — historical initial Linux screenshot scope, superseded by ADR 0051.
- [`adr/0050-linux-wayland-grim-and-hyprland-shortcut.md`](adr/0050-linux-wayland-grim-and-hyprland-shortcut.md)
  — historical Hyprland implementation, superseded where noted.
- [`adr/0051-ubuntu-linux-capture-boundaries.md`](adr/0051-ubuntu-linux-capture-boundaries.md)
  — current Ubuntu Linux platform, shortcut, recording, and packaging contract.
- [`adr/0052-gnome-screenshot-consent-recovery.md`](adr/0052-gnome-screenshot-consent-recovery.md)
  — ambiguous first-use GNOME denial and safe retry guidance.
- [`adr/0053-direct-line-adjustment.md`](adr/0053-direct-line-adjustment.md)
  — direct adjustment of selected lines.
- [`adr/0054-red-click-highlight.md`](adr/0054-red-click-highlight.md)
  — high-contrast recorded click highlight.
- [`adr/0055-editable-ocr-history.md`](adr/0055-editable-ocr-history.md)
  — editable OCR history with original text.
- [`adr/0056-batch-library-export.md`](adr/0056-batch-library-export.md)
  — copy selected library items to a folder.
- [`adr/0057-clipboard-image-import.md`](adr/0057-clipboard-image-import.md)
  — explicit clipboard image import.
- [`adr/0058-pinned-screenshot-reference.md`](adr/0058-pinned-screenshot-reference.md)
  — pinned screenshot reference windows.
- [`adr/0059-lightweight-recorded-click-highlight.md`](adr/0059-lightweight-recorded-click-highlight.md)
  — reduce the recorded click ring's visual weight while retaining its red cue.
- [`adr/0060-image-text-editing-and-close.md`](adr/0060-image-text-editing-and-close.md)
  — image text editing and unsaved close.
- [`adr/0061-local-qr-recognition-and-favorites.md`](adr/0061-local-qr-recognition-and-favorites.md)
  — local QR recognition and favorites.
- [`adr/0062-qr-multi-contrast-results.md`](adr/0062-qr-multi-contrast-results.md)
  — merge QR results across contrast thresholds.
- [`adr/0063-qr-center-markers-and-supported-geometry.md`](adr/0063-qr-center-markers-and-supported-geometry.md)
  — explicit center-marker selection and validation of QR finder geometry.
- [`adr/0064-direct-qr-selection-and-opening.md`](adr/0064-direct-qr-selection-and-opening.md)
  — original-region QR markers, automatic saving of selected codes and direct
  opening.
- [`adr/0065-recording-save-status-and-file-copy.md`](adr/0065-recording-save-status-and-file-copy.md)
  — visible background recording saves and native file copying from the library
  and viewer.
- [`adr/0066-persistent-macos-dock-visibility.md`](adr/0066-persistent-macos-dock-visibility.md)
  — an immediate macOS Dock switch remembered across launches.
- [`adr/0067-bounded-local-qr-recovery.md`](adr/0067-bounded-local-qr-recovery.md)
  — bounded overlapping scans recover codes beyond full-image decoder limits.
- [`adr/0068-qr-markers-in-saved-image-editor.md`](adr/0068-qr-markers-in-saved-image-editor.md)
  — saved-image recognition uses the original editor surface and preserves drafts.
- [`adr/0069-image-fidelity-and-linux-media-playback.md`](adr/0069-image-fidelity-and-linux-media-playback.md)
  — transparent PNG editing, color conversion, shared styling and bounded Linux
  playback.
- [`adr/0070-library-asset-file-size.md`](adr/0070-library-asset-file-size.md)
  — file size on library asset cards.
- [`adr/0071-library-navigation-and-floating-feedback.md`](adr/0071-library-navigation-and-floating-feedback.md)
  — library navigation and floating feedback.
- [`adr/0072-live-annotation-transform-preview.md`](adr/0072-live-annotation-transform-preview.md)
  — live annotation transform preview.
- [`adr/0073-linux-recording-audio.md`](adr/0073-linux-recording-audio.md)
  — local sound sources, a shared media clock and real-device acceptance limits.
- [`adr/0074-linux-basic-video-export.md`](adr/0074-linux-basic-video-export.md)
  — normal-speed cuts, source audio, bounded native processing and independent
  capability gates.
- [`adr/0075-wayland-global-shortcuts-portal.md`](adr/0075-wayland-global-shortcuts-portal.md)
  — explicit setup, truthful bindings and command fallbacks.
- [`adr/0076-inline-capture-size-controls.md`](adr/0076-inline-capture-size-controls.md)
  — inline capture size controls.
- [`adr/0077-quick-screenshot-completion-and-pin.md`](adr/0077-quick-screenshot-completion-and-pin.md)
  — quick screenshot completion and pinning.
- [`adr/0077-streaming-gif-conversion-feedback.md`](adr/0077-streaming-gif-conversion-feedback.md)
  — streaming GIF conversion and operation feedback.
- [`adr/0078-cancellable-gif-video-validation.md`](adr/0078-cancellable-gif-video-validation.md)
  — cancellable GIF conversion and video validation.
- [`adr/0079-seven-language-preferences.md`](adr/0079-seven-language-preferences.md)
  — seven languages and a shared preference (expanded to eight languages by ADR
  0132).
- [`adr/0080-pinned-macos-release-signing.md`](adr/0080-pinned-macos-release-signing.md)
  — pinned macOS release signing.
- [`adr/0081-direct-capture-toolbar-pin.md`](adr/0081-direct-capture-toolbar-pin.md)
  — direct capture toolbar pin.
- [`adr/0082-screenshot-hover-color-picker.md`](adr/0082-screenshot-hover-color-picker.md)
  — screenshot hover color picker.
- [`adr/0083-numbered-screenshot-callouts.md`](adr/0083-numbered-screenshot-callouts.md)
  — editable numbered screenshot callouts.
- [`adr/0084-directional-label-bubbles.md`](adr/0084-directional-label-bubbles.md)
  — directional label bubbles.
- [`adr/0085-inline-callout-text-editing.md`](adr/0085-inline-callout-text-editing.md)
  — edit numbered callout descriptions on the canvas.
- [`adr/0086-library-file-actions.md`](adr/0086-library-file-actions.md)
  — managed library file actions.
- [`adr/0087-capture-hud-layout.md`](adr/0087-capture-hud-layout.md)
  — keep capture controls clear of the mode selector.
- [`adr/0088-annotation-properties-and-watermarks.md`](adr/0088-annotation-properties-and-watermarks.md)
  — annotation properties and local text watermarks.
- [`adr/0089-anchored-labels-and-direct-callout-drag.md`](adr/0089-anchored-labels-and-direct-callout-drag.md)
  — anchored labels and direct callout dragging.
- [`adr/0090-annotation-reediting-and-tiled-watermarks.md`](adr/0090-annotation-reediting-and-tiled-watermarks.md)
  — reliable annotation re-editing and tiled watermarks.
- [`adr/0091-direct-text-annotation-toolbar.md`](adr/0091-direct-text-annotation-toolbar.md)
  — direct text annotation toolbar buttons.
- [`adr/0092-finish-text-edit-before-placement.md`](adr/0092-finish-text-edit-before-placement.md)
  — finish editing and clear selection before the next placement.
- [`adr/0093-annotation-selection-and-deletion.md`](adr/0093-annotation-selection-and-deletion.md)
  — consistent annotation selection and deletion.
- [`adr/0094-screenshot-ocr-and-annotation-layer-order.md`](adr/0094-screenshot-ocr-and-annotation-layer-order.md)
  — screenshot-toolbar OCR and creation-order annotation compositing.
- [`adr/0095-macos-pinned-image-movement.md`](adr/0095-macos-pinned-image-movement.md)
  — pointer-based macOS reference movement across asynchronous WebView IPC.
- [`adr/0096-capture-origin-pin-placement.md`](adr/0096-capture-origin-pin-placement.md)
  — capture-origin reference placement.
- [`adr/0097-explicit-library-batch-selection.md`](adr/0097-explicit-library-batch-selection.md)
  — explicit library batch selection.
- [`adr/0098-unified-main-window-workspace.md`](adr/0098-unified-main-window-workspace.md)
  — unified main-window workspace and responsive settings layout.
- [`adr/0099-panel-open-update-discovery.md`](adr/0099-panel-open-update-discovery.md)
  — cached version checks and a Settings notification; downloads and installs
  remain explicit.
- [`adr/0100-in-window-empty-trash-confirmation.md`](adr/0100-in-window-empty-trash-confirmation.md)
  — main-WebView modal, safe focus and single-flight deletion.
- [`adr/0101-tray-support-information-and-pin-frame.md`](adr/0101-tray-support-information-and-pin-frame.md)
  — Windows left-click activation, explicit support-info copying and a persistent
  neutral pin outline.
- [`adr/0102-visible-recording-startup-failures.md`](adr/0102-visible-recording-startup-failures.md)
  — session-safe failure cards and optional Windows capture-border capability
  checks.
- [`adr/0103-annotation-tool-double-click-completion.md`](adr/0103-annotation-tool-double-click-completion.md)
  — annotation tool double-click completion.
- [`adr/0104-windows-recording-active-time.md`](adr/0104-windows-recording-active-time.md)
  — keep static footage duration and exclude pauses.
- [`adr/0105-adaptive-recording-controls.md`](adr/0105-adaptive-recording-controls.md)
  — adaptive preparation and recording controls, explicit microphone selection,
  and native acceptance requirements.
- [`adr/0106-floating-window-hover.md`](adr/0106-floating-window-hover.md)
  — include eligible macOS floating panels while preserving frontmost-window
  selection.
- [`adr/0107-windows-capture-visibility-and-pin-drag.md`](adr/0107-windows-capture-visibility-and-pin-drag.md)
  — synchronize Windows capture visibility and pin movement.
- [`adr/0108-support-folder-and-project-links.md`](adr/0108-support-folder-and-project-links.md)
  — explicit shortcuts to existing folders and the GitHub project from About.
- [`adr/0109-direct-library-permanent-deletion.md`](adr/0109-direct-library-permanent-deletion.md)
  — confirmed single and batch deletion without a Trash detour.
- [`adr/0110-shortcut-settings-and-visible-tool-keys.md`](adr/0110-shortcut-settings-and-visible-tool-keys.md)
  — four launch actions and two recording-only shortcuts, visible editing and
  default-reset controls, contextual key references, and shared annotation
  controls.
- [`adr/0111-supported-shortcut-keys-and-confirmation.md`](adr/0111-supported-shortcut-keys-and-confirmation.md)
  — native-library-supported keys, confirmation for bare and Shift-only
  typing/navigation keys, and consistent browser/native recording.
- [`adr/0112-free-bidirectional-scroll-capture.md`](adr/0112-free-bidirectional-scroll-capture.md)
  — natural up/down scrolling, verified original-pixel strips, explicit partial
  saving and platform limits.
- [`adr/0113-contextual-image-editor-and-zoom.md`](adr/0113-contextual-image-editor-and-zoom.md)
  — contextual image editor and zoom.
- [`adr/0114-opt-in-login-startup.md`](adr/0114-opt-in-login-startup.md)
  — opt-in system login startup and resident launch behavior.
- [`adr/0115-control-focus-and-retryable-library-tags.md`](adr/0115-control-focus-and-retryable-library-tags.md)
  — keyboard ownership, modal navigation and acknowledged tag updates.
- [`adr/0116-pending-library-and-editor-actions.md`](adr/0116-pending-library-and-editor-actions.md)
  — scoped library loading, explicit failures, correction drafts and pending
  sticker imports.
- [`adr/0117-windows-scroll-guide-fallback.md`](adr/0117-windows-scroll-guide-fallback.md)
  — preserve Windows scrolling capture with an incompatible region guide hidden.
- [`adr/0118-system-command-linux-ocr.md`](adr/0118-system-command-linux-ocr.md)
  — let the distribution manage Tesseract and Leptonica compatibility.
- [`adr/0119-readable-pinned-screenshots-and-scroll-pin.md`](adr/0119-readable-pinned-screenshots-and-scroll-pin.md)
  — independent reference zoom and scrolling, plus one-step pinning after a
  complete scrolling capture.
- [`adr/0120-readable-update-notes.md`](adr/0120-readable-update-notes.md)
  — compact update actions and safely formatted, language-aware release notes.
- [`adr/0121-failure-recovery-and-action-ownership.md`](adr/0121-failure-recovery-and-action-ownership.md)
  — retryable screenshot saving, query-owned QR actions and temporary GIF cleanup.
- [`adr/0122-preserve-local-state-during-recovery.md`](adr/0122-preserve-local-state-during-recovery.md)
  — acknowledged favorites, atomic preferences, library recovery notifications
  and preserved video drafts.
- [`adr/0124-continuous-screenshot-annotation.md`](adr/0124-continuous-screenshot-annotation.md)
  — consecutive shape drawing, text-only confirmation, content-preserving
  right-click and stable properties.
- [`adr/0125-windows-small-text-ocr-recovery.md`](adr/0125-windows-small-text-ocr-recovery.md)
  — bounded Windows small-text OCR recovery.
- [`adr/0126-offline-chinese-ocr.md`](adr/0126-offline-chinese-ocr.md)
  — offline recognition of small Chinese selections.
- [`adr/0127-unified-local-ocr.md`](adr/0127-unified-local-ocr.md)
  — cross-platform local OCR with bundled PP-OCRv6 small.
- [`adr/0128-text-and-qr-batch-selection.md`](adr/0128-text-and-qr-batch-selection.md)
  — batch selection for Text History and QR Favorites.
- [`adr/0129-history-navigation-and-ocr-draft-safety.md`](adr/0129-history-navigation-and-ocr-draft-safety.md)
  — cancel stale annotation gestures and retain failed corrections across
  attempted navigation.
- [`adr/0130-video-export-failure-boundaries.md`](adr/0130-video-export-failure-boundaries.md)
  — closed source snapshots, safe diagnostics and retryable export/open/cancel
  states.
- [`adr/0131-standard-remote-ocr-urls.md`](adr/0131-standard-remote-ocr-urls.md)
  — conventional HTTP/HTTPS profile validation with explicit per-image consent.
- [`adr/0132-russian-ui-language.md`](adr/0132-russian-ui-language.md)
  — an eighth complete dictionary using the existing selector, preference, and
  native labels.
- [`adr/0133-ocr-history-and-screenshot-search.md`](adr/0133-ocr-history-and-screenshot-search.md)
  — OCR history actions and screenshot text search.
- [`adr/0134-stable-library-search-and-inline-tag-editing.md`](adr/0134-stable-library-search-and-inline-tag-editing.md)
  — search in the capture heading, scrollable tag filters and retryable
  per-capture tag edits.
- [`adr/0135-library-tag-assignment.md`](adr/0135-library-tag-assignment.md)
  — card drag targets and atomic tag changes for selected captures.
- [`adr/0136-resumable-update-downloads.md`](adr/0136-resumable-update-downloads.md)
  — resume interrupted signed update downloads across restarts with explicit
  verification.
