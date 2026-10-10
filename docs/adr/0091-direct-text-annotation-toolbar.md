# ADR 0091: Direct text annotation toolbar buttons

Status: Accepted

## Context

The shared text-tool picker hides numbered callouts and label bubbles behind an
arrow menu. Users need to choose these annotations directly while capturing or
editing an image.

## Decision

- Give Text (T), Numbered callout (N), and Label bubble (B) separate buttons in
  both the screenshot toolbar and saved-image editor. Each has its own icon,
  translated accessible name, and selected state.
- Keep the existing T, N, and B shortcuts and inline editing behavior. Selecting
  a toolbar button changes the tool; Enter or Space on that button must not
  complete a screenshot.
- Let annotation groups wrap at constrained widths so every button remains
  visible and reachable. Keep property controls and capture completion actions
  usable without horizontal overflow.
- Supersede only the shared-picker entry points in ADRs 0083 and 0084. Mark
  formats, local appearance preferences, undo history, crop, and export continue
  through their existing paths; no saved-document migration is needed.

## Verification

Exercise the three buttons and shortcuts in the capture overlay and saved-image
editor. Check their selected state, draft commit when switching tools, and native
button keyboard activation. Verify all seven languages at narrow widths and
display edges, including wrapped rows and reachable completion controls. Preserve
the separate installed-app checks for capture, focus, IME, and clipboard behavior.
