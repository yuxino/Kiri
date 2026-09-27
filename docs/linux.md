# Linux (experimental)

The initial target is **Ubuntu 24.04 x64 with GNOME**, with X11 compatibility.
This guide describes the current source and candidate `.deb` packaging. It
does not announce a Linux release or claim completed GNOME desktop acceptance.
Check [the actual release assets](https://github.com/yuxino/kiri/releases)
before assuming a published Linux package is available.

## Install and update

Build the package below, or download the `kiri-linux-deb` artifact from a
successful [build workflow](../.github/workflows/build.yml) for the exact
revision you want to test. Extract the artifact ZIP, then install the `.deb`:

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

The current Wayland implementation requires **one connected display**. It
rejects multiple displays before capture rather than guessing which screen
belongs to a portal image. Select a region by dragging; Wayland window hover
outlines and click-to-select windows are unavailable.

GNOME may show a Screenshot permission dialog. Allow the screenshot and return
to Kiri's selection overlay. Cancel closes the request without saving. On
compatible wlroots desktops, installed `grim` may provide the still screenshot;
it is optional and is not required on GNOME.

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
| Recording | Silent MP4 or GIF, optional pointer, tray/command controls | Portal consent, pause/resume, timing, and control exclusion on real GNOME |
| Audio and click highlights | Unavailable | No system audio, microphone, microphone check, or click ripple |
| Saved videos | Playback, thumbnails, GIF conversion | System GStreamer codecs required; no video editing/MP4 export UI |
| Updates | Manual replacement `.deb` | No Linux in-app installation or signed updater feed |

GTK retains clipboard ownership after capture closes while Kiri is running.
Whether clipboard content survives quitting Kiri depends on the desktop's
clipboard manager. Screenshot annotations and OCR source images stay local;
the shared [privacy policy](../PRIVACY.md) also applies on Linux.

## Build from source

Use Rust 1.88+, Node.js 20.19+ or 22.12+, and the pnpm version declared in
`package.json`. The Ubuntu build dependencies are:

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config \
  libxdo-dev libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf \
  libpipewire-0.3-dev libasound2-dev libxcb-randr0-dev libgbm-dev libclang-dev \
  libtesseract-dev libleptonica-dev \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav gstreamer1.0-pipewire \
  tesseract-ocr-eng tesseract-ocr-chi-sim tesseract-ocr-jpn

pnpm install --frozen-lockfile
pnpm tauri dev
```

Build an installable candidate from the repository root:

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
