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

## Permanently delete captures

In a capture’s menu, choose **Delete Permanently**, or select captures and use
**Delete Permanently (count)** in the toolbar above the grid. The red action asks
for confirmation and cannot be undone. **Move to Trash** remains available for
recoverable deletion; you do not need to empty Trash to delete selected captures.

## Language

Settings → General → Language offers English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어, and Français. Your choice applies to every open Kiri window and survives relaunches. On first launch, Kiri follows the system language. UI language choices do not change installed Linux OCR language data.

## Capture

Press ⇧⌘A on macOS or Shift+Ctrl+A on Windows / Linux X11, then select a window or drag a region. On Wayland, use the Capture button or bind `kiri --capture` in desktop settings. Supporting desktops also offer Settings → Shortcuts → Wayland Desktop Shortcuts for desktop-approved Capture, Pause/Resume, and Stop bindings. Ubuntu 24.04 / GNOME 46 retains the command fallback.

On macOS, Windows and Linux, the Kiri executable also accepts `--capture`, `--record`, `--ocr` and `--library` to open screenshot selection, recording selection, text recognition and the main window, whether Kiri is already running or starting for the first time.

Choose Screenshot, Record, or OCR. The screenshot toolbar also offers Recognize QR Codes. Enter confirms a screenshot; Esc cancels capture. Screenshots go to your clipboard and local library.

### Keyboard shortcuts

Settings → Shortcuts brings global shortcuts and the in-app key reference together.
On macOS, Windows, and X11, click an action's key field and press the key or
combination you want. Function keys F1–F24, media keys, and combinations containing
Control, Alt/Option, or Command/Windows save directly when supported and available.
Other bare keys or Shift-only combinations show a preview and require **Use this
key**, because they also affect typing or navigation in other apps. For recording
controls, that effect lasts only while recording. The old binding remains until
the change succeeds.

On macOS, ordinary shortcuts do not need Input Monitoring permission. Media-key
shortcuts use an intercepting event tap and require existing Accessibility
authorization. If it is missing, Kiri reports an error and keeps the old binding;
it does not request authorization in a popup or change your permissions.

Esc cancels. Tab or Shift+Tab leaves recording; with a pending key, Tab can move to
its confirmation button. Esc and Tab can themselves be recorded when combined
with Control, Alt/Option, or Command/Windows. Pure modifier presses do not set a
binding. Clear removes a binding, and changed or cleared rows offer Restore
Default directly.

The four **Launch actions** stay available while Kiri is running:

| Action | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Screenshot | ⇧⌘A | Shift+Ctrl+A |
| Record | ⌥⇧⌘R | Alt+Shift+Ctrl+R |
| Recognize Text | ⌥⇧⌘O | Alt+Shift+Ctrl+O |
| Show main window | ⌥⇧⌘L | Alt+Shift+Ctrl+L |

The two **While recording** actions work across applications during recording,
including while paused:

| Action | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Pause/Resume Recording | ⌥⇧⌘P | Alt+Shift+Ctrl+P |
| Stop and Save Recording | ⌥⇧⌘S | Alt+Shift+Ctrl+S |

Kiri registers these two native bindings when recording begins and releases them
when stopping begins or recording fails. They do not reserve keys while Kiri is
idle, choosing a region, or counting down. If a recording binding is unavailable,
recording continues and Kiri reports the problem; use the floating controls on
macOS/Windows or the tray menu to pause or stop, then choose another combination
in Settings → Shortcuts.

Record and Recognize Text open region selection in the corresponding mode. Recording
still waits for Start and the countdown; remote OCR still requires confirmation.
Your existing screenshot combination is preserved. If it matches a new default,
that new action starts unassigned. A duplicate or unavailable replacement leaves
the previous binding intact. Registration cannot detect every shortcut used inside
other applications; choose a different combination if one interrupts your workflow.

Wayland keys remain desktop-managed. Assign `kiri --capture`, `kiri --record`,
`kiri --ocr`, or `kiri --library` in your desktop keyboard settings. For recording
controls, bind `kiri --toggle-recording-pause` and `kiri --stop-recording`. The
optional Portal setup retains its Capture, Pause/Resume, and Stop actions.
These recording commands only act on an ongoing recording, but the desktop may
keep their keys reserved while Kiri is idle; Kiri cannot release desktop-owned
bindings between recordings.

Before choosing an annotation tool, click the screenshot toolbar's sliders button to show editable width and height labels on the selection edges. Values use output pixels, including on Retina displays. Enter or leaving a field applies its value; Esc discards the current input, and a second Esc cancels capture. Arrow keys adjust by one pixel, or ten with Shift. Click the sliders again to hide the labels. Once annotation starts, the sliders retain their appearance controls.

On macOS, if you change display layout, resolution, or scale after selecting a region, start a new capture before recording. If recording is paused, stop and save it first.

