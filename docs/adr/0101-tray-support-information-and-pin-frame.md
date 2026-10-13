# ADR 0101: Tray activation, support information and pin boundaries

- Status: Accepted
- Date: 2026-10-13

## Decision

On Windows, a completed left tray click opens/restores/focuses the existing
main panel through its serialized presenter. Right-click menus retain their
existing actions. macOS keeps its menu-bar menu; Linux tray backends do not
emit the required pointer events and retain their desktop-managed menu.

Settings → About offers Copy Info beside the update action. Its library-only
native command copies an allowlist: Kiri/OS versions, process architecture,
build/package kind, language, display resolution and scale, plus X11/Wayland
session kind on Linux. No paths, screen names, captures, logs or credentials
are read or copied. It never routes through OCR's session-ending copy command.
Clipboard errors remain retryable; success follows the completed write.

Pinned images have a persistent neutral dark/light outline drawn as an
input-transparent overlay. The original frame and full image layout stay the
same, and drag, resize, pin controls and saved pixels are unaffected.

## Verification

Cover tray button/up-down routing, copied metadata and mixed display scales,
clipboard pending/error/retry behavior, seven-language layouts and native
Windows installed/portable clipboard checks. A browser fixture proves layout
only; platform tray behavior requires a Windows desktop check.
