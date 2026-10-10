# ADR 0086: Managed file actions match the saved asset

Status: accepted

## Context

The library can move to a user-selected local directory. On Windows, passing a
combined `/select,<path>` argument through process quoting can send Explorer to
its default directory instead. Display-only titles also leave files named with
UUIDs, and copying screenshot pixels does not offer a file for folder paste.

## Decision

- Open Folder opens the active managed library root. Show in Folder selects the
  current indexed asset inside its Assets directory. Windows uses literal Shell
  paths and item ID lists, with a dedicated COM apartment and reported errors.
  Canonicalized extended-length filesystem paths are normalized to DOS/UNC
  Shell paths through UTF-16 without changing the persisted library location.
- Rename changes both the display title and managed filename, preserving the
  existing extension. Names are portable across the supported operating systems;
  invalid names and case-insensitive conflicts are rejected without overwrite.
  Clearing a custom title restores the generated capture filename; unnamed
  legacy files keep their existing filename.
- Publish a non-overwriting new path before atomically committing the index,
  then remove the old path. A failed index write preserves the original asset;
  committed cleanup/synchronization failures refresh the UI and report the
  precise remaining operation. Filesystems without hard links use a verified,
  non-overwriting copy retaining the modification timestamp.
- Asset IDs, annotation sources, thumbnails, video project paths, and Trash
  state remain stable. A filename change does not change a video source's
  content identity or autosave revision. Its other identity fields remain strict.
  Existing media requests retain opened file handles, and rename shares the
  thumbnail-generation barrier. An active GIF conversion blocks rename until
  it has finished or cancelled.
- Copy keeps its image-pixel behavior. Copy File is an explicit library/viewer
  action offering the saved image, video, or GIF to the native file clipboard.
  Windows clears previous formats and offers CF_HDROP with an explicit COPY
  drop effect, so a prior Cut action cannot turn a copy into a move.

## Verification

Portable tests cover index failure, collisions, invalid names, extension and
sidecar preservation, Trash, open media streams, and existing video drafts.
The installed Windows CI application is separately exercised with a generated
library whose root contains Chinese characters, spaces, and a comma. Explorer's
actual folder and selected item are checked, and real file-manager paste must
produce byte-identical files while retaining the managed originals. These
checks do not close the reporter's issue or establish every desktop environment.
