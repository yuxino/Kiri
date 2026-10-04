# Using Kiri

[Back to README](../README.md) · [简体中文](usage.zh-CN.md)

## Install and update

[Download the latest release →](https://github.com/yuxino/kiri/releases/latest)

| Platform | Install |
| --- | --- |
| macOS 14+ · Apple silicon & Intel | Open the Universal `.dmg` and drag Kiri to Applications. |
| Windows 11 · x64 | Run the `.exe` installer, or extract the Portable ZIP and run `kiri.exe`. |
| Ubuntu 24.04 · x64 · GNOME / X11 | Download the `.deb`, then run `sudo apt install ./kiri_VERSION_amd64.deb` with its actual filename. |

macOS needs Screen & System Audio Recording permission; click highlights also need Input Monitoring, and microphone recording requires macOS 15+. The app is not Apple-notarized: if blocked, use System Settings → Privacy & Security → Open Anyway. Windows packages are not Authenticode-signed, so SmartScreen may warn.

Linux: Wayland capture supports one connected display. MP4 recording supports system audio and microphone through the local PulseAudio or PipeWire audio service. Click highlights remain unavailable. Saved videos support basic cuts and MP4 export; advanced video effects are unavailable. See the [Linux guide](linux.md) for setup and recording controls.

Updates: macOS and Windows installer builds use Settings → About → Check for Updates. Linux and Windows Portable users download a new package from Releases. Portable settings and captures stay in the Windows user profile.

macOS Dock: Settings → Show in Dock controls the Dock icon immediately and remembers your choice. The tray and capture shortcut remain available when it is hidden.

## Capture

Press ⇧⌘A on macOS or Shift+Ctrl+A on Windows / Linux X11, then select a window or drag a region. On Wayland, use the Capture button or bind `kiri --capture` in desktop settings. Supporting desktops also offer Settings → General → Wayland Desktop Shortcuts for desktop-approved Capture, Pause/Resume, and Stop bindings. Ubuntu 24.04 / GNOME 46 retains the command fallback.

Choose Screenshot, Record, or OCR. The screenshot toolbar also offers Recognize QR Codes. Enter confirms a screenshot; Esc cancels capture. Screenshots go to your clipboard and local library. You can change the capture shortcut in Settings on macOS, Windows, and X11.

Before choosing an annotation tool, click the screenshot toolbar's sliders button to show editable width and height labels on the selection edges. The recording settings offer the same button. Values use output pixels, including on Retina displays. Enter or leaving a field applies its value; Esc discards the current input, and a second Esc cancels capture. Arrow keys adjust by one pixel, or ten with Shift. Click the sliders again to hide the labels. Once annotation starts, the sliders retain their appearance controls.

On macOS, if you change display layout, resolution, or scale after selecting a region, start a new capture before recording. If recording is paused, stop and save it first.

While typing an annotation, Ctrl/Cmd+Z undoes text and Shift+Enter adds a line. Esc leaves the text edit first; a second Esc cancels capture. Closing an edited saved image offers Save, Discard, or Keep editing when changes are unsaved.

On GNOME Wayland, if the first capture shows no permission dialog, open Kiri's Library and choose Request Access in the error banner. Allow screenshot access in GNOME's dialog, then retry Capture. Kiri discards the authorization image. See the [Linux guide](linux.md).

## Privacy

Captures and media processing stay local. Remote OCR is optional and asks before each upload. Editable screenshots retain an original image locally, including pixels covered by annotations. Read the [privacy policy](../PRIVACY.md).

## More docs

[Video editing](video-editing.md) · [Linux](linux.md) · [Documentation & QA](README.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)