While typing an annotation, Ctrl/Cmd+Z undoes text and Shift+Enter adds a line. Esc leaves the text edit first; a second Esc cancels capture. Closing an edited saved image offers Save, Discard, or Keep editing when changes are unsaved.

On GNOME Wayland, if the first capture shows no permission dialog, open Kiri's Library and choose Request Access in the error banner. Allow screenshot access in GNOME's dialog, then retry Capture. Kiri discards the authorization image. See the [Linux guide](linux.md).

Recording preparation offers MP4 / GIF, Start, and four inline icons: system audio, microphone, pointer, and click highlights. Start always runs a three-second countdown; GIF recordings are silent. The panel adapts to the selection and display edges.

Use the small arrow beside the microphone to select an actual input device without changing the system default. If the selected device is unavailable or disconnects, Kiri reports an error instead of silently switching microphones.

On macOS and Windows, recording controls follow the selection and adapt near display edges without taking keyboard focus. Dragging moves the current panel; the next capture positions it from the new selection again. Pause keeps the recorded elapsed time, and resume continues it. Use the configured recording shortcuts, the control buttons, or the tray menu. There are no built-in bare Space/Esc recording commands; a bare key you explicitly confirm as a recording shortcut follows that binding. A button you focus explicitly still supports normal Space/Enter activation. Esc continues to cancel capture and the countdown. Older Windows versions may still show the system’s full-display capture border. Linux uses native X11 shortcuts, desktop-managed Wayland shortcuts, tray actions, or commands.

## Scrolling screenshots

Select the scrolling content, then choose **Scrolling Screenshot** in the screenshot toolbar before adding annotations. Start anywhere and scroll naturally up or down; captured content is not added twice when you return to it. Pausing to read does not end capture. Choose **Done** to copy and save, or **Esc** to cancel before saving starts. Enter remains available to the original application.

While scrolling capture is active, `kiri --finish-scroll-capture` performs the same complete-save check as **Done**; it never falls back to saving a partial result. `kiri --cancel-scroll-capture` cancels before saving begins. Both commands control only the current session and do not start a new capture.

The selected area stays visibly marked during capture. The area outside it is dimmed, while clicks, wheel input and trackpad gestures pass through to the original application. This guide does not change the capture area or appear in the saved image.

The preview follows a section of the original capture, fitted to the panel width. Its scale stays the same as the screenshot grows. Scroll inside it to inspect the captured content; move the pointer away to resume following. Drag the title row to move the panel; for compact controls, drag the status text. The panel stays on the capture display and, on X11, outside the selection.

After scrolling, Kiri removes detected fixed headers and footers. Shadows may remain at outer edges you have not revisited. If Kiri asks for recovery, scroll back through the affected area before saving the complete image.

If the view cannot be joined, Kiri keeps the connected result and asks you to return to captured content. Scroll back, then continue through the missing area. Content skipped by a large scrollbar jump cannot be recovered without showing it again. **Save captured area**, when offered, explicitly saves only the current partial result; it does not fill missing or uncertain content. If saving fails, retry without losing that result.

Available on macOS, Windows and Linux X11; unavailable on Wayland. On macOS, select an area fully inside one normal application window. Capture stays bound to that window and excludes external floating windows and other windows from the same app. Moving, resizing or losing the source window stops capture while preserving progress. Windows and X11 still capture the display region and do not automatically exclude external floating windows; keep those outside the selection.

Large blank or repeated areas, horizontal scrolling, zoom changes and layout reflow can prevent matching. On X11, leave room outside the selection for the compact 220 × 76 controls plus a small gap; macOS and Windows may place capture-excluded controls inside the selection when needed. If the image reaches its size limit, save the captured area and start another capture.

## Screenshot annotations

Saved images use the same annotation tools: select a tool or existing object to show its options; an empty selection leaves the image clear. Long images open to fit the window width; smaller images are not enlarged automatically. Scroll to browse, use the bottom controls to zoom or fit the width/image, and choose Actual size for original pixel density. Pinch or Ctrl/Command-scroll zooms; hold Space and drag to pan. Viewing changes do not alter saved pixels.

Select an existing annotation to change its style. Mosaic offers freehand, rectangle, and ellipse shapes, with pixel or blur effects and adjustable strength. Use Watermark (W) to type directly on the image, then adjust the tiled watermark’s opacity, angle, and spacing. Watermarks remain editable after saving.

In the screenshot overlay, drag the small handle on the annotation toolbar or in the property panel’s heading to move each independently. With a handle focused, arrow keys move it by 2 pixels, or 10 with Shift. Chosen positions stay for the current capture, even when you adjust the selection or change tools; a new capture starts with automatic placement. The property panel makes room if the toolbar moves over it. Hide tool options keeps the panel closed until you reopen it from the main toolbar. Automatic property-panel placement also avoids the selected annotation.

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
