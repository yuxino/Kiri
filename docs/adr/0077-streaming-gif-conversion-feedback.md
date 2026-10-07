# 0077 — Streaming GIF conversion and operation feedback

Status: accepted

## Context

Saved-video GIF conversion reported only start/end events. Immediate command
errors were discarded by the library, and repeated background failures could
be hidden by global error deduplication. Completion feedback showed only a
short generic failure notice. macOS ImageIO accumulated GIF frames until
finalization: an isolated generated 60-second, 320×320 input reached about
808 MiB peak RSS. This establishes a memory-growth problem, not the cause of
any particular user video failure.

## Decision

- Keep AVFoundation decoding and the existing 720-pixel, 12-fps policy. Encode
  each scaled frame with the existing Rust GIF encoder before decoding the next.
  Preserve the shared centisecond clock, looping, dimensions and orientation.
- Use an automatically cleaned temporary GIF, retaining it only after encoding
  and flushing succeed. Keep the source video unchanged.
- Publish per-asset preparing, encoding, finalizing, saving and terminal states.
  macOS reports encoded-frame fractions, throttled to at most five updates per
  second except the final frame. Other native pipelines remain indeterminate
  until they support measured progress. Never substitute elapsed-time estimates.
- Subscribe before reading an active-conversion snapshot. Ignore a stale
  snapshot after a newer event. Keep duplicate conversion requests blocked.
- Show immediate and background errors per operation, independently of global
  deduplication. Preserve decoder frame/time context and chained write/import
  errors. Library errors remain until retry/dismiss; completion errors stay
  interactive until retry, dismiss, Escape, or replacement by new feedback.

## Verification boundary

Native generated fixtures exercise encoding, GIF decoding, pixels, timing,
progress and invalid-source failure. Component regressions exercise progress,
retry, repeated failures and snapshot races. These do not establish the exact
cause of a private user video failure or physical Windows/Linux acceptance.
