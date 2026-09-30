# Capture toolbar viewport regression (#65)

## Actual native before

![Official v1.6.6 toolbar clipped on the secondary display](before-linux-x11-800x600.png)

This unedited 800×600 screenshot was collected from the official v1.6.6 amd64
Debian package on a cloud Debian 13 / Xfce / X11 desktop with an empty QA profile.
The content is a public test background. Debian 13 / Xfce is outside the documented
Ubuntu 24.04 / GNOME support target.

- Primary virtual output: DUMMY0, 1364×1024 at (0, 0).
- Secondary virtual output: DUMMY1, 800×600 at (1364, 0).
- Both outputs use scale 1. This is virtual mixed-resolution evidence, not physical mixed DPI.
- Capture on DUMMY1: local region (650, 420) to (790, 580), 140×160.
- Toolbar's Done button is clipped and the toolbar overlaps the region's top edge.
- Return saves the correct region; mouse Done is the regression under test.
- Release package SHA256: `3de2f5aaabea99233ba06ac5df14ecf255ad82c3c222e052929f2affca9d4895`.
- Linux package source: `78111e9c0ca39bc055f4a164d2ee9f8d3e192f26` (package provenance, not release target).
- PNG SHA256: `40c22c1279e26825dc0d33285f30ca6a892fdf7de20a46472a3642b6c82edb4a`.

## Fix and automated checks

The toolbar wraps when its natural width exceeds the overlay's logical width
minus an 8-point margin on each side. ResizeObserver measures its full width and
height; placement chooses below or above the selected region using that measured
height and clamps it inside the viewport. Wide displays retain a single row.

- `scripts/toolbar-layout.test.mjs`: original bottom-right region, wide display,
  all corners at 640×480 / 800×600 / 1512×982, changed heights and nonzero bounds.
- `docs/demos/full-flow/test_toolbar.py`: the actual built frontend with the
  documentation-only IPC boundary. Checks all controls at four corners across
  those three logical sizes, scale 1 / 1.5 / 2 and English / Chinese / Japanese;
  rechecks after Text / Mosaic / Pen / Select transitions and clicks Done.
  This does not test native display selection, physical backing pixels, OCR,
  clipboard ownership or native PNG output. Its screenshot is a **renderer
  fixture**, not the actual native after image.

## Actual native after

Pending the CI-built candidate's Linux cloud replay. Use the same two outputs,
English UI, scale 1 and (650, 420) to (790, 580) selection. Record the candidate's
source commit, package SHA256 and provenance, save an unedited screenshot, then
click Done and verify the resulting 140×160 PNG. Restore the original virtual
layout afterward. Do not label renderer fixtures as native after evidence.

Physical mixed-DPI, macOS/Windows native toolbar acceptance and supported Ubuntu
native confirmation remain separate coverage limits. This PR does not change
capture coordinates or supported platforms.
