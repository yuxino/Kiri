# ADR 0094: Screenshot-toolbar OCR and annotation layer order

- Status: Accepted
- Date: 2026-10-12
- References: issues #137 and #138
- Supersedes: ADR 0088's fixed watermark-above-annotations rule and global mosaic sorting

## Context

Screenshot mosaics sampled only the clean capture and were rendered before other
annotations. Later masks could not conceal earlier text or numbered notes. A
watermark always rendered above later objects even though selection tested the
persisted array from front to back. Screenshot OCR was available only through
the capture-mode selector.

## Decision

- Add the existing text-viewfinder action to the screenshot toolbar. It uses the
  existing OCR mode switch and the committed region. Local recognition stays
  local; remote profiles still require the existing explicit Send confirmation.
- Draw annotations, including watermarks, in persisted creation order. A mosaic
  samples the composition below it. Later text or shapes remain above the mask.
- Consecutive mosaic strokes share one sampling snapshot and deterministic
  strongest coverage within that group. Intervening annotations break the group;
  sorting never moves a mask across another object.
- At preview time, layered mosaics composite at source resolution before mapping
  to the viewport. Copy, save, crop and reopen use the same PNG renderer.
- Isolate each mark's Canvas state. Drag and style edits replace a mark at its
  existing index; undo/redo and persistence keep that order. Selection continues
  to choose the newest overlapping mark. A mosaic group can still select its
  newest editable stroke even where a stronger earlier stroke protects coverage.
- Video retains explicit, user-reorderable layers and historical ordering for
  documents without layer metadata. This change does not migrate video projects.

## Verification

Exercise pixel and blur styles, brush/rectangle/ellipse coverage, text, labels,
numbered notes, pen, rectangle, line, arrow and watermark at uniform and differing
pixel scales. Compare redaction against independently flattened lower layers;
check drafts, interleaved masks, preview/export and persisted replay. Preserve
strong-stroke protection, crop phase and source-reopen cases. Verify mixed-layer
selection and appearance edits through save, reopen, undo and redo. The isolated
renderer QA executes real Canvas checks without reading the user library.

Check OCR action placement in all seven languages and at narrow widths, and
exercise local success/failure plus remote consent without provider requests.
Signed-app and platform acceptance evidence remain separate from renderer tests.
