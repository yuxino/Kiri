# ADR 0104: Windows recording follows active elapsed time

- Status: Accepted
- Date: 2026-10-13

## Decision

Windows Graphics Capture can deliver fewer frames when a desktop is unchanged.
Counting each callback as one 30 fps frame shortens static recordings. The native
Windows encoder keeps one latest frame and fills the existing constant frame-rate
timeline from an active monotonic clock. It does not accumulate frame history.

Pause freezes this clock; resume continues it. Stop freezes it before native
capture shutdown and input drain, so paused time and finalization cannot extend
the output. Cancellation still discards the owned temporary file. Existing audio
queue latency and fault checks remain required. macOS and Linux encoders retain
their existing behavior.

## Verification

The cloud Windows Server 2025 test showed more than 30 seconds on the recording
controls but about two seconds in the saved video. This is independent of issue
#151's unconfirmed startup-error cause. Regression coverage supplies exactly one
frame to the real Windows Media Foundation encoder, includes a pause, and checks
that the probed MP4 duration matches active elapsed time. Desktop acceptance also
checks a static recording through start, pause, resume, stop and playback.
