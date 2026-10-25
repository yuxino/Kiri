# ADR 0121: Failure recovery and action ownership

Status: accepted.

## Context

A failed operation must not consume the state needed to retry it, expose
another search's actions, or abandon a completed temporary file. These
boundaries extend the pending-action protections in
[ADR 0116](0116-pending-library-and-editor-actions.md) and preserve the capture
completion and pinning order in
[ADR 0119](0119-readable-pinned-screenshots-and-scroll-pin.md).

## Decision

- Keep the active screenshot session, staged annotations and frozen-image
  resource until library saving succeeds. A save failure leaves the live
  overlay able to retry or cancel. Only success consumes that capture and
  invalidates its resources; a canceled or destroyed owner must not be
  resurrected. For a live overlay, the successful IPC response still precedes
  its closing, followed by the existing focus restoration and completion or
  pin presentation.
- Bind QR Favorites result snapshots and failure states to the query that
  requested them. Changing the query hides the old records, details and
  actions until matching results arrive. A refresh for the same query keeps
  its acknowledged snapshot while pending. Obsolete replies cannot replace a
  newer query's results or failure state.
- Take `TempPath` ownership of a completed GIF immediately after encoding,
  before fallible metadata lookup, recording-recovery preparation or library
  import. Those steps borrow the owned path. Every return drops and cleans
  the temporary GIF, including after successful import; failure cleanup never
  deletes the source MP4. Existing MP4 fallback and recording recovery remain
  responsible for preserving a recording when GIF finalization fails.

## Verification boundary

Injected save failures, deferred renderer requests and temporary-file fixtures
exercise retry ownership, query changes and output cleanup without accessing a
user's capture library. Successful screenshot completion must retain its
response-before-close ordering. These checks do not replace installed-app
failure recovery, native window/focus or platform media acceptance.
