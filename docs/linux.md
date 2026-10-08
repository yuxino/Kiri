# Linux

Kiri supports **Ubuntu 24.04 x64 with GNOME**, on Wayland and X11.
Find published packages on [GitHub Releases](https://github.com/yuxino/kiri/releases).
For a source revision not yet released, download its `kiri-linux-deb` artifact
from a successful [build run](https://github.com/yuxino/kiri/actions/workflows/build.yml),
or build the package below. Match the artifact to the revision you want to test.

## Install and update

Extract the artifact ZIP if needed, then install the `.deb` with `apt` so its
dependencies are installed automatically:

```bash
# Replace VERSION with the version in the downloaded filename.
sudo apt install ./kiri_VERSION_amd64.deb
kiri
```

Use `apt install` with the local package so its declared dependencies are
resolved. GNOME capture also needs the desktop's running portal and PipeWire
session. On Ubuntu GNOME, the relevant packages are:

```bash
sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome pipewire
```

The `.deb` declares the GStreamer plugins and Tesseract English, Simplified
Chinese, and Japanese language data. Optional remote OCR requires an unlocked
Secret Service implementation, normally GNOME Keyring on Ubuntu. Local OCR
does not require an account or a network connection.

Linux has no in-app installer or signed updater artifacts. Download a newer
`.deb`, quit Kiri, and install the replacement with the same command. Library
and settings remain in the user profile. AppImage and Flatpak packaging are
not part of this first maintained package path.

The default library is `$XDG_DATA_HOME/kiri`, or `~/.local/share/kiri` when that
variable is unset. Use Settings to change the library location. Do not move or
delete its files manually while Kiri is running.

## GNOME Wayland

Use Kiri's Capture button, or create a custom shortcut in GNOME Settings with
the command `kiri --capture`. Choose an available key combination, such as
`Ctrl+Shift+A`. Kiri does not register an XWayland shortcut as a Wayland binding,
edit your compositor configuration, or install a Hyprland FIFO listener.

### Optional desktop-approved shortcuts

In Settings → General, **Wayland Desktop Shortcuts** checks the installed
`org.freedesktop.portal.GlobalShortcuts` interface. **Set Up Desktop Shortcuts**
asks the desktop for Capture, Pause/Resume Recording, and Stop Recording only.
Choose/approve keys in the desktop dialog. Kiri shows its returned trigger
text for each action; **Not bound** means no usable trigger was returned.
A cancelled/declined/failed request must not display active Portal bindings.
Command guidance remains visible even when Portal setup succeeds.

Approved bindings are restored by one attempt on Kiri's next start; the
desktop may ask again. On session/service loss Kiri clears its displayed
bindings; select **Reconnect Desktop Shortcuts** to try again. Use **Open
Desktop Shortcut Settings** when interface version 2 supports it. Version 1
uses the desktop's own settings or another explicit setup. Refresh checks the
current session, including remapped or revoked keys. **Disconnect Desktop
Shortcuts** ends Kiri's session and stops automatic restoration; the desktop
may retain saved choices. Leaving Settings during setup cancels the request.

| Desktop/backend | Upstream capability | Kiri behavior |
| --- | --- | --- |
| Ubuntu 24.04 / GNOME 46 | No GlobalShortcuts backend | Always retain manual CLI bindings; installing the frontend does not add support |
| GNOME 48+ | Backend introduced in 48.rc | Offer setup only after the installed interface/identity probe succeeds |
| KDE portal backend | GlobalShortcuts implemented; current upstream advertises v2 | Runtime probe; use ConfigureShortcuts only with v2 |
| Hyprland portal backend | Upstream supports activation but currently returns empty trigger descriptions | Unconfirmed actions stay inactive in Kiri; use CLI bindings until the backend reports usable trigger metadata |
| X11 | Native global-hotkey path | Existing configurable capture shortcut; no Portal startup |

Sources: [GNOME release history](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/main/NEWS),
[Ubuntu Noble package](https://packages.ubuntu.com/noble/xdg-desktop-portal-gnome),
[KDE implementation](https://github.com/KDE/xdg-desktop-portal-kde/blob/master/src/globalshortcuts.cpp),
[Hyprland documentation](https://wiki.hypr.land/Hypr-Ecosystem/xdg-desktop-portal-hyprland/),
[Portal protocol](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html).
The current [Hyprland implementation](https://github.com/hyprwm/xdg-desktop-portal-hyprland/blob/master/src/portals/GlobalShortcuts.cpp)
returns empty trigger descriptions ([upstream issue #312](https://github.com/hyprwm/xdg-desktop-portal-hyprland/issues/312)).
Kiri deliberately does not claim or activate an unconfirmed binding. Use command
shortcuts on affected versions; KDE is the alternate-desktop acceptance target.

These are upstream capabilities, not evidence that a Kiri package has passed
physical-desktop acceptance.

For host `.deb` builds, the dedicated D-Bus connection registers
`io.yuxino.kiri` before other Portal calls. The package installs the matching
`/usr/share/applications/io.yuxino.kiri.desktop` metadata entry with
`NoDisplay=true`; the normal `kiri.desktop` launcher remains unchanged.
An uninstalled development binary may lack this identity and correctly fall
back to commands. Do not manually modify permissions or compositor settings
as part of troubleshooting. See the
[Registry identity contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.host.portal.Registry.html).

The current Wayland implementation requires **one connected display**. It
rejects multiple displays before capture rather than guessing which screen
belongs to a portal image. Select a region by dragging; Wayland window hover
outlines and click-to-select windows are unavailable.

GNOME may show a Screenshot permission dialog. Allow the screenshot and return
to Kiri's selection overlay. Cancel closes the request without saving. If a
first capture fails without a prompt, open Kiri's Library and select **Request
Access** in the error banner. This asks GNOME to show its screenshot permission
dialog while Kiri has focus. Choose **Allow**; Kiri discards the authorization
image. Retry Capture for the normal whole-display selection overlay. If you
deny or cancel the dialog, Kiri does not retry it automatically. On compatible
wlroots desktops, installed `grim` may provide the still screenshot; it is
optional on GNOME.

Recording makes a separate ScreenCast request. **Select the same display** as
the frozen screenshot. Kiri checks the supplied stream dimensions before using
the selected region. A denial, timeout, or inconsistent source must produce an
error, not a recording from an arbitrary screen. CI exercises the GNOME portal
and scaling on virtual displays; physical-desktop acceptance remains separate.

Linux does not show a floating recording panel because the portal cannot
reliably exclude it. Use Pause/Resume and Stop in the tray menu, or configure
desktop shortcuts for these commands before recording:

```bash
kiri --toggle-recording-pause
kiri --stop-recording
```

The compositor can include its tray menu in captured pixels. Keep that menu
outside the selected region, or use the desktop shortcuts to avoid it. Pause
ends the current segment; resuming on Wayland may ask for screen sharing again.
Kiri hides its capture feedback windows during recording.

If your GNOME session does not display application tray icons, use these
commands or keyboard shortcuts. Escape cancels the capture overlay/countdown;
it is not a desktop-wide Linux recording-stop shortcut.

## X11

The native capture shortcut defaults to `Ctrl+Shift+A` and can be changed in
Settings → General. A conflicting binding leaves Kiri available through the
Capture button and preserves the previous shortcut when a replacement fails.
X11 capture requests managed fullscreen on the captured monitor before showing
the selection canvas. Panels and docks keep their normal reserved workarea;
they must not shift or crop the frozen desktop.

X11 screenshots use `xcap` to capture the monitor under the pointer and expose
window bounds for hover/click selection. Region dragging and annotation use
the same editor as other platforms.

X11 recording uses the installed GStreamer `ximagesrc` plugin directly; it does
not require a ScreenCast authorization dialog. The isolated Xvfb check exercises
screenshots, local OCR, and recording pause/resume. Native media tests separately
cover MP4/GIF encoding and merging. Check the candidate's reports for results.

## Feature boundaries

| Feature | Current Linux implementation | Remaining acceptance or limit |
| --- | --- | --- |
| Screenshots and annotations | Region capture, editable marks, clipboard, local library | Physical-desktop focus, annotation, and IME acceptance |
| Window selection | X11 hover and click selection | Wayland uses region drag |
| Displays | X11 monitor selection; single-display Wayland | Wayland multiple displays unavailable; physical fractional-scale acceptance pending |
| Local OCR | System Tesseract with installed `eng`, `chi_sim`, `jpn` data | Real GNOME text/IME workflows; missing models show an error |
| Remote OCR | Explicit send/retry, Secret Service credentials | Needs a configured profile and an unlocked secret store |
| Recording | MP4 with optional audio or silent GIF, optional pointer, tray/command controls | Portal consent, pause/resume, timing, and control exclusion on real GNOME |
| Saved videos | Playback, thumbnails, GIF conversion, normal-speed cuts/reordering and MP4 export with source audio | System GStreamer codecs required; no speed changes, effects, masks, annotations or stickers; [installed-app acceptance](qa/linux-video-export.md) remains separate |
| Audio | Optional system audio, microphone or both in MP4; explicit microphone check | Requires local PulseAudio or PipeWire-Pulse and GStreamer audio plugins; real-device acceptance remains separate |
| Click highlights | Unavailable | No click ripple |
| Updates | Manual replacement `.deb` | No Linux in-app installation or signed updater feed |

GTK retains clipboard ownership after capture closes while Kiri is running.
Whether clipboard content survives quitting Kiri depends on the desktop's
clipboard manager. Screenshot annotations and OCR source images stay local;
the shared [privacy policy](../PRIVACY.md) also applies on Linux.

## Basic video editing

The current source supports trim, split/delete and reordering retained clips,
then exports a new MP4 with the source audio. Original files remain unchanged.
High quality, Everyday sharing and Compact file set output dimensions. Linux
applies rotation before export; audio becomes 48 kHz stereo AAC. Variable-rate
and held frames retain their presentation timing.
This path requires the installed GStreamer H.264/AAC plugins. It accepts one
progressive video track and at most one audio track, without subtitle tracks.

Speed changes, privacy masks, zoom, annotations and stickers remain unsupported.
A saved project containing them stays intact and read-only on Linux. This is
basic editing, not full macOS/Windows parity. See [video editing](video-editing.md)
and the [exact-package acceptance checklist](qa/linux-video-export.md); source
media tests alone do not close the Ubuntu/GNOME acceptance requirement.

## Build from source

Use Rust 1.88+, Node.js 20.19+ or 22.12+, and the pnpm version declared in
`package.json`. The Ubuntu build dependencies are:

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config \
  libxdo-dev libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf \
  libpipewire-0.3-dev libasound2-dev libpulse-dev libxcb-randr0-dev libgbm-dev libclang-dev \
  libtesseract-dev libleptonica-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav gstreamer1.0-pipewire \
  tesseract-ocr-eng tesseract-ocr-chi-sim tesseract-ocr-jpn

pnpm install --frozen-lockfile
pnpm tauri dev
```

Build an installable package from the repository root:

```bash
pnpm tauri build --bundles deb --config src-tauri/tauri.linux.conf.json
```

The package appears in `src-tauri/target/release/bundle/deb/`. Ubuntu 24.04
builds are not a claim of compatibility with older distributions. Keep the
Cargo target cache for subsequent builds. A plain `cargo build` executable
does not embed the production frontend; use the Tauri build command.

## Verification and acceptance

Run the shared checks first:

```bash
pnpm test:release-tools
pnpm build
cargo check --locked --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
git diff --check
```

Ordinary pull requests run the selected source checks without producing a
package. To build a candidate without desktop permission dialogs, choose the
`linux-package` workflow profile, or add the `ci:linux-package` label to the
pull request. The label adds Linux packaging to its ordinary required checks;
adding/removing it and subsequent source pushes recompute the plan. This lane
builds, installs, and inspects the `.deb` on Ubuntu 24.04 and uploads
`kiri-linux-deb` with the actual checkout SHA and package checksum in
`provenance.json`. It does not launch Kiri, run the X11 desktop harness, request
Portal permissions, or change GNOME settings. A green package-only run is not
desktop acceptance. PR builds use GitHub's merge checkout; compare its recorded
source to the intended branch before testing the artifact.

The `linux` and `full` profiles still select X11 and GNOME Wayland acceptance.
Those desktop runs require their separate test-session permission/setup scope.

The Ubuntu CI job is configured to build/install the `.deb`, inspect its linked
libraries, test system GStreamer encoding/merging/decoding/GIF conversion, and
exercise the installed app on an isolated X11 desktop. Run that desktop check
on Linux after installing a candidate:

```bash
sudo apt install xvfb openbox xdotool xclip x11-utils dbus-x11 python3-tk python3-pil \
  python3-gi python3-pyatspi at-spi2-core \
  gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0
bash scripts/qa/linux-native.sh /usr/bin/kiri
```

The script creates a new Xvfb display, DBus session, and disposable HOME/XDG
directories. Its WebKit renderer uses software rendering without compositing
for the virtual display; this does not exercise a physical GPU. A separate
normal X11 test window displays public text and gray
shapes. Kiri captures it with its shipping backend, then the script compares
the selected preview, saved and clipboard pixels, recognizes text through the OCR UI, and
checks restart persistence. Recording starts through the overlay and uses the
desktop commands to pause, resume, and stop. The exported MP4 is decoded with
system GStreamer to check its size, silent audio layout, duration, and frames:
both recorded scenes must appear, while the pause-only scene and recording
controls must be absent. There is no runtime synthetic-capture mode.
The overlay geometry check also adds an ordinary external dock with a 27-pixel
top strut. It verifies three fresh captures at the full display origin and
size, fullscreen state, cancellation, and an unchanged reserved workarea.
The dock exists only inside the disposable QA desktop.

`linux-native-review/report.json`, media, images, and logs are the evidence;
a configured workflow alone is not a passing result.

A separate GNOME Wayland CI job downloads the same run's `kiri-linux-deb`
artifact once it is available, including when the X11 desktop check fails.
Both desktop checks must pass. It installs the package on Ubuntu
24.04 and runs `bash scripts/qa/linux-wayland.sh /usr/bin/kiri`. The additional
GNOME test dependencies are listed at the top of that script. Each consent
scenario uses a fresh HOME/XDG profile, DBus session, and headless GNOME 46
desktop with one virtual monitor and software rendering. The four jobs apply
100%, 125%, 150%, and 200% through GNOME's monitor configuration and read the
result back; GTK scale environment overrides are removed. The logical desktop
stays 1280×800 while its physical pixel dimensions change.

The harness operates the real portal dialogs, checks screenshot denial,
approval, cancellation, and repeat capture, and compares preview and saved
pixels. A separate focused Wayland application receives the PNG clipboard and
the text recognized through Kiri's local OCR UI. Recording starts through the
GUI, requests ScreenCast consent, pauses, requests consent again on resume,
and stops through the public desktop commands. The complete MP4 is decoded to
check dimensions, timing, scene order, and the absence of paused frames or Kiri
controls. Another scenario denies ScreenCast and retries in the same process.

The `linux-wayland-review-scale-*` artifacts retain package identity, reports,
desktop images, video, decoded-frame evidence, and service logs even on failure.
These jobs are configured; passing evidence must come from their exact run.
They do not establish physical-display, hardware-graphics, or IME acceptance.

To iterate on desktop QA without rebuilding the app, dispatch the `build`
workflow with `linux_candidate_run_id` set to an earlier build run that produced
a successful `kiri-linux-deb` artifact. For example, replace `RUN_ID` below
with that run's numeric ID; use a different `--ref` to test another QA branch:

```bash
gh workflow run build.yml --ref main -f linux_candidate_run_id=RUN_ID
```

This mode runs only the four GNOME jobs against the existing package. It
verifies the package's actual checkout against the selected QA revision and
rejects changes outside the permitted QA, documentation, and workflow files.
The report records both revisions, the original run and artifact, the `.deb`
hash, and the workflow diff. It is a new desktop test of the specified package,
not a rebuild. Normal push and pull-request workflows still run all checks.

| Gate | Evidence to retain | Status boundary |
| --- | --- | --- |
| Rust/frontend checks | Logs for the exact commit | Required on each candidate |
| GStreamer media tests | `linux-media-review` artifact | In-process native encoding; no ScreenCast consent proof |
| `.deb` installation | Package SHA-256, control metadata, `ldd` output | CI install only; no public release implied |
| X11 desktop smoke | `linux-native-review` report, screenshots, OCR result, and MP4 | Virtual desktop; no GNOME Wayland proof |
| GNOME Wayland desktop CI | `linux-wayland-review-scale-*` reports, screenshots, and MP4 | Virtual GNOME at four scales; no physical-display, GPU, or IME proof |
| GNOME Wayland desktop | Exact installed package, display/scale, portal actions, sample exports | Pending manual acceptance |
| Ubuntu X11 hardware | Exact installed package and screenshot/recording samples | Pending manual acceptance |

For GNOME acceptance, verify screenshot approval, denial, cancellation, and
repeat capture; region move/resize, annotation and IME; clipboard paste into
another application; English/Chinese/Japanese local OCR; and recording consent,
pause/resume/stop, GIF conversion, timing, and absence of Kiri controls. Test the
multi-display rejection explicitly. Use a separate test user and public test
content; never point QA at an existing capture library. Record outcomes before
marking those gates complete in the [roadmap](../ROADMAP.md).

## Global Shortcuts Portal acceptance

Run the production protocol client's isolated wire tests separately:

```bash
cargo test --locked --manifest-path scripts/qa/portal-shortcuts/Cargo.toml -- --include-ignored
node --test scripts/portal-shortcuts.test.mjs
```

The wire harness requires `dbus-daemon` and permission to create private Unix
sockets. Its tests are explicitly ignored in ordinary application tests and
executed with `--include-ignored` by Linux CI. It does not use the desktop bus,
change a user's permission store, or prove any compositor behavior.

Before closing #47, record the exact commit, package SHA-256, installed desktop
entry, frontend/backend versions, session type, and evidence for each row.
All rows remain acceptance gates until that evidence is attached:

- Ubuntu 24.04 / GNOME 46 installed `.deb`: no Portal setup claimed; all three
  command bindings, Capture button and recording stop still work
- GNOME 48+ installed `.deb`: first approval, denial/cancel, partial binding,
  existing key conflict, remap/revoke while Settings is open and hidden
- A supported KDE installed `.deb` (or Hyprland once usable trigger metadata is
  implemented): the same cases; verify the
  actual backend/version rather than assuming a desktop name is sufficient
- Both supported desktops: real Capture, Pause/Resume and Stop activations;
  restart and restored permissions; service/session closure; explicit reconnect;
  no stale triggers, duplicate captures or unsolicited repeated permission UI
- Two concurrent launches: only the resident process owns a shortcuts session
- X11 installed `.deb`: native custom/default shortcuts and CLI control regression
- Check focus/transient-dialog placement with the protocol-valid empty parent
  identifier; verify translated desktop approval labels and application name

Label headless/virtual-desktop, isolated D-Bus, and physical-desktop results
separately. GNOME 46 CI and mocked D-Bus responses do not satisfy GNOME 48+
Portal keyboard/permission acceptance.

## MP4 audio

The recording options offer system sound, microphone, both mixed into one AAC
track, or no audio. GIF is always silent; choosing GIF does not clear the saved
MP4 audio choices. Kiri does not open audio devices when both options are off.

Linux needs a running local PulseAudio-compatible audio service (PulseAudio or
PipeWire-Pulse), the `libpulse0` client library, and the AAC encoder in
`gstreamer1.0-libav`. These plugins are declared by the `.deb`. ScreenCast
consent only grants access to the screen; it does not grant microphone access.
No permissions, audio routes, mute switches or default devices are changed.

System sound records the monitor of the output currently selected in desktop
sound settings. Microphone records the current unmuted non-monitor input. If
the default input is itself an output monitor, select a real input before
recording. Devices are pinned for each segment; disconnecting or rerouting a
source stops recording with an error rather than silently changing devices.
Resuming rechecks the current defaults. The five-second microphone check uses
the same source selection and inspects PCM in memory only.

The default tests inject tones into the real installed GStreamer
encoder/mixer/muxer and decode the resulting tracks. They do not establish
physical microphone, speaker, permission, or GNOME desktop acceptance. Run
`cargo test --locked --manifest-path src-tauri/Cargo.toml native_audio_long_recording_keeps_shared_clock -- --ignored`
for the additional 60-second shared-clock check. Installed Ubuntu 24.04 GNOME
X11 and Wayland each still need real-device record/playback, denied access,
unplug/reconnect, default-device change, cancellation, restart and pause/resume
checks with the actual sound server. Synthetic input must be reported separately.

For a separate synthetic Pulse integration check on a host that permits private
Unix sockets, install `pulseaudio` and `gstreamer1.0-pulseaudio`, then run
`bash scripts/qa/linux-audio.sh`. It creates authenticated temporary sources,
records them through the real libpulse path, verifies decoded tones and the
microphone meter, and removes the private server afterward. It never accesses
the desktop sound devices. CI runs this explicitly; a blocked local socket
must be reported as unverified rather than bypassed.

The FIFO monitor regression has a separate harness,
`bash scripts/qa/linux-audio-fifo.sh`. It creates a private 48 kHz stereo s16le
`fifo_output`, verifies generated 440 Hz playback, then checks system-only AAC,
pause/resume merging and a silent control. To exercise the installed app on an
isolated X11 desktop, run `bash scripts/qa/linux-audio-fifo.sh /usr/bin/kiri`.
Neither mode opens a physical microphone. See the
[issue #101 investigation](qa/linux-fifo-system-audio.md) for the timing evidence
and acceptance boundaries.
