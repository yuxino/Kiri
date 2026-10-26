# ADR 0122: Preserve local state during recovery

Status: accepted.

## Context

An operation can finish before its refreshed library snapshot arrives, while a
failed operation can leave a window displaying a transient state. Media playback
failure must not dispose an editor's unsaved document or its close protection.
These rules extend [ADR 0121](0121-failure-recovery-and-action-ownership.md).

## Decision

- Successful single and batch favorite changes update the current library
  snapshot immediately. A fresh read supersedes earlier requests; failed writes
  retain the previous value. Cards and the Favorites filter use that same snapshot.
- Both moving and locating a library notify subscribers after activation finishes,
  including a failed location-config write. Notifications run after releasing
  the library lock; only successful activation clears thumbnail caches.
- Language, annotation appearance and recording preferences use complete,
  same-directory staged writes and atomic replacement. Recording preference
  persistence and in-memory publication share one lock, with publication only
  after successful persistence. Failure to remember a recording's options does
  not cancel that requested recording or replace the last saved preference.
- Settings loads OCR profiles on the first visit to Text Recognition, retaining
  the existing explicit retry and settings-session cache. Other settings pages
  do not need to query credential storage.
- A video's decoder failure keeps its editor, pending saves, undo history and
  close preparation alive. The error view suspends playback and editor input.
  Retry waits for saving and validates the source/project revision before
  reloading the decoder; it does not reset the edit document. An incompatible
  source retains the draft and fails recovery. Closing still saves, or requires
  the existing explicit discard action when saving fails.

## Verification boundary

Deferred renderer requests cover acknowledged favorites, lazy OCR settings and
video save/close/retry ownership. Temporary library and preference files cover
failed writes, source preservation and retry without accessing user data.
Browser checks use the real components with isolated IPC fixtures. They do not
establish installed-app failure recovery, hardware media decoding, or native
Windows/Linux acceptance.
