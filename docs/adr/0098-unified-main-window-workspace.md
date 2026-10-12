# ADR 0098: Unified main-window workspace

- Status: Proposed
- Date: 2026-10-12
- Extends: ADR 0015 and ADR 0097

## Context

Global navigation shared a wrapping row with capture import, selection and
search actions. Library and Trash therefore changed header structure as controls
or translations changed. Text and QR details placed actions at different
positions, while Settings duplicated the outer title and left a wide empty
area beside an independently centered column.

## Decision

Use one persistent sidebar for the five existing main-window destinations and
one workspace header with a common title, summary and page gutter. Contextual
capture filters/search remain separate from navigation. Batch actions occupy a
normal toolbar row above the grid and never obscure its last captures.

Text History and QR Favorites share list/detail proportions and place record
metadata and actions together at the top of the detail. QR content and its image
form one content group. Existing capture/editor QR and OCR results retain their
existing action policies.

Settings shows General in the left column, OCR and About in the right column.
It uses the available workspace width and stacks sections when that content
becomes narrow. Rows wrap according to section width, including long translated
button labels. Related General rows share one group with simple dividers; the
redundant title and oversized empty OCR panel are removed.

Preserve ADR 0015's system typography, monochrome tokens and unchanged brand
artwork. Keep destructive controls in the destination that owns them. Selection,
search, editing and native window commands retain their existing behavior.
Panel-open update discovery is specified separately in ADR 0099.

## Verification and consequences

Review the real components in the isolated renderer harness at wide and narrow
sizes in all seven languages. Use only public fixture media; user libraries are
never copied into this harness. Exercise navigation after Trash, search,
selection, text editing and copying. Verify compact and populated OCR profile
states, loading/errors, scrolling, focus and reduced-motion behavior.

This changes the main window's information hierarchy and needs owner review
before merging. Renderer evidence establishes layout and browser interaction;
it does not establish packaged-app acceptance or real desktop capture behavior.
