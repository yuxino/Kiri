# ADR 0096: Keep new screenshot references at their capture region

- Status: Accepted
- Date: 2026-10-12
- Partially supersedes: ADR 0081's initial 680 × 480 reference fitting

## Context

Issue #143 shows a direct screenshot pin opening at the default window origin,
away from its selected region. Using PNG pixels as window points also enlarges
Retina references relative to their original selection.

## Decision

- Remember the validated selection's global logical frame, backing scale and
  saved pixel dimensions after a successful screenshot import.
- Keep at most 64 origins in memory. No screen positions are added to the
  persistent library, image files or editable documents.
- A new reference for a recent screenshot uses the originating position and
  logical selection size. Windows applies physical geometry before showing the
  window, avoiding mixed-DPI monitor selection by the logical builder.
- Tiny selections retain the existing 80 × 60 minimum and stay on their display.
- Imported/older images, changed image dimensions and unavailable or rescaled
  displays keep the existing fitted-reference behavior. Restart clears origins.
- Repinning an existing reference keeps its user-adjusted position and size.
- Overlay destruction, clipboard-first completion, annotation persistence and
  pin-failure completion-card recovery retain their existing routes.

## Consequences

Direct and completion-card references for a new screenshot line up with the
original region on macOS, Windows and X11. Wayland top-level positions remain
compositor-controlled; this change cannot enforce placement there.
