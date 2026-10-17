# Scrolling screenshot desktop acceptance

The installed Linux app passed the scrolling screenshot checks at runtime commit
`e0bacf6a6895dddd8b725651f070234ddb527fc0`. The screenshots below contain only
the generated public test page. They were copied without visual edits.

The debug `.deb` was built and installed in an Ubuntu 24.04 container. Each run
used a separate Xvfb display, Openbox session, session bus, and disposable HOME/XDG
profile. Kiri captured a separate, fullscreen GTK source window through its
ordinary native X11 backend. No synthetic capture mode was added to the app.

The final checks cover:

- Global Escape cancellation from the source app, followed by another capture.
- Five 96-pixel wheel scrolls, reverse scrolling, and reconnection. The saved
  760 × 960 image matches every expected RGB pixel; missing or duplicated rows
  fail the comparison.
- Native clipboard pixels, opaque PNG alpha, and a visibly painted preview.
- Refusal to join a fixed header, explicit partial-save confirmation, adjustment,
  cancellation, and exact pixels when the captured portion is explicitly saved.
- Capture shortcut focus on the floating panel, Enter completion, and return of
  keyboard focus to the exact source window after completion and cancellation.

[report.json](report.json) contains the final assertions and pixel hashes.
[provenance.json](provenance.json) binds the source, harness, package, installed
binary, and evidence hashes. The harness/evidence commit follows the runtime
commit; its content hashes are recorded without a circular commit reference.

| Evidence | What it shows |
| --- | --- |
| [Initial capture](scroll-initial.png) | Controls and a real preview above the fullscreen source |
| [Extended capture](scroll-extended.png) | The 760 × 960 result before completion |
| [Rejected fixed header](fixed-header-rejected.png) | An uncertain frame is withheld |
| [Saved long PNG](saved-scroll.png) | Opaque RGBA output, with exact source pixels |

The final runtime also passed 416 Rust tests, with zero failures and 10 ignored
tests, `cargo check --all-targets`, and the frontend build performed during
packaging. The existing Linux desktop regression passed 17 checks during this
implementation; its preceding candidate and scope are identified separately in
the provenance record.

To reproduce on an Ubuntu X11 test machine with the repository's Linux build and
QA dependencies installed:

```sh
pnpm tauri build --debug --bundles deb --config src-tauri/tauri.linux.conf.json
sudo apt-get install ./src-tauri/target/debug/bundle/deb/kiri_1.6.20_amd64.deb
bash scripts/qa/linux-scroll-native.sh /usr/bin/kiri
```

This is software-rendered X11 acceptance at 1280 × 800 and scale 1. WebKit
compositing was disabled only in the isolated QA process tree because Xvfb has
no hardware compositor. These results do not establish macOS or Windows native
acceptance, GNOME Wayland portal behavior, physical desktop/compositor behavior,
fractional scaling, or mixed-scale multiple displays. Scrolling capture currently
remains unavailable on Wayland.
