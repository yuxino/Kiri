# ADR 0102: Visible, recoverable recording startup failures

- Status: Accepted
- Date: 2026-10-13

## Decision

A current recording startup failure first returns its owned session to idle,
then presents a persistent, dismissible failure card on the capture display
without activating Kiri. The main-panel error banner and its existing permission
recovery actions remain available. Cancelled or replaced startup tokens cannot
present stale failures. Native error details remain in private diagnostics;
only known device/display recovery messages cross the UI boundary.

Failure cards without an asset offer Open Library and Close. They do not offer
a GIF Retry action for an asset that was never created. The native feedback
window uses the failed-card height before presenting it.

Windows recording queries whether IsBorderRequired can be controlled. Only
supported builds request borderless capture; unsupported/query-failed builds
keep the system default. Optional indicator control must not prevent recording.
Other requested capture/audio options remain explicit and are not silently disabled.

## Evidence boundary

The feedback in issue #151 shows a generic startup error only inside the main
panel. Its underlying cause is not yet confirmed without the reporter's native
error log. The SDK's unsupported-border rejection is independently evidenced in
windows-capture 2.0 and fixed here; it is not proof of that reporter's root cause.
