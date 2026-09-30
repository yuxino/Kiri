# macOS recording geometry audit

Base: `1851f58` (v1.6.6). Related tracking: #21; this audit does not close
physical multi-display acceptance. The code change applies only to macOS.

## Confirmed source defect and isolated regression

The frozen selection stores the display ID, global logical frame and backing
scale. Before this change, recording resolves only the display ID. The same
ID can remain available after changing resolution, scale, monitor position or
the primary display. SCK then receives the old local crop and output scale,
and recording controls use the old global frame.

The fix passes the frozen frame to the native recorder and resolves the same
NSScreen on the main thread immediately before creating the SCK filter. A
frame or backing-scale mismatch prevents starting a new stream, including on
resume. Known errors appear in the normal error notice with explicit guidance
to start a new capture. On a failed resume, the notice first tells the user to
stop and save the paused recording, since Capture remains blocked while
a recording is paused. Unrelated native errors retain the generic notice.

| Isolated boundary | Before | After |
| --- | --- | --- |
| Same ID, unchanged negative origin and 2× scale | Accepted | Accepted |
| Same ID, different horizontal or vertical origin | Accepted without geometry check | Rejected with retry guidance |
| Same ID, different logical width/height | Accepted without geometry check | Rejected with retry guidance |
| Same ID, backing scale changes 2× → 1× | Accepted without geometry check | Rejected with retry guidance |
| Invalid backing scale | No geometry check | Rejected |
| Known geometry/disconnect notice | Generic start failure | Localized retry guidance |
| Other native errors | Generic start failure | Generic start failure |

These are injected geometry tests, not physical display tests or simulated
screenshots. No synthetic capture mode was added to Kiri. A same-ID reconnect
with identical geometry is not distinguished; the guard does not establish
monitor serial-number identity. Display changes after filter validation remain
a native-stream/runtime boundary.

## Test matrix and evidence limits

The read-only Mac inventory reported one active built-in display, with a
1512×982 logical CoreGraphics frame. No external display was connected. The
inventory therefore provides no physical mixed-DPI evidence. The actual
backing scale must be read through AppKit; CGDisplayPixelsWide alone is not
proof of the captured Retina image dimensions.

| Surface | Audit or verification | Remaining native acceptance |
| --- | --- | --- |
| Logical/physical coordinates | Mac uses AppKit points, converted through the CG main-display baseline; frozen PNG dimensions are separate | Multiple real monitors with different scale factors |
| Negative origin / default display | Existing AppKit conversion tests plus new recording geometry checks | Real left/above layouts and primary-display switch |
| Cross-screen selection | One display is frozen; hovered windows are intersected with that display | Cross-screen composition is not an existing feature |
| OCR bounds | Existing crop checks validate finite local selections and PNG dimensions; backing-scale fixture tests run | Real fractional-size edge regions and local OCR |
| Recording crop / controls | SCK sourceRect is display-local in points; Kiri process excluded except ripple; new guard rejects stale geometry | Extract exported native frames at start/pause/resume/stop |
| Disconnect / reconnect | Missing display ID already rejected; geometry mismatch now rejected | Actual unplug/replug and same-geometry reconnect |
| Linux | Ubuntu 24.04 GNOME supported; Wayland rejects multiple connected displays | Physical mixed-scale Ubuntu GNOME; cloud Debian X11 is a separate environment |

A public full-screen test-pattern window was launched and then closed without
capturing or recording. Native before/after screenshots and fixed-path signed
package interaction have **not** been completed. No real display layout,
resolution, permission identity or user capture library was changed by this
audit. Do not use a fixture screenshot as proof of hardware acceptance.
