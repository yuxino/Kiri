# ADR 0087: Keep capture controls clear of the mode selector

Status: Accepted

## Context

The movable mode selector and capture controls share one overlay. Independent
height estimates let recording options overlap the Screenshot button; clicking
MP4 then changed modes instead of choosing a format. Translated and wrapped
controls also need usable space at display edges.

## Decision

- Measure the visible mode selector and each panel after layout and resize.
- Keep the screenshot toolbar and its settings within the display and clear of
  the mode selector. Only visible HUD rows receive pointer input.
- Place recording and OCR panels in available space around the selection,
  avoiding the mode selector. Constrain their width and height to that space.
- Recording options scroll inside the panel; Start and Cancel remain outside
  that scroll area. OCR text and consent content can scroll when needed.
- Moving or measuring OCR consent never sends a request. Remote OCR remains an
  explicit action after the user reviews the consent panel.
- Omit decorative panel tails because constrained and side placement cannot
  consistently point them at the selected region.

## Verification

Regressions retain the failed installed X11 selection geometry and cover narrow
wrapped modes, moved modes, edge selections, constrained content, and explicit
OCR actions. Built UI checks verify panel hit targets and scrolling; final
installed package checks verify recording and OCR through native capture.
