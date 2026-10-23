# ADR 0116: Pending library and editor actions

Status: accepted.

## Context

Background review reproduced stale library cards receiving Trash actions during
slow navigation, silent single-item mutation failures, lost OCR correction
drafts, playback shortcuts intercepting focused controls, and exports racing
with an image sticker that was still decoding.

## Decision

- Library snapshots belong to their search query and Library/Trash scope. A new
  scope shows loading until its own result arrives; same-scope refreshes retain
  their last snapshot. Older replies cannot replace a newer request.
- Failed favorite, Move to Trash, and Restore actions report a localized error
  through the existing library feedback. Favorite writes have one pending
  operation; a double-click never adds a third submission.
- Text History keeps its current correction and original save revision while a
  record refresh completes or fails. Search and record switching pause until
  Save or Cancel. A pending save also disables typing and cancellation; failure
  retains the draft for retry. Saving remains explicit. These are in-memory
  editor protections, not draft persistence across main navigation or shutdown.
- Input-method composition owns Escape in Text History and OCR profile forms.
  Native composition flags, key code 229, and composition lifecycle events all
  preserve the draft. Ordinary Escape retains its explicit cancel behavior.
- Plain video playback shortcuts yield to handled events, input methods,
  modified keys, links, buttons, menus and dialogs.
- A selected sticker has one pending decode. Document-changing controls and
  export wait for it; normal viewer close awaits decoding and the final project
  save. Failed decoding permits retry, and an unmounted or replaced document
  ignores its late result. The existing status area reports loading without
  pretending an export has started.

## Verification boundary

Focused renderer regressions use generated records and deferred promises with
mocked IPC. They exercise the actual component handlers without launching the
app or accessing a capture library. Frontend build, Rust tests and compilation
are separate checks. Native WebView input-method behavior, installed-app UI and
Windows/Linux device acceptance still require a desktop session; this task's
no-interruption constraint does not authorize launching, replacing or capturing
an installed app.
