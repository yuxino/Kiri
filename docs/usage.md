# Using Kiri

[简体中文](usage.zh-CN.md) · **English** · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · [Deutsch](usage.de.md) · [한국어](usage.ko.md) · [Français](usage.fr.md)

[Back to README](readme/en.md)

## Install and update

[Download the latest release →](https://github.com/yuxino/kiri/releases/latest)

| Platform | Install |
| --- | --- |
| macOS 14+ · Apple silicon & Intel | Open the Universal `.dmg` and drag Kiri to Applications. |
| Windows 11 · x64 | Run the `.exe` installer, or extract the Portable ZIP and run `kiri.exe`. |
| Ubuntu 24.04 · x64 · GNOME / X11 | Download the `.deb`, then run `sudo apt install ./kiri_VERSION_amd64.deb` with its actual filename. |

macOS needs Screen & System Audio Recording permission; click highlights also need Input Monitoring, and microphone recording requires macOS 15+. The app is not Apple-notarized: if blocked, use System Settings → Privacy & Security → Open Anyway. Windows packages are not Authenticode-signed, so SmartScreen may warn.

Linux: Wayland capture supports one connected display. MP4 recording supports system audio and microphone through the local PulseAudio or PipeWire audio service. Click highlights remain unavailable. Saved videos support basic cuts and MP4 export; advanced video effects are unavailable. See the [Linux guide](linux.md) for setup and recording controls.

Updates: macOS and Windows installer builds check when you open the main panel. A New update label beside Settings indicates a newer version; use Settings → About to download and install it. You can also check manually. Linux and Windows Portable users download a new package from Releases. Portable settings and captures stay in the Windows user profile.

macOS Dock: Settings → Show in Dock controls the Dock icon immediately and remembers your choice. The tray and capture shortcut remain available when it is hidden.

## Language

Settings → General → Language offers English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어, and Français. Your choice applies to every open Kiri window and survives relaunches. On first launch, Kiri follows the system language. UI language choices do not change installed Linux OCR language data.

## Capture

Press ⇧⌘A on macOS or Shift+Ctrl+A on Windows / Linux X11, then select a window or drag a region. On Wayland, use the Capture button or bind `kiri --capture` in desktop settings. Supporting desktops also offer Settings → General → Wayland Desktop Shortcuts for desktop-approved Capture, Pause/Resume, and Stop bindings. Ubuntu 24.04 / GNOME 46 retains the command fallback.

Choose Screenshot, Record, or OCR. The screenshot toolbar also offers Recognize QR Codes. Enter confirms a screenshot; Esc cancels capture. Screenshots go to your clipboard and local library. You can change the capture shortcut in Settings on macOS, Windows, and X11.

Before choosing an annotation tool, click the screenshot toolbar's sliders button to show editable width and height labels on the selection edges. Values use output pixels, including on Retina displays. Enter or leaving a field applies its value; Esc discards the current input, and a second Esc cancels capture. Arrow keys adjust by one pixel, or ten with Shift. Click the sliders again to hide the labels. Once annotation starts, the sliders retain their appearance controls.

On macOS, if you change display layout, resolution, or scale after selecting a region, start a new capture before recording. If recording is paused, stop and save it first.

While typing an annotation, Ctrl/Cmd+Z undoes text and Shift+Enter adds a line. Esc leaves the text edit first; a second Esc cancels capture. Closing an edited saved image offers Save, Discard, or Keep editing when changes are unsaved.

On GNOME Wayland, if the first capture shows no permission dialog, open Kiri's Library and choose Request Access in the error banner. Allow screenshot access in GNOME's dialog, then retry Capture. Kiri discards the authorization image. See the [Linux guide](linux.md).

Recording preparation offers MP4 / GIF, Start, and four inline icons: system audio, microphone, pointer, and click highlights. Start always runs a three-second countdown; GIF recordings are silent. The panel adapts to the selection and display edges.

Use the small arrow beside the microphone to select an actual input device without changing the system default. If the selected device is unavailable or disconnects, Kiri reports an error instead of silently switching microphones.

On macOS and Windows, recording controls follow the selection and adapt near display edges. Dragging moves the current panel; the next capture positions it from the new selection again. Pause keeps the recorded elapsed time, and resume continues it. Older Windows versions may still show the system’s full-display capture border. Linux continues to use tray actions or commands.

## Screenshot annotations

Select an existing annotation to change its style. Mosaic offers freehand, rectangle, and ellipse shapes, with pixel or blur effects and adjustable strength. Use Watermark (W) to type directly on the image, then choose a single mark or a tiled pattern and adjust opacity, angle, and spacing. Watermarks remain editable after saving.

Text (T), Numbered callout (N), and Label bubble (B) each have their own button in the screenshot and image-editor toolbars. Choose Numbered callout, click to place a number, and type its description directly on the image; Return adds a line. Drag the number and transparent description separately, and adjust size, color, and filled or outline style.

Single-click existing text, numbered notes, labels, or watermarks to select them; drag to move and double-click to edit. Press `Delete` or `Backspace` to remove a selected annotation, or click **Delete annotation**. Undo with `⌘Z` / `Ctrl+Z`. While typing, deletion keys only delete text.

While entering text, a numbered description, or a label, the first action on empty canvas finishes editing and clears selection; the next uses the current tool. Text and shape tools also clear an existing selection before placing another mark. The tool stays selected, and Pen and mosaic support continuous strokes. Clicking the canvas ends watermark input; editing again reuses the same watermark.

Annotations stack in creation order. Mosaic added later processes earlier text, shapes and watermarks; annotations added afterward appear above it. Moving or editing an annotation keeps its layer.

## References and colors

Double-click an unmarked part of the screenshot selection to finish; double-clicking existing text still edits it. The toolbar pin saves and pins a screenshot, and Pin on the completion card opens the same kind of reference. The reference has a thin black rounded border. Drag the image to move it, resize proportionally from the lower-right corner, and hover to unpin or close.

In Screenshot mode, hover to magnify the original pixels and see their coordinates and HEX color. Press `⌘C` on macOS or `Ctrl+C` to copy the color while keeping the selection. The loupe hides once annotation starts.

## GIF conversion

Converting a library MP4 to GIF checks video decoding before encoding. Use Cancel during checking or conversion; Cancel all stops multiple jobs. The original video remains. Cancellation is unavailable once the final library save begins.

## Library and feedback

Use Select Multiple to check items or select all, then move them to Trash; ordinary clicks still open an item. Trash supports batch restore and confirms Empty Trash inside the main window. Renaming updates the actual filename while keeping its type. Copy File in the context menu pastes into a folder; Copy still pastes image pixels.

When reporting a problem, use Settings → About → Copy Info for app, system and display information. It excludes captures, credentials and personal paths.

Settings → About also offers Open Folder for settings and logs, plus a GitHub link. On Windows, the folder menu includes error logs and the system temporary folder; opening a folder does not delete anything.

## Privacy

Captures and media processing stay local. Remote OCR is optional and asks before each upload. Editable screenshots retain an original image locally, including pixels covered by annotations. Read the [privacy policy](privacy/en.md).

## More docs

[Video editing](video-editing.md) · [Linux](linux.md) · [Documentation & QA](README.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)
