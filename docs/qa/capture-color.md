# Screenshot hover color QA

The isolated harness mounts the production overlay with Tauri's test IPC mocks
and a generated frozen PNG. No native capture session, user library or actual
clipboard is accessed. It has black/near-black, white and colored quadrants,
plus one `#102030` pixel at physical position (200, 200).

```sh
pnpm exec vite --config scripts/qa/capture-color-harness.vite.ts
# Open http://127.0.0.1:5190/scripts/qa/capture-color-harness.html?lang=zh-Hans&scale=2
node --test scripts/capture-color.test.mjs
```

Query options: `lang` is any supported language, `scale` specifies generated
pixel density, and `failCopy` simulates a native clipboard failure. Inspect
`window.__colorQa.actions` for isolated command receipts.

Acceptance checks:

- Hover each quadrant and the exact single pixel, including every screen corner.
  Compare pixel coordinates and HEX against the fixture before and after selection.
- Press Cmd+C / Ctrl+C: exactly one `copy_capture_color` action, with no capture
  confirmation or cancellation. Hold the key and test a fast move before copy.
- Drag, move and resize a region: no loupe during the gesture. Hover the toolbar
  and mode selector: no stale sample. Switching to Record/OCR or an annotation
  tool hides it; Return and double-click still confirm screenshots.
- Copy inside a dimension input and annotation text: keep native editing.
  Check copy failure, all seven languages, and Retina/fractional density.

Native macOS requires the fixed-path stable-signed package and a real frozen
screen. Windows CI, the Ubuntu `.deb`/X11 job, mixed-scale displays and GNOME
Wayland remain separate acceptance checks; browser pixels do not prove those.

## Installed Windows desktop acceptance

Dispatch the build workflow on this change's branch with `profile=windows`:

```sh
gh workflow run build.yml --ref feat/screenshot-hover-color-picker -f profile=windows
```

The `package_windows` route builds and installs NSIS, verifies the portable ZIP,
and then runs `windows-capture-color-native.py` against that installed executable.
A separate Tk process paints known public pixels; the global shortcut opens the
shipping capture backend. The script reads the loupe's accessible HEX/coordinates,
compares them to physical source pixels and the native Unicode clipboard, verifies
selection/overlay retention and Escape focus restoration, and checks dimension
and annotation text copying plus Record/OCR mode isolation. It never starts an
actual recording or sends OCR content to a provider. Evidence is uploaded as
`windows-capture-color-review`, including screenshots, UIA controls, executable
checksum, source SHA, clipboard receipts, application logs and failure diagnostics.
This standard hosted desktop does not establish mixed-DPI hardware acceptance.

For a QA-only correction after a package run, reuse its identical executable:

```sh
gh workflow run build.yml --ref feat/screenshot-hover-color-picker -f profile=quick \
  -f windows_color_candidate_run_id=38024060740
```

The candidate verifier requires the official completed dispatch, successful build,
package/install and existing native checks, and no failed Windows step except the
color QA step. It rejects application or packaging source changes, compares the
downloaded executable checksum to the original installed QA receipt, and records
candidate/source/harness provenance. This route tests the previously installed
bytes; it does not rebuild or create a signed release package.

## 2026-10-10 local verification

- Based on main `f9db76c` (v1.6.14), on macOS 27.0.1.
- `pnpm test:release-tools`: 344 passed, including four color geometry/shortcut
  tests and all seven dictionary key/placeholder checks.
- Real-overlay browser checks passed: `#000302` leading zeros; the exact
  `#102030` pixel; Cmd+C and Ctrl+C; copying before the next animation frame;
  repeat suppression; drag hiding; toolbar hiding; input copying; annotation
  copying; Return and double-click completion; Record/OCR hiding; Escape.
- All seven languages passed four-corner layout/color checks at 1.25× density.
  2× density, a 640×480 viewport and Japanese copy-failure layout also passed.
- `cargo check` passed. `cargo test` outside the sandbox passed 329 tests, failed
  one and ignored one. The unchanged video-export test
  `native_annotations_follow_live_frames_and_independent_time_ranges` also
  failed alone at `video_export.rs:1843`, on the blue-channel contrast assertion
  after the annotation ends. This work does not change video/media source files.
  An isolated unmodified main at the same base commit also reproduces that
  assertion locally; the original PR's macOS Rust job passes in CI.
- The local arm64 `.app` bundled successfully and passed strict/deep codesign
  verification outside the sandbox. Its designated requirement matches the
  installed `io.yuxino.kiri` identity. The packaging command then failed at
  updater-archive signing because no updater private key was supplied; the
  verified app is not a signed updater or release artifact.
- Fixed-path installation and native WebView/clipboard acceptance were deferred
  at the user's request to preserve the current application while other Kiri
  chats are working. The installed app was not replaced or restarted. Browser
  acceptance does not establish native macOS capture or permission continuity.
- The default sandbox cannot run native media/OCR services or the loopback
  playback listener. Set `CFLAGS=-fmodules-cache-path=<workspace>/src-tauri/target/clang-cache`
  for its writable Clang module cache; native test execution additionally needs
  access to those operating-system services.
- Windows Actions and Ubuntu `.deb`/X11 acceptance have not run for this
  change at the time of local verification. Mixed-scale hardware and GNOME Wayland remain unverified.
